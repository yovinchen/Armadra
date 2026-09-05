# Go Host

独立本机后台服务，已提供持久身份、单实例、握手与启停管理。公开 HTTP 仅有健康检查和 Protobuf Hello；
当前业务仍由 Rust Runtime 执行。迁移进度见[实施记录](../../docs/platform-implementation-status.md)。

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

| 参数                | 作用                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `--data-dir`        | 各命令共用的独立目录，默认每用户 Armadra/host，Windows 优先 LOCALAPPDATA   |
| `--listen`          | start/serve 使用，默认 `127.0.0.1:43121`；`:0` 分配临时端口，仅显式回环 IP |
| `--allow-origin`    | start/serve 使用，可重复的精确页面来源                                     |
| `--output protobuf` | 管理命令返回单个 `HostManagementResult`，无尾随换行；默认 JSON 供人阅读    |

管理 IPC 始终传 Protobuf；PID 仅为诊断信息。停止没有可信 ACK 时报告结果不确定，不自动重发。
启动诊断写入本次新建的 `startup-*.log`；并发启动会回收本次多余子进程，防止迟到启动。
此服务不由系统服务管理器托管，不承诺跨注销、重启或断电保活。前台 Ctrl+C/SIGTERM 有界退出并释放锁。

## HTTP 与身份

- `GET /health` 返回 `ok`；`POST /rpc/armadra.v1.HostService/Hello` 收发 `application/x-protobuf`。
- Hello 需 clientId、major 1；当前 minor 1，兼容 0。返回持久 hostId、每次启动变化的 hostInstanceId、能力与 1 MiB 帧上限。
- 已实现能力为 `protocol.hello.v1` / `host.identity.v1`。身份 ID 不是认证 token；畸形请求、超限、主版本不兼容及非回环 authority 均拒绝。
- 数据目录使用 OS 文件锁。身份损坏、未知版本或非普通文件时拒绝启动，不重建；不要在运行时删除锁或复制目录冒充新设备。
- Unix 新目录/文件使用 0700/0600；Windows 沿用目录 ACL，自定义数据目录的凭据与业务数据隔离仍待实机验收。此阶段身份元数据不含凭据。

## Origin 与权限

默认接受同源或无 Origin 的本机 CLI 请求；跨源页面须明确配置。主机与端口精确匹配，
`localhost` 与 `127.0.0.1` 不等同。HTTPS 可配置；普通 HTTP 仅回环主机，桌面额外允许精确的
`tauri://localhost`、`https://tauri.localhost`、`http://tauri.localhost`。

拒绝通配、null、凭据、路径（含末尾 `/`）、query/hash 与控制字符；错误配置在监听和创建数据目录前失败。
配置规范化 scheme/主机大小写与默认端口，收到的 Origin 必须符合标准序列化。

CORS 只覆盖两个只读元数据接口，返回精确 Allow-Origin 与 Vary，不启用 Allow-Credentials。
OPTIONS 仅接受对应方法和 content-type/accept；`Sec-Fetch-Site: cross-site` 必须有明确许可。
这不授予设备认证、终端、文件、Git、自动化或私有管理权限。

本机管理走[同用户 IPC](internal/localipc/README.md)与[控制协议](internal/daemon/README.md)，不注册到 HTTP/CORS。

## 验证

```sh
go -C apps/host test -race ./...
go -C apps/host vet ./...
pnpm host:smoke
pnpm host:lifecycle-smoke
```

smoke 使用临时 Host / 数据目录，验证 TS → Rust → Go 的真实握手、重启身份、并发启动拒绝与畸形请求；
lifecycle-smoke 覆盖后台保活、status/start/stop、HTTP 排空与损坏配置。结束时通过控制协议停止服务。
客户端见[HostClient](../../packages/host-client/README.md)，生成契约见[proto](../../proto/README.md)。
Windows 交叉构建不等同于后台进程、系统调用或安装包的实机验收。
