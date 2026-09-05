# TypeScript HostClient

`@armadra/host-client` 是无框架依赖的 Protobuf 客户端，目前仅提供只读 `hello()`。
消息 schema 来自 `@armadra/protocol`，不另写一套定义。

```ts
import { HostClient, HostClientError } from "@armadra/host-client";

const client = new HostClient({
  baseUrl: "http://127.0.0.1:43121",
  clientId: "canvas-device-1",
});
try {
  const hello = await client.hello();
  console.log(hello.hostId, hello.hostInstanceId, hello.capabilities);
} catch (error) {
  if (error instanceof HostClientError)
    console.log(error.code, error.retryable);
}
```

`hello({ signal })` 支持取消，构造参数可注入 fetch。默认总超时 10 秒，覆盖请求与完整响应读取；
自定义超时须为有限正数且不超过 32 位定时器上限，clientId 非空且 UTF-8 ≤ 256 字节。

## 约束

- baseUrl 为绝对 URL：HTTPS 可远端，HTTP 仅 localhost、127/8 与 `::1`；拒绝凭据、query、fragment，保留代理路径前缀。
- 请求使用 Protobuf Content-Type / Accept、`credentials: same-origin`、`redirect: error`、`cache: no-store`。
- 主版本必须相同，协商 minor 不高于请求值；minor 0 可缺 hostId，minor ≥ 1 必需，hostInstanceId 和非零 maxFrameBytes 始终必需。
- 接收上限固定 1 MiB，逐块计数；Content-Length 只用于提前拒绝，服务器更大预算不扩大上限。
- capabilities 原样返回，不补服务器未声明的功能；不自动重试，不提供设备登录、凭据存储或业务执行。
- 超限、取消和超时取消响应流；不合作的注入 transport/cancel Promise 不得无限阻塞调用方。

浏览器仍需 Host 的 CORS / TLS / 认证配置；跨源 Cookie 不自动携带。

## 错误

`HostClientError` 仅包含 code、retryable、可选 httpStatus / hostCode，不保留服务端原文、URL、凭据或 cause。
未知远端错误码归 UNKNOWN。

| code                    | 含义                     | 可重试                         |
| ----------------------- | ------------------------ | ------------------------------ |
| INVALID_OPTIONS         | 参数无效                 | 否                             |
| NETWORK_ERROR / TIMEOUT | 网络/流失败或总超时      | 是                             |
| CANCELLED               | 调用方取消               | 否                             |
| HTTP_ERROR              | 非 Protobuf HTTP 错误    | 仅 408/429/502/503/504         |
| UNEXPECTED_CONTENT_TYPE | 成功响应类型错误         | 否                             |
| RESPONSE_TOO_LARGE      | 声明或实际大小超限       | 否                             |
| MALFORMED_RESPONSE      | 二进制损坏或必需字段缺失 | 否                             |
| INCOMPATIBLE_PROTOCOL   | 版本不兼容               | 否                             |
| REMOTE_ERROR            | Protobuf 错误            | 已知暂时性错误或上述 HTTP 状态 |

retryable 仅供调用方决定是否稍后重试本次只读握手，不适用于终端输入、提交等副作用。

## 验证

```sh
pnpm --filter @armadra/protocol build
pnpm --filter @armadra/host-client test
pnpm --filter @armadra/host-client typecheck
pnpm --filter @armadra/host-client build
```

单测使用真实 Response / ReadableStream，覆盖协议、URL、帧上限、取消、超时和错误清理。
真实 Host 的集成验证使用根命令 `pnpm host:smoke`；单测不等同于各平台浏览器实机验收。
