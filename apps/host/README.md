# Go Host

独立本机后台服务，已提供持久身份、单实例、握手、启停管理、常驻自动化调度、GitHub Issues / PR，
以及工作空间与画布的业务表面。公开 HTTP 为健康检查、Protobuf Hello 和已认证会话下的身份、自动化、
GitHub 与画布方法；画布的写入方由 `write_ownership` 记录决定，默认仍是 Rust Runtime，
终端、文件、Git 与 Hook 的执行始终在 Runtime。
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
| `--serve-web`        | start/serve 使用，托管的前端构建目录；需要 TLS 与 `--public-origin`                                     |
| `--external-service` | start/serve 使用，`on` / `off` 开关对外服务；省略则沿用已保存的设置                                     |
| `--external-address` | start/serve 使用，对外服务监听的接口 IP；填非回环地址本身即为「允许局域网」的确认                       |
| `--worker-binary`    | start/serve 使用，执行计划命令的 Rust Worker 绝对路径；与下一项必须成对                                 |
| `--worker-state-dir` | start/serve 使用，Worker 私有执行日志目录（0700），缺失时创建                                           |
| `--output protobuf`  | 管理命令返回单个 `HostManagementResult`，无尾随换行；默认 JSON 供人阅读                                 |

`--listen none` 且没有 TLS 参数时不建 TCP 监听，也不接受 `--allow-origin`；`HostStatus.httpEndpoint` 为空串表示「没有 HTTP 面」。
`--listen none` 配上 TLS 与 `--public-origin` 是「只服务其它设备」的形态：在对外服务打开之前不监听任何端口。
启动后把本次地址写入 `<endpoints-dir>/endpoints.json`（0600，只改 `host` 段），正常退出时撤回；写不进去只告警不中止。

管理 IPC 始终传 Protobuf；PID 仅为诊断信息。停止没有可信 ACK 时报告结果不确定，不自动重发。
启动诊断写入本次新建的 `startup-*.log`；并发启动会回收本次多余子进程，防止迟到启动。
`start` 起的进程不由系统服务管理器托管，不承诺跨注销、重启或断电保活；需要常驻见[服务器模式](#服务器模式)，
其定义文件仍由运维自行注册。前台 Ctrl+C/SIGTERM 有界退出并释放锁。

## 前端托管与 Runtime 代理（H02）

`--serve-web` 在 HTTPS 来源上提供前端构建产物：应用外壳同时就是配对页，因此它与 `assets/` 下的
哈希产物是未配对设备唯一够得到的东西；深链接回落到 `index.html`，但**缺失的哈希资源仍是 404**，
免得过期客户端把 HTML 当 JavaScript 执行。整棵目录通过 `os.Root` 打开，包内的符号链接跳不出去。

`/api` 前缀下的请求与 WebSocket 转发给 `endpoints.json` 里 Runtime 自己发布的地址（socket、
命名管道或回环 TCP；非回环的 TCP 地址一律拒绝）。每个请求先认证设备，再按它自己的授权检查：
按路径里的工作空间收窄，并区分读 / 写 / 执行——执行类额外要求 `terminal:write`。设备的 Cookie、
CSRF 与浏览器 Origin 停在 Host，Runtime 只看到本机回环来源。未认证时 `/api` 返回 401，
路由表里没有的 `/api` 路径返回 404 而不是继承最近的前缀。

对外服务开关持久化在数据目录的 `external-service.json`，由 `GET`/`PUT /host/external-service`
读写（`settings:read` / `settings:write`，写需要会话 CSRF）。它是本机管理路由、不是跨端业务契约，
所以是一份小 JSON 文档。通配地址一律拒绝，非回环地址需要显式的局域网确认，端口必须是
`--public-origin` 里的那个——证书与 Cookie 都绑在它上面。

## HTTP 与身份

- `GET /health` 返回 `ok`；`POST /rpc/armadra.v1.HostService/Hello` 收发 `application/x-protobuf`。
- Hello 需 clientId、major 1；当前 minor 1，兼容 0。返回持久 hostId、每次启动变化的 hostInstanceId、能力与 1 MiB 帧上限。
- 已实现能力为 `protocol.hello.v1` / `host.identity.v1`，配置了 Worker 的 HTTPS Host 另有 `automation.plans.v1`，装配了凭据服务的另有 `github.issues.v1`，装配了画布服务的另有 `canvas.documents.v1`（只表示表面可用，不表示本 Host 当前持有画布写入权——那由 `CanvasService/GetOwnership` 回答）。身份 ID 不是认证 token；畸形请求、超限、主版本不兼容及非回环 authority 均拒绝。
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

## GitHub

`/rpc/armadra.v1.GithubService/` 提供仓库解析、Issue 列表 / 详情 / 新建 / 编辑 / 开关 / 评论、
状态映射读写与 `Move to…`、PR 列表 / 详情 / 新建 / 评审 / 检查 / 合并，以及关联 Issue/PR 与
会话、分支、worktree 的 `ExternalReference`。读取需 `github:read`，改动需 `github:write` 并带 CSRF；
更换凭据来源另需 `settings:write`。没有配置凭据时先认证再返回 `UNSUPPORTED`，不返回空列表。

API 凭据由 Host 凭据服务持有，与 Worker 的 SSH key / git credential helper 无关。两种来源都要显式开启：
复用本机 `gh` 登录只按需读取、不落库；粘贴的 token 存 macOS Keychain，其他平台降级为 0600 文件并如实标注。
token 不写入数据库、日志与任何返回的消息。配置先验证再存储；撤销同时清掉密钥、内存副本与客户端。

远端 URL 在本地判定归属，企业仓库不会被发到公共服务。列表响应不带正文——一百条正文放不进一帧，
截断的正文比没有更糟——详情请求返回完整内容。本机 Host 没有 webhook，每个列表/详情响应给出
`poll_interval_ms`，由客户端按此轮询。

| 环境变量          | 作用                                                 |
| ----------------- | ---------------------------------------------------- |
| `GITHUB_API_BASE` | 首次配置的默认 API base；已配置后以存储值为准        |
| `GITHUB_CA_FILE`  | Enterprise API base 的受信根 PEM，替代系统根而非叠加 |

## 服务器模式

以固定系统账号常驻运行时使用 `install` / `uninstall` / `status` / `logs` / `upgrade`（roadmap §3.12）。

```sh
target/armadra-host install --data-dir /srv/armadra --service-dir /etc/armadra \
  --run-as armadra --listen 127.0.0.1:43121
target/armadra-host status --data-dir /srv/armadra
target/armadra-host logs --data-dir /srv/armadra --lines 200
target/armadra-host upgrade --data-dir /srv/armadra --binary /opt/armadra/armadra-host.new
target/armadra-host uninstall --data-dir /srv/armadra
```

| 子命令      | 行为                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `install`   | 只生成定义文件：macOS launchd plist、Linux systemd unit、Windows `sc.exe` 脚本；不注册、不启用、不启动 |
| `uninstall` | 只删除本命令生成的那一个文件；文件缺失或不是本命令生成即拒绝，不停止服务、不注销注册                   |
| `status`    | 在原有输出上追加服务定义信息（见下）                                                                   |
| `logs`      | 读取诊断日志尾部，`--lines` 默认 200、上限 5000，只读文件末尾                                          |
| `upgrade`   | 校验候选二进制后原地替换，`--confirm` 才真正执行                                                       |
| `version`   | 打印 `{component, protocolMajor, protocolMinor}`；不开数据目录、不加锁，供 `upgrade` 校验候选身份      |

`install` 必须显式给出 `--service-dir`（绝对目录）与 `--run-as`（账号不从当前用户推断），
拒绝 root / SYSTEM 等特权账号；`--target-platform` 可生成另一平台的格式。定义内容由输入唯一决定
（相同输入字节一致），目录按 0700 创建、文件 0644 原子写入。ExecStart / ProgramArguments 与
`start` 派生子进程使用同一组 `serve` 参数（含 `--worker-binary` / `--worker-state-dir`）。
定义中不写任何 token、口令或配对材料：`--env` 只接受 NAME=VALUE，名字含 TOKEN / SECRET /
PASSWORD / CREDENTIAL / API_KEY / SESSION 的一律拒绝而不是静默丢弃。systemd 侧启用
`NoNewPrivileges`、`ProtectSystem=full`、内核与 cgroup 保护并按 `ReadWritePaths` 放行数据目录；
不设 `ProtectHome` / `ProtectSystem=strict`，因为 Worker 要读写属主自己的工作空间。
Windows 只产出脚本文件并在输出中明说没有安装任何东西，账号口令交由 `sc.exe` 自行索取。
`--updates-source` 不写进定义文件（其 URL 可能带凭据），需要时自行加到已安装的单元里。

install 把本次输入记录到数据目录的 `service-definition.json`（0600，不含凭据），供其余命令定位。
`status` 在存在该记录时（仅 JSON）追加 `service` 段：定义路径、运行账号、文件是否仍与本二进制
生成结果一致；不一致只报告不修复。没有记录时以及 `--output protobuf` 时输出形状完全不变。

`logs` 默认读服务定义指向的日志，其次是最新的 `startup-*.log`，也可用 `--log-file` 指定；
默认纯文本，`--output json` 返回 `{path, lines}`。**内容原样输出，不做启发式脱敏**：这些文件只有
Host 自身诊断（配对材料仅由 `pair` 命令自己的 stdout 返回），指向其他文件时由运维自行确认。

`upgrade` 先做只读校验：`--binary` 为绝对路径、普通文件、非符号链接、有执行位、非组/其他可写、
属主为当前用户或 root；再在有界子进程里运行候选的 `version`，协议主版本与本二进制不同即拒绝。
任一校验失败都不动现有文件。不带 `--confirm` 时只打印将要发生的事并以 0 退出。确认后先经控制
协议停止运行中的 Host（不杀 PID），再把候选写到目标旁边并改名替换（失败回滚），最后按记录的服务
定义重新启动并报告状态；若服务管理器已自行拉起则报告该实例而不是再起一个。Host 正在运行但没有
安装记录时直接拒绝，避免用猜出来的参数改变监听面——先 `stop` 再 `upgrade`。

## 画布与写入所有权

`/rpc/armadra.v1.CanvasService/` 提供工作空间与画布的读写：`ListWorkspaces` / `PutWorkspace` /
`DeleteWorkspace`、`ListCanvases`、`GetDocument` / `SaveDocument` / `DeleteCanvas`、
`SubscribeEvents` / `GetSnapshot`、`GetOwnership`。读取需 `canvas:read`，变更需 `canvas:write` 并带 CSRF；
每个请求的工作空间取自会话本身的授权，请求里的 scope 只用来选，不用来声明身份。
没有装配画布服务时先认证再返回 `UNSUPPORTED`，不返回空工作空间。

一次 `SaveDocument` 就是整篇文档的一次事务：画布行、节点、连线、标注一起写，请求里没有的对象被删成
带 revision 的墓碑。只有真正变化的对象进入事务，因此移动一个节点不会把整块画布重播一遍。每个对象携带
客户端读到的 revision，冲突返回 CONFLICT 而不是覆盖；`operationId` 是幂等键，重放返回原收据，换了内容则拒绝。
事件与实体同事务写出并按单调 sequence 编号；游标低于保留下限返回 `SNAPSHOT_REQUIRED`，高于水位返回
`CURSOR_AHEAD`，两者都不用空页表示。

写入方由 `write_ownership` 单行记录决定，默认是 Rust Runtime，此时本服务只读，所有变更返回稳定错误码
`ownership_moved`。切换是操作者在维护窗口里的动作，只有 CLI 入口，而且要先停掉运行中的 Host（命令要拿同一把目录锁）：

```sh
target/armadra-host ownership status
target/armadra-host ownership switch  --import-id ID \
  --runtime-binary /abs/armadra-runtime --runtime-database /abs/canvas.db
target/armadra-host ownership rollback --export /abs/new-directory \
  --runtime-binary /abs/armadra-runtime --runtime-database /abs/canvas.db
```

`switch` 先把 `armadra-host import` staging 的行投影成画布实体，再与导出清单和原始行两侧逐项核验
（ID、位置与尺寸、Frame 嵌套、上下文链接、白板摘要、标注、受管资产哈希）；有任何差异就打印报告并中止，
此时尚未改动任何所有权状态。核验通过后经 Worker stdio 协议下发 epoch。应答丢失时会重新读取 Runtime
实际存了什么并据此收敛；两次读取都失败时维护窗口保持打开（两侧继续拒绝写入），重跑同一条命令即可收敛。

`rollback` 必须先写出反向导出包（`--export` 指向一个新目录），写完再读回校验摘要。把该包重新导入
`canvas.db` 尚未实现，因此 Host 在持有期间产生过画布事件时回滚会被拒绝，除非显式加 `--accept-export-only`。

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
