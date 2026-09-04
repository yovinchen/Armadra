# Armadra Host（M1 基础）

独立 Go 进程的本机协议协商入口，包含持久 Host 身份和每数据目录单实例保护。当前业务入口仍只有健康检查和 Protobuf Hello；现有 Rust Runtime 仍负责应用业务，没有切换数据库、启动自动化或开放设备远程访问。

## 运行

在仓库根目录生成协议并启动：

```sh
pnpm protocol:generate
go -C apps/host run ./cmd/armadra-host --listen 127.0.0.1:43121
```

使用 `--listen 127.0.0.1:0` 可分配临时端口。仅接受显式回环 IP，拒绝通配地址和远程监听。默认端口与现有 Runtime 的 43120 不同。`--data-dir /path/to/host-state` 指定独立数据目录；默认使用每用户的 Armadra/host，Windows 优先 LOCALAPPDATA。

- `GET /health` 返回 `ok`。
- `POST /rpc/armadra.v1.HostService/Hello` 接受和返回 `application/x-protobuf`；消息来自 `proto/armadra/v1/common.proto`。
- 客户端需要传 clientId 及 protocol.major=1；minor 协商为双方支持范围，本轮为 1，兼容 minor 0。
- 返回持久 hostId、process-local hostInstanceId、`protocol.hello.v1` / `host.identity.v1` 能力及 1 MiB 帧上限。两个 ID 都不是认证凭据。
- 格式错误、超大载荷、未允许的跨源访问、非回环 authority 和不兼容主版本均返回明确错误。

数据目录使用操作系统文件锁，第二个 Host 即使选择不同端口也会拒绝启动；进程结束后锁由系统释放，保留锁文件不代表仍有进程。身份文件损坏、未知版本或非普通文件时启动失败，不自动重建身份。不要在进程运行时删除锁文件或复制数据目录作为新设备身份。

Unix 新目录/文件使用 0700/0600。Windows 沿用目录 ACL，POSIX mode 不等同于私有 DACL；自定义数据目录的 Windows 凭据/业务数据权限隔离仍待专门实现与实机验收。此阶段只保存公开身份元数据，不存凭据。

进程独立于请求连接，所有客户端断开后仍服务；Ctrl+C/SIGTERM 触发有界退出并释放文件锁。此阶段没有 OS 后台服务安装、设备认证或业务执行接口，不能用它替代完整常驻服务。

## 显式浏览器 Origin

默认只接受同源或无 Origin 的本机 CLI 请求。独立前端开发端口需要逐个配置精确 Origin：

```sh
go -C apps/host run ./cmd/armadra-host --listen 127.0.0.1:43121 \
  --allow-origin http://localhost:1420 \
  --allow-origin http://127.0.0.1:1442
```

`--allow-origin` 可重复，端口和主机均精确匹配；`localhost` 与 `127.0.0.1` 是不同 Origin。配置会规范化 scheme/主机大小写和默认端口，收到的 Origin 必须符合标准序列化形式。HTTPS Origin 可显式加入；普通 HTTP 只允许回环主机。Tauri 可按实际平台选择显式加入 `tauri://localhost`、`https://tauri.localhost` 或 `http://tauri.localhost`。最后一项是无自定义端口的精确特例，不允许其他 HTTP DNS 主机或其子域。

通配 `*`、`null`、凭据、路径（包括末尾 `/`）、query/hash 和控制字符均拒绝；配置错误会在创建数据目录或监听前使启动失败。不会解析通配 Origin，也不会从请求 Host 生成跨源许可。

许可仅覆盖 `GET /health` 和 `POST /rpc/armadra.v1.HostService/Hello` 这两个只读元数据入口，响应返回精确 `Access-Control-Allow-Origin` 和 `Vary: Origin`，不启用 `Access-Control-Allow-Credentials`。OPTIONS preflight 只准许对应路由的方法和 `content-type` / `accept` 请求头；未知路由、Origin、方法或 header 均拒绝。未带 Origin 的 CLI 行为不变；`Sec-Fetch-Site: cross-site` 必须具有明确批准的 Origin。

这是本机浏览器读取元数据的 CORS 配置，**不是设备认证或远程开放**。Host authority 和监听地址仍限制回环；不会授予文件、终端、Git 或自动化执行权限，也不提供私有网络访问的额外通配许可。后续真实设备接入必须另行实现配对、认证和授权。

## 验证

```sh
go -C apps/host test -race ./...
go -C apps/host vet ./...
pnpm host:smoke
```

正式构建建议把输出指定到仓库 `target/` 或临时目录，不将二进制加入版本控制。协议生成与跨语言验证见仓库 `proto/README.md`。

`host:smoke` 自动编译临时 Go Host 和 Rust 编解码桥，使用真实 HTTP 完成 TS → Rust → Go Host → Rust → TS 握手，验证重启后持久身份不变、进程身份更新、同目录重复启动拒绝、旧 minor 兼容及畸形请求。测试结束关闭临时 Host、删除临时二进制和数据目录，Go 缓存默认放在忽略的 `target/protocol-go/`。

前端复用的客户端位于 [HostClient](../../packages/host-client/README.md)。冒烟测试会构建该包并在实际 Host 重启前后调用 `hello()`；此阶段尚未替换应用现有 Runtime 客户端或开放跨源设备认证。
