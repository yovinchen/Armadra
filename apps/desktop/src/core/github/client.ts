/**
 * core 通往 GitHub REST / GraphQL 的唯一一条路。移植自
 * `apps/host/internal/githubapi/client.go`。
 *
 * 它拥有条件请求、翻页、限流处理和退避，所以没有调用方需要自己再实现一遍；也
 * 因此**一次写永远不会被悄悄重试**：结果没被读到的请求报 `UNKNOWN_OUTCOME`，
 * 而不是再发一遍。
 *
 * API base 按 client 注入、从不推断。为企业版 base 建的 client 没法被重定向到
 * 公有服务上去，因为每条请求路径都对着那个 base 解析，而重定向一律当错误。
 */

import { apiFailure, type GithubCode } from "./errors";
import { PUBLIC_API_BASE, normalizeApiBase } from "./remote";

/** 这些端点上 GitHub 自己的上限。 */
export const MAX_PER_PAGE = 100;
/**
 * 单条响应 core 肯持有的上限。够装 100 条带长正文的 issue，又小到让一个敌意端点
 * 没法耗光内存。
 */
export const MAX_RESPONSE_BYTES = 8 << 20;
/**
 * 条件请求缓存的两条上限，任何一条被顶到都按**最近最少使用**逐出一条。
 *
 *   * 条目：100。一页最多 {@link MAX_PER_PAGE} = 100 条 issue，所以缓存里最多
 *     躺着 10,000 条 issue——这是这条数字的由来，不是一个凭空的槽位数。
 *   * 字节：64 MiB。
 *
 * 两条都要，因为它们防的不是同一件事：条目数防的是「很多小页面」，字节数防的是
 * 「一页里全是超长正文」。
 */
export const MAX_CACHE_ENTRIES = 100;
export const MAX_CACHED_ISSUES = MAX_CACHE_ENTRIES * MAX_PER_PAGE;
export const MAX_CACHE_BYTES = 64 << 20;
/** 读会被有限次重试；写永远不会。 */
const DEFAULT_ATTEMPTS = 3;
const ACCEPT_REST = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
/** 远端可能报一个离谱地远的 reset；在一次请求里等上几分钟看起来像卡死。 */
const MAX_DEFERRAL_MS = 30_000;

/**
 * 一个请求的 bearer 令牌。**每次请求都调一遍**，所以撤销一个凭据会立刻生效，
 * 而 core 持有令牌的时间不超过一次调用。
 */
export type TokenSource = () => Promise<string>;

/** 远端实际报出来的限流，面板用它说明为什么刷新被拦着，而不是看起来坏了。 */
export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly resetsAtMs: number;
  readonly retryAfterMs: number;
  readonly throttled: boolean;
}

export const NO_RATE_LIMIT: RateLimit = {
  limit: 0,
  remaining: 0,
  resetsAtMs: 0,
  retryAfterMs: 0,
  throttled: false,
};

/** 一次完成的请求。`body` 要么是新读的，要么是 304 之后从缓存里放回来的。 */
export interface GithubResponse {
  readonly status: number;
  readonly body: Buffer;
  readonly nextPage: number;
  readonly rate: RateLimit;
  /**
   * 远端说这个令牌带着哪些 scope（`X-OAuth-Scopes`）。细粒度令牌一个都不报，
   * 所以空列表的意思是「没报」，从来不是「没有权限」。
   */
  readonly oauthScopes: readonly string[];
  readonly fromCache: boolean;
}

export interface GithubClientOptions {
  readonly apiBase?: string;
  readonly token: TokenSource;
  /** 注入的 `fetch`，测试用它指向本地假 GitHub。 */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly userAgent?: string;
  readonly attempts?: number;
}

interface CacheEntry {
  etag: string;
  link: string;
  body: Buffer;
  usedAt: number;
}

export class GithubClient {
  private readonly base: URL;
  private readonly normalizedBase: string;
  private readonly token: TokenSource;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly agent: string;
  private readonly attempts: number;
  private readonly cache = new Map<string, CacheEntry>();
  private cacheSize = 0;
  private clock = 0;
  /** 远端让我们等的时候设置。之前的请求在本地被拒，而不是加深次级限流。 */
  private deferUntilMs = 0;
  private lastRate: RateLimit = NO_RATE_LIMIT;

  constructor(options: GithubClientOptions) {
    const base = normalizeApiBase(options.apiBase);
    this.normalizedBase = base;
    this.base = new URL(base);
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.agent = options.userAgent ?? "armadra-core";
    this.attempts =
      options.attempts !== undefined && options.attempts > 0
        ? options.attempts
        : DEFAULT_ATTEMPTS;
  }

  apiBase(): string {
    return this.normalizedBase;
  }

  /** 是不是公有服务之外的东西，企业版仓库据此不会被解析到别处。 */
  enterprise(): boolean {
    return this.normalizedBase !== PUBLIC_API_BASE;
  }

  /** 最近一条响应报的限流。只是展示数据，永远不是授权判断。 */
  lastRateLimit(): RateLimit {
    return this.lastRate;
  }

  /** 可缓存的读。ETag 命中就放回存着的正文，这就是轮询不超配额的做法。 */
  get(
    path: string,
    query?: Record<string, string>,
  ): Promise<GithubResponse> {
    return this.perform("GET", path, query, undefined, true);
  }

  /** 一次写。**永远不重试**：调用方得知结果未知并重新读，而不是冒险重复。 */
  write(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<GithubResponse> {
    return this.perform(method, path, undefined, body, false);
  }

  /**
   * 一条 GraphQL 查询。Projects v2 没有 REST 面，project item 的状态字段只能
   * 这么写。
   */
  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<unknown> {
    const payload: Record<string, unknown> = { query };
    if (Object.keys(variables).length > 0) payload.variables = variables;
    const response = await this.perform(
      "POST",
      "/graphql",
      undefined,
      payload,
      false,
    );
    let envelope: {
      data?: unknown;
      errors?: { type?: string }[];
    };
    try {
      envelope = JSON.parse(response.body.toString("utf8")) as typeof envelope;
    } catch {
      throw apiFailure("INVALID_ARGUMENT", response.status, "GRAPHQL_MALFORMED");
    }
    // GraphQL 会带着 errors 数组答 200；把那当成功就会报告一次并未发生的写。
    const first = envelope.errors?.[0];
    if (first !== undefined) {
      if (first.type === "NOT_FOUND") {
        throw apiFailure("NOT_FOUND", response.status, "GRAPHQL_NOT_FOUND");
      }
      if (first.type === "FORBIDDEN" || first.type === "INSUFFICIENT_SCOPES") {
        throw apiFailure(
          "PERMISSION_DENIED",
          response.status,
          "GRAPHQL_FORBIDDEN",
        );
      }
      throw apiFailure("INVALID_ARGUMENT", response.status, "GRAPHQL_ERROR");
    }
    return envelope.data;
  }

  /**
   * 调用方拼的路径必须还是一条路径。任何可能把请求重新指向另一个 authority 的
   * 东西一律拒绝，而不是转义掉。
   */
  private resolve(path: string, query?: Record<string, string>): string {
    if (
      !path.startsWith("/") ||
      path.includes("//") ||
      /[?#\\]/.test(path)
    ) {
      throw apiFailure("INVALID_ARGUMENT", 0, "PATH_INVALID");
    }
    for (const character of path) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 0x20 || code >= 0x7f) {
        throw apiFailure("INVALID_ARGUMENT", 0, "PATH_INVALID");
      }
    }
    const target = new URL(this.base.toString());
    target.pathname = `${stripTrailingSlash(this.base.pathname)}${path}`;
    if (query !== undefined && Object.keys(query).length > 0) {
      target.search = new URLSearchParams(query).toString();
    }
    return target.toString();
  }

  private async perform(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    body: unknown,
    cacheable: boolean,
  ): Promise<GithubResponse> {
    const target = this.resolve(path, query);
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const key = `${method} ${target}`;
    const attempts = cacheable ? this.attempts : 1;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.sleep(backoff(attempt));
      const wait = this.deferral();
      if (wait > 0) {
        // 现在发出去只会加深次级限流。读等一等；写直接拒绝，由用户决定，而不是
        // 在那儿干耗着。
        if (!cacheable) {
          throw apiFailure("RESOURCE_EXHAUSTED", 0, "RATE_LIMIT_DEFERRED");
        }
        await this.sleep(wait);
      }
      try {
        return await this.attempt(method, target, key, payload, cacheable);
      } catch (error) {
        last = error;
        if (!retryable(error, cacheable)) throw error;
      }
    }
    throw last;
  }

  private deferral(): number {
    if (this.deferUntilMs === 0) return 0;
    const remaining = this.deferUntilMs - this.now();
    if (remaining <= 0) {
      this.deferUntilMs = 0;
      return 0;
    }
    return Math.min(remaining, MAX_DEFERRAL_MS);
  }

  private async attempt(
    method: string,
    target: string,
    key: string,
    payload: Buffer | undefined,
    cacheable: boolean,
  ): Promise<GithubResponse> {
    const token = await this.token();
    if (token === "") {
      throw apiFailure("UNAUTHENTICATED", 0, "NO_CREDENTIAL");
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: ACCEPT_REST,
      "x-github-api-version": API_VERSION,
      "user-agent": this.agent,
    };
    if (payload !== undefined) headers["content-type"] = "application/json";
    const cached = cacheable ? this.lookup(key) : undefined;
    if (cached !== undefined && cached.etag !== "") {
      headers["if-none-match"] = cached.etag;
    }

    let result: Response;
    try {
      result = await this.doFetch(target, {
        method,
        headers,
        ...(payload === undefined
          ? {}
          : { body: new Uint8Array(payload) as BodyInit }),
        // 跟随重定向会让远端把一个带着 bearer 令牌的请求搬到另一个 authority。
        redirect: "manual",
      });
    } catch {
      if (!cacheable) {
        // 请求可能已经送到，只是响应丢了。
        throw apiFailure("UNKNOWN_OUTCOME", 0, "TRANSPORT_FAILED");
      }
      throw apiFailure("UNAVAILABLE", 0, "TRANSPORT_FAILED");
    }

    const rate = this.observe(result);
    if (result.status === 304 && cached !== undefined) {
      return {
        status: 200,
        body: cached.body,
        nextPage: nextPage(cached.link),
        rate,
        oauthScopes: oauthScopes(result),
        fromCache: true,
      };
    }
    const data = Buffer.from(await result.arrayBuffer());
    if (data.byteLength > MAX_RESPONSE_BYTES) {
      throw apiFailure("INVALID_ARGUMENT", result.status, "RESPONSE_TOO_LARGE");
    }
    if (result.status >= 200 && result.status < 300) {
      const link = result.headers.get("link") ?? "";
      if (cacheable) this.store(key, result.headers.get("etag") ?? "", link, data);
      return {
        status: result.status,
        body: data,
        nextPage: nextPage(link),
        rate,
        oauthScopes: oauthScopes(result),
        fromCache: false,
      };
    }
    throw classify(result.status, rate, cacheable);
  }

  private observe(result: Response): RateLimit {
    const now = this.now();
    const limit = headerInt(result, "x-ratelimit-limit");
    const remaining = headerInt(result, "x-ratelimit-remaining");
    const reset = headerInt(result, "x-ratelimit-reset");
    const retry = headerInt(result, "retry-after");
    let throttled = false;
    const retryAfterMs = retry > 0 ? now + retry * 1000 : 0;
    if (result.status === 429 || (result.status === 403 && retryAfterMs > 0)) {
      throttled = true;
    }
    if (result.headers.get("x-ratelimit-remaining") === "0") throttled = true;
    const rate: RateLimit = {
      limit,
      remaining,
      resetsAtMs: reset > 0 ? reset * 1000 : 0,
      retryAfterMs,
      throttled,
    };
    this.lastRate = rate;
    if (rate.retryAfterMs > now) {
      this.deferUntilMs = rate.retryAfterMs;
    } else if (rate.throttled && rate.resetsAtMs > now) {
      this.deferUntilMs = rate.resetsAtMs;
    } else if (!rate.throttled) {
      this.deferUntilMs = 0;
    }
    return rate;
  }

  private lookup(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry !== undefined) {
      this.clock += 1;
      entry.usedAt = this.clock;
    }
    return entry;
  }

  /** 满了就逐出最近最少使用的那条，而不是继续长。 */
  private store(key: string, etag: string, link: string, body: Buffer): void {
    if (etag === "" || body.byteLength > MAX_CACHE_BYTES) return;
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      this.cacheSize -= existing.body.byteLength;
      this.cache.delete(key);
    }
    while (
      this.cache.size > 0 &&
      (this.cache.size >= MAX_CACHE_ENTRIES ||
        this.cacheSize + body.byteLength > MAX_CACHE_BYTES)
    ) {
      let oldestKey = "";
      let oldest = 0;
      for (const [candidate, entry] of this.cache) {
        if (oldestKey === "" || entry.usedAt < oldest) {
          oldestKey = candidate;
          oldest = entry.usedAt;
        }
      }
      const victim = this.cache.get(oldestKey);
      if (victim === undefined) break;
      this.cacheSize -= victim.body.byteLength;
      this.cache.delete(oldestKey);
    }
    this.clock += 1;
    this.cache.set(key, {
      etag,
      link,
      body: Buffer.from(body),
      usedAt: this.clock,
    });
    this.cacheSize += body.byteLength;
  }

  /** 缓存里现在有多少字节，给测试和诊断看。 */
  cachedBytes(): number {
    return this.cacheSize;
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function backoff(attempt: number): number {
  return 2 ** (attempt - 1) * 500;
}

function retryable(error: unknown, cacheable: boolean): boolean {
  if (!cacheable) return false;
  const code: GithubCode | undefined =
    error instanceof Error && "code" in error
      ? ((error as { code: GithubCode }).code)
      : undefined;
  return code === "UNAVAILABLE";
}

function classify(
  status: number,
  rate: RateLimit,
  cacheable: boolean,
): Error {
  if (status === 401) return apiFailure("UNAUTHENTICATED", status, "TOKEN_REJECTED");
  if (status === 429) return apiFailure("RESOURCE_EXHAUSTED", status, "RATE_LIMITED");
  if (status === 403) {
    // GitHub 对「你不可以」和它的次级限流都答 403。只有配额头能分开它们。
    if (rate.throttled || (rate.remaining === 0 && rate.limit > 0)) {
      return apiFailure("RESOURCE_EXHAUSTED", status, "RATE_LIMITED");
    }
    return apiFailure("PERMISSION_DENIED", status, "FORBIDDEN");
  }
  if (status === 404) return apiFailure("NOT_FOUND", status, "NOT_FOUND");
  if (status === 409) return apiFailure("CONFLICT", status, "CONFLICT");
  if (status === 422) return apiFailure("INVALID_ARGUMENT", status, "UNPROCESSABLE");
  if (status === 405) return apiFailure("UNSUPPORTED", status, "METHOD_NOT_ALLOWED");
  if (status >= 300 && status < 400) {
    return apiFailure("INVALID_ARGUMENT", status, "REDIRECT_REFUSED");
  }
  if (status >= 500) {
    return cacheable
      ? apiFailure("UNAVAILABLE", status, "REMOTE_UNAVAILABLE")
      : apiFailure("UNKNOWN_OUTCOME", status, "REMOTE_UNAVAILABLE");
  }
  return apiFailure("INVALID_ARGUMENT", status, "UNEXPECTED_STATUS");
}

function headerInt(result: Response, name: string): number {
  const raw = (result.headers.get(name) ?? "").trim();
  if (!/^\d+$/.test(raw)) return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** 经典令牌带的 scope。细粒度令牌一个都不报，空列表 ≠ 无权限。 */
export function oauthScopes(result: Response): string[] {
  const raw = result.headers.get("x-oauth-scopes") ?? "";
  if (raw.trim() === "") return [];
  const scopes: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "" || value.length > 64 || scopes.length >= 32) continue;
    if (/[^\x21-\x7e]/.test(value)) continue;
    scopes.push(value);
  }
  return scopes;
}

/**
 * 只从 Link 头里读页码。远端 URL 本身既不跟随也不交回给客户端：一个是 URL 的
 * 游标会让响应操纵下一次请求。
 */
export function nextPage(link: string): number {
  for (const section of link.split(",")) {
    const parts = section.trim().split(";");
    if (parts.length < 2) continue;
    const relation = parts
      .slice(1)
      .some((attribute) => {
        const value = attribute.trim();
        return value === 'rel="next"' || value === "rel=next";
      });
    if (!relation) continue;
    const raw = (parts[0] as string).trim();
    if (!raw.startsWith("<") || !raw.endsWith(">")) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw.slice(1, -1));
    } catch {
      continue;
    }
    const page = Number.parseInt(parsed.searchParams.get("page") ?? "", 10);
    if (!Number.isInteger(page) || page < 2 || page > 10_000) continue;
    return page;
  }
  return 0;
}

export function perPage(limit: number): string {
  return String(limit <= 0 || limit > MAX_PER_PAGE ? MAX_PER_PAGE : limit);
}
