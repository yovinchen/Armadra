# Armadra Host（M0）

独立 Go 进程的本机协议协商入口。当前只实现健康检查和 Protobuf Hello；现有 Rust Runtime 仍负责应用业务，没有切换数据库、启动自动化或开放设备远程访问。

## 运行

在仓库根目录生成协议并启动：

```sh
pnpm protocol:generate
go -C apps/host run ./cmd/armadra-host --listen 127.0.0.1:43121
```

使用 `--listen 127.0.0.1:0` 可分配临时端口。仅接受显式回环 IP，拒绝通配地址和远程监听。默认端口与现有 Runtime 的 43120 不同。

- `GET /health` 返回 `ok`。
- `POST /rpc/armadra.v1.HostService/Hello` 接受和返回 `application/x-protobuf`；消息来自 `proto/armadra/v1/common.proto`。
- 客户端需要传 clientId 及 protocol.major=1；minor 协商为双方支持范围，本轮为 0。
- 返回 process-local hostInstanceId、`protocol.hello.v1` 能力及 1 MiB 帧上限。该 ID 不表示认证身份。
- 格式错误、超大载荷、跨源访问、非回环 authority 和不兼容主版本均返回明确错误。

进程独立于请求连接，所有客户端断开后仍服务；Ctrl+C/SIGTERM 触发有界退出。此阶段没有 OS 后台服务安装、持久 Host ID、设备认证或业务执行接口，不能用它替代完整常驻服务。

## 验证

```sh
go -C apps/host test -race ./...
go -C apps/host vet ./...
pnpm host:smoke
```

正式构建建议把输出指定到仓库 `target/` 或临时目录，不将二进制加入版本控制。协议生成与跨语言验证见仓库 `proto/README.md`。

`host:smoke` 自动编译临时 Go Host 和 Rust 编解码桥，使用真实 HTTP 完成 TS → Rust → Go Host → Rust → TS 握手，并检查版本不兼容和畸形请求。测试结束关闭临时 Host、删除临时二进制，Go 缓存默认放在忽略的 `target/protocol-go/`。
