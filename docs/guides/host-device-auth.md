# Host 设备认证

当前实现单个 owner 的多个设备。认证接口使用 Protobuf；业务数据所有权、Worker 和终端转发仍按平台实施记录推进，认证成功本身不表示已经完成远程业务迁移。

## 启动 HTTPS

默认回环 HTTP 只提供本机元数据，不能签发浏览器配对材料或设置认证 Cookie。浏览器认证必须使用明确配置的 HTTPS 来源，客户端正常验证证书链与主机名。Host 不安装 CA、不修改系统信任，也不提供跳过证书验证选项。

以下地址与文件为示例，替换为实际接口 IP、证书路径与客户端访问域名：

```sh
armadra-host start --data-dir /path/to/host-data \
  --listen 192.168.1.20:43121 \
  --tls-cert /path/to/certificate.pem \
  --tls-key /path/to/private-key.pem \
  --public-origin https://armadra.example:43121
```

必须同时提供证书、私钥和 HTTPS 来源。启动前检查证书与私钥匹配、证书有效期及主机名；不接受通配监听地址。私钥应由运行 Host 的系统用户私有保管。证书续期后重启 Host，重新读取证书。

`--allow-origin` 仅扩展元数据读取来源，不授予认证权限。**浏览器 Cookie 会话**要求页面与 `--public-origin` 同源且经 TLS；回环 HTTP 不开放 Cookie 会话，理由不是「明文」而是 Cookie 不按端口隔离：`127.0.0.1:A` 设置的 Cookie 会被发往同一浏览器配置里的任何 `127.0.0.1:B`，也能被它覆盖，`Secure` 与 `__Host-` 前缀都不改变这一点。Tauri、自定义来源或明文开发页面不能因此自动登录。

回环 HTTP 上的例外只有一条，且不是 Cookie：桌面壳的原生 Bearer 会话（见下节）。

## 本机批准设备

在 Host 所属系统账号下运行：

```sh
armadra-host pair --data-dir /path/to/host-data \
  --origin https://armadra.example:43121 --device-name "我的手机"
```

此命令通过 OS 私有控制通道查询 Host，并签发绑定 Host、运行实例、来源和设备名称的一次性票据，输出 JSON；原生调用可使用 `--output protobuf`。票据两分钟有效，只能消费一次。命令显式批准该 owner 的完整权限；内部协议另支持按工作空间和执行主机收窄授权。

将票据交给同源设备登录界面消费。输出不含长期 access/refresh 凭据，不将票据放进 URL、日志、画布或项目文件。更换来源或 Host 实例后需重新申请票据。当前默认 HTTP Host 会直接拒绝此命令，避免签发无法使用的材料。

## 会话与撤销

- HTTPS 响应使用 `Secure`、`HttpOnly`、`SameSite=Strict`、`__Host-` 前缀 Cookie；access 十五分钟有效，会话绝对期限三十天。
- CSRF 只交给同源客户端并绑定会话；刷新原子轮转 access、refresh 和 CSRF，旧值立即失效。丢失内存 CSRF 时可凭仍有效的 refresh Cookie 重新取得 CSRF，不能延长绝对期限。
- 注销验证 refresh 与 CSRF，因此 access 已过期也能撤销当前会话。设备撤销核对确认时的 revision，并使其所有会话在下一次认证时失效。
- 每次认证从数据库核对撤销版本及实际权限；设备名、角色字符串或客户端请求中的 ID 不授予权限。operator/viewer 只预留定义，当前不开放多人授权。
- 刷新或配对的响应丢失可能使凭据结果未知，不能盲目重发；必要时重新配对。实时 WebSocket 撤销断流在流式业务接线时继续实现。

接口前缀为 `/rpc/armadra.v1.IdentityService/`，提供 `Pair`、`Current`、`RenewCsrf`、`Refresh`、`Logout`、`ListDevices`、`RevokeDevice`。全部为有界 Protobuf POST，拒绝错误 Origin、重复认证 Cookie、压缩编码与畸形消息。Hello 仅在 HTTPS 认证实际配置时报告 `identity.browser-session.v1`。

## 桌面壳

打包桌面壳的页面来源满足不了上面的浏览器规则，但它与 Host 同属一个系统账号。两种壳的来源形状不同：Tauri 壳是 `tauri://localhost`（Windows 为 `http(s)://tauri.localhost`），Electron 壳用回环 HTTP 静态服务，来源是 `http://127.0.0.1:<内核分配端口>`。Host 把两者一视同仁地当作**壳来源**：自定义 scheme 的三个 Tauri 拼写，或任意回环 HTTP 来源（`127.0.0.0/8`、`[::1]`、`localhost`，端口不限）。壳因此走一条独立的原生路径（[设计](../design/host-native-session.md)）：

- 壳以 `--listen 127.0.0.1:43121 --allow-origin <原生来源>` 启动 Host，再用 `armadra-host pair --origin <原生来源> --device-name 本机桌面 --output protobuf` 经 OS 私有控制通道取一张票据；票据与浏览器票据同一张表、同样两分钟有效、只能消费一次。回环 HTTP 的 Host 只对被 `--allow-origin` 允许的原生来源出票，对浏览器来源仍然拒绝；HTTPS Host 只认 `--public-origin`。
- 壳来源不是授权：票据只由同用户 OS 控制通道签发。浏览器确实可以打开 Electron 壳的那个回环 HTTP 地址并持有同一个来源，但它拿不到票据，因此换不到会话。允许清单里的端口是这条边界的落点——没写进 `--allow-origin` 的回环来源一律按普通跨源请求拒绝。
- 页面只调用一个只读命令 `host_native_ticket` 取票，再向回环 HTTP 的 `IdentityService/Pair` 换会话。自定义 scheme 下 Cookie 不可靠，原生会话把 access / refresh 放在 `AuthenticatedSession.native` 里返回，页面以 `Authorization: Bearer` 发送（Refresh / RenewCsrf / Logout 带 refresh，其余带 access），CSRF 头不变；凭据只在页面内存，不落 localStorage、URL 或日志。
- Host 只在「回环 HTTP + 请求 `Origin` 是被允许的原生来源」时接受 bearer；预检额外允许 `Authorization`，不设 `Access-Control-Allow-Credentials`。撤销、绝对期限、轮转与 revision 核对复用同一套会话表。Hello 仅对该来源报告 `identity.native-session.v1`，业务面能力随之报告；`/api` 代理与事件流仍只在 HTTPS 形态开放。
- 每次启动壳都会新建一台「本机桌面」设备；`pnpm host:native-session-smoke` 用真实 Host 与 CLI 代替壳的取票流程验证整条链路。

真实 TLS、证书主机名、Cookie 属性、CLI 到 HTTPS 配对及数据库权限边界均有独立临时环境测试；未以这些测试代替移动浏览器、系统证书部署或 Windows 实机验收。
