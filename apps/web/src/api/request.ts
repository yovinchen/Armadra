import { z } from "zod";
import { isHostServed, resolveRuntimeUrl } from "./runtime-url";
import { ensureHostCsrf, forgetHostCsrf } from "../host/proxy-session";
import { t } from "../app/preferences-store";

/**
 * Runtime HTTP 客户端 —— docs/contracts/v3-agent-terminal-plan.md §7 / §15。
 *
 * 三条约束：
 *  1. 每个响应都过 zod：Runtime 是本地进程但版本可能比前端旧，
 *     字段缺失要在这里炸，而不是在渲染时炸。
 *  2. 连不上 Runtime 与「Runtime 返回错误」是两类失败：前者抛
 *     `RuntimeConnectionError`（壳里有专门的横幅），后者抛普通 Error。
 *  3. 这里不做任何缓存 / 重试 / 状态；调用方自己决定。
 */

const PAGE_URL =
  typeof window === "undefined" ? "http://localhost/" : window.location.href;

export const RUNTIME_URL = resolveRuntimeUrl(
  import.meta.env.VITE_RUNTIME_URL,
  PAGE_URL,
);

/** 这份页面是不是由 Go Host 托管、`/api` 走它的认证代理（H02）。 */
export const RUNTIME_VIA_HOST = isHostServed(
  import.meta.env.VITE_RUNTIME_URL,
  PAGE_URL,
);

/** 204 / 空响应体在进 schema 之前先变成 `undefined`。 */
export const noContentSchema = z.unknown().transform(() => undefined);

export class RuntimeConnectionError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, cause?: unknown) {
    super(t("app.runtimeUnreachable", { endpoint }), { cause });
    this.name = "RuntimeConnectionError";
    this.endpoint = endpoint;
  }
}

/**
 * Runtime 回了非 2xx。消息用 Runtime 给的那句（调用方直接 toast），
 * `status` / `code` 留给需要分支的场景——例如保存冲突要提示重新加载，
 * 而不是笼统的"失败"。
 */
export class RuntimeRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  /**
   * 原样的错误 body。有些拒绝不是一句话能表达的——执行主机改绑的 409 里带着
   * 两边的指纹或者还占着旧主机的东西，调用方要拿这些才说得出人能做什么。
   * 未解析：认得出这个形状的是调用方，不是传输层。
   */
  readonly body?: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(
      code === "git_execution_required"
        ? t("gitRepo.executionRequired")
        : message,
    );
    this.name = "RuntimeRequestError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 写文件的 CAS 失败（HTTP 409）。 */
export function isConflict(error: unknown): boolean {
  return error instanceof RuntimeRequestError && error.status === 409;
}

/** 只有会改状态的方法需要 CSRF；GET / HEAD 靠 SameSite Cookie 与精确 Origin。 */
function unsafeMethod(method: string | undefined): boolean {
  const value = (method ?? "GET").toUpperCase();
  return value !== "GET" && value !== "HEAD";
}

async function send(path: string, init: RequestInit | undefined, csrf: string) {
  return fetch(`${RUNTIME_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(csrf ? { "X-Armadra-CSRF": csrf } : {}),
      ...init?.headers,
    },
  });
}

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const guarded = RUNTIME_VIA_HOST && unsafeMethod(init?.method);
  let response: Response;
  try {
    response = await send(path, init, guarded ? await ensureHostCsrf() : "");
    // A rotated token is the one failure worth retrying: the request never
    // reached the Runtime, so nothing was executed twice. Any other 403 is the
    // Host refusing this device, and repeating it would not change that.
    if (
      guarded &&
      response.status === 403 &&
      !(init?.body instanceof FormData)
    ) {
      forgetHostCsrf();
      const renewed = await ensureHostCsrf();
      if (renewed) response = await send(path, init, renewed);
    }
  } catch (cause) {
    throw new RuntimeConnectionError(RUNTIME_URL, cause);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const body =
      payload && typeof payload === "object"
        ? (payload as { message?: unknown; code?: unknown })
        : null;
    throw new RuntimeRequestError(
      response.status,
      body?.message !== undefined
        ? String(body.message)
        : t("app.runtimeFailed", { status: response.status }),
      body?.code !== undefined ? String(body.code) : undefined,
      payload,
    );
  }
  return schema.parse(payload);
}

export const query = (value: string) => encodeURIComponent(value);

export function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}
