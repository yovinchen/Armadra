# TypeScript HostClient

`@armadra/host-client` 提供无框架依赖的 Protobuf Host 握手客户端，供画布、桌面页面、移动页面或 Node 工具共用。当前只实现 `hello()`，不会调用业务操作、自动重试或推断服务器未声明的功能。

```ts
import { HostClient, HostClientError } from "@armadra/host-client";

const client = new HostClient({
  baseUrl: "http://127.0.0.1:8080",
  clientId: "canvas-device-1",
  timeoutMs: 10_000,
});

try {
  const hello = await client.hello();
  const supported = hello.capabilities.includes("protocol.hello.v1");
  console.log(hello.hostId, hello.hostInstanceId, supported);
} catch (error) {
  if (error instanceof HostClientError) {
    console.log(error.code, error.retryable, error.httpStatus, error.hostCode);
  }
}
```

`hello({ signal })` 接受调用方的 AbortSignal。构造时可传入 `fetch: typeof fetch`，用于宿主适配和测试。请求和响应直接使用 `@armadra/protocol` 生成的 schema，返回值及导出的 `HelloResponse` 类型也来自该包；没有手写第二套消息定义。

## URL 与协议约束

- `baseUrl` 必须为绝对地址；HTTPS 允许远端，HTTP 仅允许 localhost、IPv4 127/8 和 IPv6 `::1`。
- 拒绝用户名、密码、query 和 fragment。错误不会包含 URL、服务端原文或底层异常。
- `https://host.example/proxy/armadra/` 会请求 `/proxy/armadra/rpc/armadra.v1.HostService/Hello`，保留反向代理路径前缀。
- 请求使用 Protobuf Content-Type / Accept、`credentials: same-origin`、`redirect: error` 和 `cache: no-store`。禁止自动重定向，避免协议或目标主机在校验后改变。
- `clientId` 必须非空白，UTF-8 编码不超过 256 字节。默认超时 10 秒；允许有限正数，最大为浏览器定时器的 32 位有符号上限。
- 版本读取共享协议常量。主版本不同，或服务端返回比客户端请求更高的 minor 时拒绝协商。minor 0 可以没有 `hostId`，minor 1 及以后必须提供。`hostInstanceId` 和非零 `maxFrameBytes` 必须存在。
- `capabilities` 保留服务端原值。空列表就是没有已声明能力，不补终端、调度、Git 或远端设备权限。

浏览器仍须满足宿主 CORS、TLS 和身份认证配置；本包不提供远端登录、凭据存储、Worker 接入或多人权限实现。跨源 Cookie 不会自动携带。

## 错误与取消

`HostClientError` 只包含稳定分类：`code`、`retryable`、可选 `httpStatus` 和可选 `hostCode`。不保留原始响应、远端错误 message、认证信息或原始 `cause`。未知远端错误码归为 `UNKNOWN`。

| code                    | 含义                                | retryable                              |
| ----------------------- | ----------------------------------- | -------------------------------------- |
| INVALID_OPTIONS         | 地址、客户端标识或超时设置无效      | false                                  |
| NETWORK_ERROR           | fetch 或响应流失败                  | true                                   |
| CANCELLED               | 调用方取消                          | false                                  |
| TIMEOUT                 | 请求或响应体读取超过总时限          | true                                   |
| HTTP_ERROR              | HTTP 失败且响应不是 Protobuf        | 仅 408、429、502、503、504             |
| UNEXPECTED_CONTENT_TYPE | 成功响应却不是 Protobuf             | false                                  |
| RESPONSE_TOO_LARGE      | 响应声明长度或实际流超过 1 MiB      | false                                  |
| MALFORMED_RESPONSE      | 二进制损坏或必需字段缺失            | false                                  |
| INCOMPATIBLE_PROTOCOL   | 主版本不同或协商 minor 高于请求版本 | false                                  |
| REMOTE_ERROR            | Protobuf 错误响应                   | 仅已知暂时性错误及上述暂时性 HTTP 状态 |

`retryable` 仅说明这次只读握手是否适合由调用方稍后重试，本包不会重试。这个判断不能复用于提交、终端输入等有副作用操作。

超时覆盖 fetch 和完整响应体读取。客户端逐块读取，实际累计大小始终不超过本地 1 MiB 上限；Content-Length 只作提前拒绝依据，即使虚报较小值也不绕过检查。服务端声明更大的帧预算不会提高本客户端的接收上限。超限、取消和超时会取消响应流；对于不遵守 AbortSignal 的注入 transport，也能结束等待，不让底层永不完成的 cancel Promise 拖住调用方。

## 验证

```sh
pnpm --filter @armadra/protocol build
pnpm --filter @armadra/host-client test
pnpm --filter @armadra/host-client typecheck
pnpm --filter @armadra/host-client build
```

单测使用真实 `Response` / `ReadableStream`，覆盖二进制往返、代理前缀、输入校验、协议版本及能力缺省、正好 1 MiB 与超限、伪造 Content-Length、碎片和零长度 chunk、读取失败、敏感错误清理、fetch/body 阶段取消和超时，以及超时后才到达的响应流清理。实际 Go Host 的端到端测试由仓库 `host:smoke` 入口集成；这里的单测不等同于浏览器、移动设备或 Windows 实机验收。

API 行为依据：[Fetch 凭据及响应处理](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)、[Streams 读取与取消](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams)。
