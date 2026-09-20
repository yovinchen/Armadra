/**
 * 模型目录：谁发布了一个模型、它多少钱、能装多少 token（用户实测反馈 F10）。
 *
 * 移植自 合并前的实现，读写**同一个**缓存文件
 * `<dataDir>/models-catalog.json`，同一份 JSON 形状。
 *
 * ## 数字从哪来
 *
 * `GET https://models.dev/api.json` answers one JSON object keyed by provider
 * id：
 *
 * ```json
 * { "anthropic": { "models": { "claude-sonnet-4-6": {
 *     "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6",
 *     "release_date": "2026-02-17", "reasoning": true,
 *     "limit": { "context": 1000000, "output": 128000 },
 *     "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
 * } } } }
 * ```
 *
 * 价格是每**百万** token 的美元，和 `usage/cost.ts` 的内置表同单位。上游还发
 * 布 `tiers`、`context_over_200k`、`input_audio` 之类的附加费，**不读**：一次
 * 会话有没有触发某档附加费，从转录里看不出来，按它计费和凭空编一个价格是同一
 * 个错误。
 *
 * ## 只留四家
 *
 * 上游 213 家 provider、7784 个模型、约 4.6 MB。只留我们有适配器的那几家
 * （{@link KEPT_PROVIDERS}），缓存就是约 100 KB。别处的模型仍然「没有价格」，
 * 和今天一样。
 *
 * ## 什么时候读
 *
 * **只有 core 碰网络**。启动时读缓存；缓存比 {@link REFRESH_INTERVAL_MS} 旧就
 * 安排一次抓取，之后一天一次。抓取失败不是错误状态——缓存照常回答，没有缓存就
 * 由内置表回答，所以每个读者问的都是「现在这份目录」而不是「那份目录」。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeSecret } from "../paths";

/** 唯一一个对外地址，写在这里而不是调用点，方便 grep。 */
export const CATALOG_URL = "https://models.dev/api.json";

/** `<dataDir>/models-catalog.json`。 */
export const CACHE_FILE = "models-catalog.json";

/** 旧版本写的缓存读不动时 +1。 */
export const CACHE_VERSION = 1;

/** 一天一次，启动时缓存比这更旧就先抓一次。 */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 两次**用户发起**的刷新之间的最短间隔。
 *
 * 设置页的刷新按钮是一次手势，连点它不该变成连着几次 4.6 MB 的下载。冷却期内
 * 的刷新返回当前这份目录，不算失败——目录没变，只是没去问。
 */
export const REFRESH_COOLDOWN_MS = 60_000;

/**
 * 启动后第一次抓取前的等待。装配不等它，一个开了就关的 core（集成测试就是这么
 * 用的）根本不会发出这次请求。
 */
export const FIRST_REFRESH_DELAY_MS = 10_000;

/** 超过这个大小在解析前就拒绝：一次重定向不能让 core 缓冲任意多字节。 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** 一次抓取本身的超时。 */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * 从上游文档里留下的 provider。
 *
 * 一家对一个我们发了适配器的 CLI：Claude Code（anthropic）、Codex（openai）、
 * GitHub Copilot（它按自己的额度重列别家的模型）。可以指向任意 provider 的 CLI
 * （opencode、pi、omp）不在这里：它的模型是它自己配置里写的，替它猜一家
 * provider 只会列出这个账号用不了的模型。
 */
export const KEPT_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "github-copilot",
] as const;

/** USD / 百万 token，上游怎么发布就怎么记。 */
export interface CatalogCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** 上游两半都可能缺，缺的报成缺，不报成 0。 */
export interface CatalogLimit {
  readonly context?: number;
  readonly output?: number;
}

export interface CatalogModel {
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
  /** 目录没公布可用价格时缺失——不是 0，0 会被读成「免费」。 */
  readonly cost?: CatalogCost;
  readonly limit: CatalogLimit;
  /** `YYYY-MM-DD`，目录里有才有。 */
  readonly releaseDate?: string;
  readonly reasoning: boolean;
}

/** 内存里这份目录从哪来。设置页把它显示在价格旁边。 */
export type CatalogSource = "network" | "cache" | "builtIn";

/** 磁盘上和内存里是同一个形状。 */
export interface Catalog {
  readonly version: number;
  readonly source: CatalogSource;
  /** RFC 3339 UTC。models.dev 被读到的时刻，不是缓存被加载的时刻。 */
  readonly fetchedAt?: string;
  readonly url: string;
  readonly models: readonly CatalogModel[];
}

export function emptyCatalog(): Catalog {
  return {
    version: CACHE_VERSION,
    source: "builtIn",
    url: CATALOG_URL,
    models: [],
  };
}

export function cachePath(dataDir: string): string {
  return join(dataDir, CACHE_FILE);
}

/** 数据的年龄（毫秒），不是文件的。从没抓到过就是 `undefined`。 */
export function ageMs(catalog: Catalog, now: number): number | undefined {
  if (catalog.fetchedAt === undefined) return undefined;
  const at = Date.parse(catalog.fetchedAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : undefined;
}

/** 读不出年龄的目录一律当作过期：重抓很便宜，信一个读不懂的日期不便宜。 */
export function isStale(catalog: Catalog, now: number): boolean {
  const age = ageMs(catalog, now);
  return age === undefined || age > REFRESH_INTERVAL_MS;
}

/** 一个 provider 的全部模型，最新发布的在前。同日期保持目录自己的顺序。 */
export function providerModels(
  catalog: Catalog,
  provider: string,
): CatalogModel[] {
  return catalog.models
    .filter((model) => model.provider === provider)
    .sort((left, right) =>
      (right.releaseDate ?? "").localeCompare(left.releaseDate ?? ""),
    );
}

/* ------------------------------ 上游文档的形状 ----------------------------- */

interface UpstreamCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function asPositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * 一行价格只有两个头条数字都是真数时才可用。两个缓存数字默认 0——对不单独为
 * 缓存计费的 provider 来说，「不单独计费」就是 0。
 */
function usableCost(raw: unknown): CatalogCost | undefined {
  const cost = asRecord(raw) as UpstreamCost | undefined;
  if (cost === undefined) return undefined;
  const finite = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  const input = finite(cost.input);
  const output = finite(cost.output);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cacheRead: finite(cost.cache_read) ?? 0,
    cacheWrite: finite(cost.cache_write) ?? 0,
  };
}

/**
 * 把发布出来的文档解析成我们留下的那些模型。
 *
 * 描述不出一行可用数据的一律丢掉而不是填默认值：「没有价格」成本面板已经会显示
 * 了，而「价格是 0」是撒谎。
 */
export function parse(document: string, fetchedAt: string): Catalog {
  let upstream: unknown;
  try {
    upstream = JSON.parse(document);
  } catch (error) {
    throw new Error(
      `models.dev: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const providers = asRecord(upstream);
  if (providers === undefined)
    throw new Error("models.dev: 不是一个 JSON 对象");

  const models: CatalogModel[] = [];
  for (const provider of KEPT_PROVIDERS) {
    const entry = asRecord(providers[provider]);
    if (entry === undefined) continue;
    const published = asRecord(entry.models);
    if (published === undefined) continue;
    for (const [key, raw] of Object.entries(published)) {
      const model = asRecord(raw);
      if (model === undefined) continue;
      const modelId = asString(model.id) ?? asString(key);
      if (modelId === undefined) continue;
      const limit = asRecord(model.limit) ?? {};
      const context = asPositive(limit.context);
      const output = asPositive(limit.output);
      const cost = usableCost(model.cost);
      const releaseDate = asString(model.release_date);
      models.push({
        provider,
        modelId,
        name: asString(model.name) ?? modelId,
        ...(cost === undefined ? {} : { cost }),
        limit: {
          ...(context === undefined ? {} : { context }),
          ...(output === undefined ? {} : { output }),
        },
        ...(releaseDate === undefined ? {} : { releaseDate }),
        reasoning: model.reasoning === true,
      });
    }
  }
  if (models.length === 0) {
    throw new Error("models.dev: 里面没有我们读的那几家 provider");
  }
  return {
    version: CACHE_VERSION,
    source: "network",
    fetchedAt,
    url: CATALOG_URL,
    models,
  };
}

/* --------------------------------- 缓存文件 -------------------------------- */

/**
 * 读缓存。文件不在、读不动、或者是更新版本写的，一律当作「没有目录」：内置表
 * 回答，同时安排一次抓取。
 */
export function readCache(path: string): Catalog | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (document === undefined) return undefined;
  const version = typeof document.version === "number" ? document.version : 0;
  if (version > CACHE_VERSION) return undefined;
  if (!Array.isArray(document.models) || document.models.length === 0) {
    return undefined;
  }
  const fetchedAt = asString(document.fetchedAt);
  return {
    version,
    // 磁盘上它是谁抓的就写的谁；在内存里它是缓存。
    source: "cache",
    ...(fetchedAt === undefined ? {} : { fetchedAt }),
    url: asString(document.url) ?? CATALOG_URL,
    models: document.models as CatalogModel[],
  };
}

export function writeCache(path: string, catalog: Catalog): void {
  writeSecret(path, `${JSON.stringify(catalog)}\n`);
}

/* ---------------------------------- 抓取 ---------------------------------- */

/** 注入点：测试给一个假的，生产用 `globalThis.fetch`。 */
export type CatalogFetch = (url: string) => Promise<string>;

export async function fetchCatalog(url: string): Promise<string> {
  const answer = await globalThis.fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!answer.ok) throw new Error(`${url} 答了 ${answer.status}`);
  const length = Number(answer.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error(`${url} 答了超过 ${MAX_RESPONSE_BYTES} 字节`);
  }
  return answer.text();
}
