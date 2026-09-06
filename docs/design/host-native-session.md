# 桌面壳的原生 Host 会话

> 状态：已实施。本文描述打包桌面壳（Tauri，页面来源 `tauri://localhost` / `http(s)://tauri.localhost`）如何在不削弱浏览器安全模型的前提下使用需要 Host 身份会话的功能（GitHub、自动化、经 Host 的设置、更新，以及六个业务域的 Host 客户端）。
> 范围：Go Host 的身份/传输层、`@armadra/host-client` 的原生传输、`apps/web/src/host/` 的共用判定、桌面壳的取票命令与冒烟脚本。浏览器与手机端的 HTTPS 认证流程、真实 TLS 证书、多用户都不在范围内。

## 1. 问题

打包桌面壳启动并发现本机 Go Host 后，前端所有需要 Host 会话的功能都被「必须 HTTPS 且与页面同源」的判定挡住。这条判定对**浏览器**是对的（[Host 设备认证](../guides/host-device-auth.md)：Tauri 与自定义来源不能凭 `--allow-origin` 自动登录），但打包版里 Host 二进制就在包内、与桌面壳同一系统账号运行，结果是这些功能在桌面版全部不可用。

## 2. 信任根

桌面壳与 Host 同属一个 OS 用户，两者之间已经有一条 **OS 私有控制通道**（localipc：同用户 socket / 命名管道），`armadra-host pair` 与 `ownership window` 都经它签发一次性票据。原生会话复用这条通道作为唯一信任根：

- 桌面壳用 `armadra-host pair --origin <原生来源> --device-name <本机桌面> --output protobuf` 取得一张票据；票据绑定 `hostId`、`hostInstanceId`、来源与设备名，两分钟有效、只能消费一次，语义与浏览器票据完全相同（同一张表、同一段消费代码）。
- Host 只在「回环 HTTP（没有 `--public-origin`、没有 TLS）+ 该原生来源在 `--allow-origin` 里 + 请求 `Origin` 就是该原生来源」时对它签发票据、接受配对与会话请求。`--public-origin` 的 HTTPS Host、非回环地址、浏览器来源一律维持现状（拒绝）。
- 浏览器页面无法伪造 `Origin: tauri://localhost`；能伪造它的本机进程（curl）要拿到票据仍必须走同用户控制通道，与今天 `pair` 的信任边界一致。

## 3. 传输

自定义 scheme 下 Cookie 不可靠，原生会话改用 **Bearer**：

| 项      | 浏览器会话（不变）                       | 原生会话                                                                                      |
| ------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| 前提    | HTTPS `--public-origin` 且页面同源       | 回环 HTTP、`Origin` ∈ 原生来源且被 `--allow-origin` 允许                                      |
| access  | `__Host-armadra_<host>_access` Cookie    | `Authorization: Bearer <access>`（除 Refresh / RenewCsrf / Logout 外的所有已认证请求）        |
| refresh | `__Host-armadra_<host>_refresh` Cookie   | `Authorization: Bearer <refresh>`（仅 Refresh / RenewCsrf / Logout）                          |
| CSRF    | 内存持有，`X-Armadra-CSRF`               | 同左；Host 侧逻辑不变                                                                         |
| 签发    | `Set-Cookie`                             | `AuthenticatedSession.native`（`NativeSessionCredentials`，仅 Pair / Refresh 的原生响应设置） |
| 持有    | 浏览器 Cookie 存储                       | 页面内存（`HostNativeCredentials`），不落 localStorage / URL / 日志                           |
| CORS    | `Access-Control-Allow-Credentials: true` | 不设；预检额外允许 `Authorization` 头                                                         |
| 能力名  | `identity.browser-session.v1`            | `identity.native-session.v1`（Hello 只对被允许的原生来源、且 Host 处于回环 HTTP 形态时报告）  |

撤销、绝对期限（30 天）、access 期限（15 分钟）、refresh 轮转、设备 revision 核对全部复用现有 `identity_sessions` / `identity_devices` 表与 `identity.Service`，Host 侧没有新表、没有新迁移。会话的 `origin` 列记录原生来源，因此浏览器来源的请求即使拿到 bearer 也过不了 `liveSession` 的来源核对。

`/api` 代理、事件流 WebSocket、对外服务开关仍只在 HTTPS 形态开放：桌面壳直接经 `armadra://` 连本机 Runtime，不需要 Host 代理；`runtime.proxy.v1` 与 `events.stream.v1` 不对原生来源报告。

## 4. 各层职责

### 4.1 Go Host

- `internal/server/native.go`：原生来源集合、`nativeSession(r, origin, explicit, options)` 判定、`Authorization: Bearer` 解析（恰好一个头、`Bearer ` 前缀）。
- `handler.go`：已认证方法的闸门在原生判定成立时放行；预检允许 `authorization`；Hello 按上表报告能力，业务面能力（automation / github / canvas / settings / filesystem / git / session / agent / ownership / updates）对原生会话与 HTTPS 一视同仁。
- `auth.go`：`credential()` 在原生请求上读 bearer 而不是 Cookie；Pair / Refresh 的原生响应把 access / refresh 放进 `AuthenticatedSession.native`，不写 Cookie。
- `cmd/armadra-host/serve.go`：控制通道的 `Bootstrap` 在回环 HTTP 形态下对被允许的原生来源签发票据；HTTPS 形态仍只认 `--public-origin`。
- `proto/armadra/v1/identity.proto`：新增 `NativeSessionCredentials` 与 `AuthenticatedSession.native = 6`；浏览器响应永不设置。

### 4.2 `@armadra/host-client`

- `HostNativeCredentials`：一份页面级的内存凭据（access / refresh / CSRF / access 到期），带跨客户端的串行队列与「取票据」回调。多个 `HostIdentityClient` 共用同一份，轮转不会互相作废。
- `HostIdentityClient` 新增 `transport: { kind: "native", credentials }`：只允许「回环 HTTP 基址 + 原生页面来源」；`fetch` 用 `credentials: "omit"` 并带 bearer；`resume()` 在没有凭据或凭据失效时经回调取票并配对；access 临期时先刷新再发请求；一次 `UNAUTHENTICATED` 后刷新重试一次。浏览器传输的每条规则不变，测试钉死：HTTP 基址、Tauri 页面来源在浏览器传输下仍然拒绝，原生传输下非回环 / HTTPS / 浏览器页面来源也拒绝。

### 4.3 Web（`apps/web/src/host/native-session.ts`）

- `hostSessionBlock(address)`：九处 `addressBlock()` 共用的判定——壳内（`isTauri()` 且页面来源 ∈ 原生来源）接受回环 HTTP 地址，其余沿用「HTTPS 且同源」。
- `hasHostSessionCapability(hello)`、`createHostIdentity(options)`：按环境选能力名与传输；壳内自动用 `HostNativeCredentials` 单例，票据经 Tauri 命令 `host_native_ticket` 取得，不需要用户配置地址。
- `HostNativeSessionError`：壳侧失败原因（`hostUnavailable` / `originUnsupported` / `cliFailed` / `timeout` / `malformed` / `shellUnavailable`），映射到 `hostNative.blocked.*` 文案；GitHub / 自动化 / 更新面板显示 `*.blocked.nativeSession` 并指向「设置 → 连接」，设备登录面板显示具体原因。

### 4.4 桌面壳

- 打包壳以 `--listen 127.0.0.1:43121 --allow-origin <原生来源>` 启动 Host（与开发形态相同），不再用 `--listen none`：原生会话走回环 HTTP，页面的 CSP `connect-src` 放行 `http://127.0.0.1:43121`。壳因此多持有一个回环端口（此前只有 WebSocket 转发端口）。
- `host/native.rs`：`issue_native_ticket()` 复用 `launch.rs` 的子进程模式运行 `pair`，stdout 上限 64 KiB、stderr 不保留、限时 15 秒；核对票据的 `hostId` / `hostInstanceId` 与本次 `ensure_host` 观察到的一致、来源与壳配置一致、未过期。
- `native_session.rs`：唯一暴露给页面的命令 `host_native_ticket`，只读，返回 `{ hostId, hostInstanceId, origin, ticket, expiresAtUnixMs }`；不暴露进程、路径或标志。命令与 Host 启停串行（同一把 `host_operation` 锁），退出中或 Host 未就绪时报 `hostUnavailable`。

### 4.5 更新路径：替换旧壳留下的无端口 Host

`armadra-host start` 只回答「谁已经持有这个数据目录」，不核对配置。旧的打包版用 `--listen none` 启动 Host，用户装新版本后（旧 Host 可能仍在后台），新壳的 `start` 会遇到那个没有端口的实例，页面永远拿不到会话。桌面壳在 `EndpointMismatch` 且对方**没有任何端口**时把它视为自己上一版留下的（只有桌面壳启动过无端口的 Host），发一次 `stop` 再 `start`；任何其他不一致（别的端口）仍然报错不动，那不是这个壳该停的进程。

## 5. 验证

- Go：`internal/server/native_test.go`（原生来源 + bearer 成功、浏览器来源同票据拒绝、票据二次使用拒绝、HTTPS 形态拒绝原生、bearer 不能用于 Cookie 形态、预检）、`cmd/armadra-host/pair_test.go`（回环 Host 对被允许的原生来源出票、对浏览器来源仍拒绝）。
- host-client：`test/native.test.ts`（组合矩阵、bearer 与 `credentials: "omit"`、共用凭据的串行、临期刷新、重试、注销清空）。
- Web：`host/native-session.test.ts`、更新的 `HostIdentityPanel.test.tsx`。
- 桌面：`cargo test -p armadra-desktop`（参数、票据解析、假 CLI 的有界输出与不回显）。
- `pnpm host:native-session-smoke`：真实 Go Host + 用 CLI 代替桌面壳的取票流程——原生来源 + 票据 → 会话 → `ListDevices`（需 `identity:read`）成功；浏览器来源 + 同一票据 → 拒绝；票据二次使用 → 拒绝；无 bearer 的原生请求 → 401。

## 6. 未做与后续

- 每次启动桌面壳都新建一台「本机桌面」设备（refresh 只在页面内存里）；后续可让壳持有 refresh 或由 Host 合并同名原生设备。
- Host 端口固定为 43121：换成内核分配端口需要前端异步发现地址，九个模块目前同步读取地址。
- 事件流 WebSocket 与 `/api` 代理不走原生会话；桌面壳有自己的 Runtime 通道。
