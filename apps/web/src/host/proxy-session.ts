import {
  RenewCsrfRequestSchema,
  RenewCsrfResponseSchema,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";

/**
 * 「经 Host 访问」模式下的会话令牌（H02，host-protocol-design §6）。
 *
 * Host 用 HTTPS 托管这份前端，并把 `/api/**` 代理到本机 Runtime。access /
 * refresh 是 HttpOnly Cookie，JavaScript 读不到；写请求还要带会话绑定的 CSRF
 * 头。这个模块是页面里这枚令牌的唯一持有者：
 *
 *  - 配对 / 刷新时由 `HostIdentityClient` 的 `onCsrfToken` 回调送进来，所以
 *    轮换之后两边不会各持一份旧值；
 *  - 刷新页面后内存里什么都没有，此时凭仍然有效的 refresh Cookie 向
 *    `IdentityService/RenewCsrf` 重新取一枚（这会轮换，所以只在没有时才取）。
 *
 * 令牌只存在内存里：不写 localStorage、不进 URL、不发往本源以外的任何地方。
 */

const RENEW_PATH = "/rpc/armadra.v1.IdentityService/RenewCsrf";
const MEDIA = "application/x-protobuf";
/** Host 的 `identity.ts` 用同一个形状校验：32 字节 base64url。 */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

let token = "";
let pending: Promise<string> | null = null;
const listeners = new Set<() => void>();

/**
 * 会话变了（配对成功、刷新、登出）时通知一次。
 *
 * 配对之前页面上的每一次 `/api` 请求都会被 Host 拒掉，那些失败会留在 React
 * Query 的缓存里；配对成功之后不重新取一遍，用户看到的就是一个刚登录完却写着
 * 「已断开」的界面。返回退订函数。
 */
export function onHostSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 记住一枚由 Host 身份客户端刚拿到（或刚作废）的令牌。 */
export function rememberHostCsrf(value: string): void {
  const next = SECRET.test(value) ? value : "";
  const changed = next !== token;
  token = next;
  pending = null;
  if (!changed) return;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 一个订阅者出错不该拖垮其它订阅者。 */
    }
  }
}

/** 收到 403 后作废本地这枚，下一次写请求会重新取。 */
export function forgetHostCsrf(): void {
  token = "";
  pending = null;
}

/** 仅供测试读取当前内存值。 */
export function hostCsrf(): string {
  return token;
}

/**
 * 取一枚可用的 CSRF 令牌；没有配对（或 Host 不支持）时返回空字符串，由调用方
 * 照常发请求——被拒绝是 Host 的事，前端不在这里替它判断权限。
 */
export async function ensureHostCsrf(
  fetcher: typeof fetch = fetch,
  origin: string | undefined = globalThis.location?.origin,
): Promise<string> {
  if (token) return token;
  if (!origin) return "";
  pending ??= renew(fetcher, origin).finally(() => {
    pending = null;
  });
  return pending;
}

async function renew(fetcher: typeof fetch, origin: string): Promise<string> {
  try {
    const response = await fetcher(`${origin}${RENEW_PATH}`, {
      method: "POST",
      headers: { "Content-Type": MEDIA, Accept: MEDIA },
      body: new Uint8Array(
        toBinary(RenewCsrfRequestSchema, create(RenewCsrfRequestSchema)),
      ),
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) return "";
    const kind = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (kind?.toLowerCase() !== MEDIA) return "";
    const wire = new Uint8Array(await response.arrayBuffer());
    // 4 KiB 足够装下一枚令牌；更大的响应不是这条路该有的东西。
    if (wire.byteLength > 4096) return "";
    const value = fromBinary(RenewCsrfResponseSchema, wire).csrfToken;
    if (!SECRET.test(value)) return "";
    token = value;
    return token;
  } catch {
    return "";
  }
}
