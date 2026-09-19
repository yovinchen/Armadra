import {
  identityHello,
  IdentityRequestError,
  IdentityTransportError,
  type IdentityHello,
} from "../api/identity";

/**
 * 「后台服务连得上吗」这一问的答案。
 *
 * 以前这里有一个可填的服务地址：Runtime 与 Go Host 是两个进程，页面要能被
 * 指向另一台机器上的 Host。单一 core 之后没有第二个地址可填——桌面壳里 core
 * 的端口由壳给（`api/runtime-url.ts`），服务器壳里它就是这张页面的来源。所以
 * 这一问退回它本来的样子：问一次 `hello`，把答案原样说出来。
 */

export type HostProbe = (signal: AbortSignal) => Promise<IdentityHello>;

export const probeHost: HostProbe = (signal) => identityHello(signal);

/** 探测失败对应的文案键。每一档都要能指出该去看哪一边。 */
export function hostErrorKey(error: unknown): string {
  if (error instanceof IdentityTransportError) return "host.error.network";
  if (error instanceof IdentityRequestError) {
    if (error.status === 401 || error.code === "UNAUTHENTICATED")
      return "host.error.auth";
    if (error.status === 403 || error.code === "PERMISSION_DENIED")
      return "host.error.permission";
    if (error.status === 404 || error.status === 501)
      return "host.error.unsupported";
    return "host.error.remote";
  }
  if (error instanceof DOMException && error.name === "AbortError")
    return "host.status.cancelled";
  // zod 解析失败落在这里：连上了，但回来的不是一份认得出的 hello。
  return "host.error.invalidResponse";
}
