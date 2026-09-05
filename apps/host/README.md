# Go Host

独立本机后台服务，已提供持久身份、单实例、握手、启停管理与常驻自动化调度。公开 HTTP 为健康检查、
Protobuf Hello 和已认证会话下的身份与自动化方法；其余业务仍由 Rust Runtime 执行。
迁移进度见[实施记录](../../docs/platform-implementation-status.md)。

## 运行与管理

```sh
# 仓库根目录；协议有改动时先运行 pnpm protocol:generate
go -C apps/host run ./cmd/armadra-host --allow-origin http://127.0.0.1:1420

# 后台运行使用固定二进制
mkdir -p target
go -C apps/host build -o ../../target/armadra-host ./cmd/armadra-host
target/armadra-host start --allow-origin http://127.0.0.1:1420
target/armadra-host status
target/armadra-host stop
```

Windows 使用 `armadra-host.exe`。省略子命令等同 `serve`（前台）；`start` 就绪后返回，已有服务则返回当前状态，
更改配置需先 stop 再 start。`status` 不创建目录或身份；锁被占用但 IPC 不可用时报告错误。
`stop` 绑定已观察到的实例 ID，等待 HTTP 排空和目录锁释放，不强杀 PID、不停止独立 Runtime / tmux。

| 参数                 | 作用                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `--data-dir`         | 各命令共用的独立目录，默认每用户 Armadra/host，Windows 优先 LOCALAPPDATA                                |
| `--listen`           | start/serve 使用，默认 `127.0.0.1:43121`；`:0` 分配临时端口，仅显式回环 IP；`none` 只保留同用户控制 IPC |
| `--endpoints-dir`    | start/serve 使用，共享 `endpoints.json` 所在绝对目录，默认数据目录                                      |
| `--allow-origin`     | start/serve 使用，可重复的精确页面来源                                                                  |
| `--worker-binary`    | start/serve 使用，执行计划命令的 Rust Worker 绝对路径；与下一项必须成对                                 |
| `--worker-state-dir` | start/serve 使用，Worker 私有执行日志目录（0700），缺失时创建                                           |
| `--output protobuf`  | 管理命令返回单个 `HostManagementResult`，无尾随换行；默认 JSON 供人阅读                                 |

`--listen none` 时不建 TCP 监听，也不接受 `--allow-origin` 与 TLS 参数；`HostStatus.httpEndpoint` 为空串表示「没有 HTTP 面」。
启动后把本次地址写入 `<endpoints-dir>/endpoints.json`（0600，只改 `host` 段），正常退出时撤回；写不进去只告警不中止。

管理 IPC 始终传 Protobuf；PID 仅为诊断信息。停止没有可信 ACK 时报告结果不确定，不自动重发。
启动诊断写入本次新建的 `startup-*.log`；并发启动会回收本次多余子进程，防止迟到启动。
此服务不由系统服务管理器托管，不承诺跨注销、重启或断电保活。前台 Ctrl+C/SIGTERM 有界退出并释放锁。

## HTTP 与身份

- `GET /health` 返回 `ok`；`POST /rpc/armadra.v1.HostService/Hello` 收发 `application/x-protobuf`。
- Hello 需 clientId、major 1；当前 minor 1，兼容 0。返回持久 hostId、每次启动变化的 hostInstanceId、能力与 1 MiB 帧上限。
- 已实现能力为 `protocol.hello.v1` / `host.identity.v1`，配置了 Worker 的 HTTPS Host 另有 `automation.plans.v1`。身份 ID 不是认证 token；畸形请求、超限、主版本不兼容及非回环 authority 均拒绝。
- 数据目录使用 OS 文件锁。身份损坏、未知版本或非普通文件时拒绝启动，不重建；不要在运行时删除锁或复制目录冒充新设备。
- Unix 新目录/文件使用 0700/0600；Windows 沿用目录 ACL，自定义数据目录的凭据与业务数据隔离仍待实机验收。此阶段身份元数据不含凭据。

## Origin 与权限

默认接受同源或无 Origin 的本机 CLI 请求；跨源页面须明确配置。主机与端口精确匹配，
`localhost` 与 `127.0.0.1` 不等同。HTTPS 可配置；普通 HTTP 仅回环主机，桌面额外允许精确的
`tauri://localhost`、`https://tauri.localhost`、`http://tauri.localhost`。

拒绝通配、null、凭据、路径（含末尾 `/`）、query/hash 与控制字符；错误配置在监听和创建数据目录前失败。
配置规范化 scheme/主机大小写与默认端口，收到的 Origin 必须符合标准序列化。

只读元数据接口的 CORS 返回精确 Allow-Origin 与 Vary，不启用 Allow-Credentials；身份与自动化方法
只在配置的 HTTPS `--public-origin` 上带凭据放行。OPTIONS 仅接受对应方法和 content-type/accept；
`Sec-Fetch-Site: cross-site` 必须有明确许可。元数据接口不授予终端、文件、Git 或私有管理权限。

本机管理走[同用户 IPC](internal/localipc/README.md)与[控制协议](internal/daemon/README.md)，不注册到 HTTP/CORS。

## 自动化调度

同时给出 `--worker-binary` 与 `--worker-state-dir` 才启动调度：Host 拉起 Worker 命令模式，
按自己存储的定义在其上重建命令 root/session 并校验 generation，然后运行常驻调度引擎。
只给一个参数在解析阶段报错；两个都不给时其余功能不变，自动化方法先认证再返回 `UNSUPPORTED`，
不返回空列表。停止顺序为先停调度与 Worker 监督，再关闭 Worker 并确认清理，最后释放数据库与目录锁。

Worker 意外退出按有界次数退避重启（默认 5 次，1s 起、上限 30s，存活满 1 分钟后重置）；
重启只重建定义，不重发派发——去重键仍是稳定 operationId 与 Worker 持久收据。
重建失败的定义记为 `UNREBUILDABLE` 并带原因码，对应计划被明确拒绝而不是无限等待。

`/rpc/armadra.v1.AutomationService/` 下有 `DefineCommandSession`、`ListCommandSessions`、
`Define`、`Activate`、`Pause`、`RunNow`、`ListPlans`、`ListRuns`，与身份接口共用已认证的
HTTPS 会话：读取需 `automation:read`，改动需 `automation:manage` 并带 CSRF，
均按请求 scope 的 workspace 与本机执行主机收窄。身份只来自会话，请求字段不提供身份；
其他 hostId / executionHostId 直接拒绝。计划的 stdin 载荷由 Host 私有存储按内容散列保存，
派发前重新校验散列，并按记录的设备授权（撤销或代次变化即失效）复核。

## 验证

```sh
go -C apps/host test -race ./...
go -C apps/host vet ./...
pnpm host:smoke
pnpm host:lifecycle-smoke
```

设置 `ARMADRA_TEST_REAL_WORKER` 指向已构建的 `armadra-runtime` 后，默认跳过的真实 Worker 用例
会实际调度、杀掉 Worker 验证重建，并检查 Host 停止后无残留进程。
smoke 使用临时 Host / 数据目录，验证 TS → Rust → Go 的真实握手、重启身份、并发启动拒绝与畸形请求；
lifecycle-smoke 覆盖后台保活、status/start/stop、HTTP 排空与损坏配置。结束时通过控制协议停止服务。
客户端见[HostClient](../../packages/host-client/README.md)，生成契约见[proto](../../proto/README.md)。
Windows 交叉构建不等同于后台进程、系统调用或安装包的实机验收。
