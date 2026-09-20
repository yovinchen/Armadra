import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CACHE_VERSION,
  CATALOG_URL,
  REFRESH_INTERVAL_MS,
  ageMs,
  cachePath,
  emptyCatalog,
  isStale,
  parse,
  providerModels,
  readCache,
  writeCache,
} from "./catalog";
import { catalogPrices, pricedModels } from "./index";
import { BUILT_IN_PRICES, priceFor } from "../usage/cost";

/** models.dev 发布的形状，缩到能证明每条规则的最小一份。 */
const UPSTREAM = JSON.stringify({
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
        release_date: "2026-02-17",
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
      "claude-haiku-4-5": {
        name: "Claude Haiku 4.5",
        release_date: "2025-10-01",
        limit: { context: 200_000 },
        cost: { input: 1, output: 5 },
      },
      "claude-subscription-only": {
        name: "Claude Subscription",
        // 没有可用价格：整条 `cost` 缺席，而不是 0。
        limit: { context: 0 },
      },
    },
  },
  openai: {
    models: {
      "gpt-5-codex": {
        name: "GPT-5 Codex",
        release_date: "2026-01-04",
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
      },
    },
  },
  // 我们不读的 provider：整家丢掉。
  mistral: {
    models: { "mistral-large": { cost: { input: 2, output: 6 } } },
  },
});

describe("models.dev 文档的解析", () => {
  it("只留我们有适配器的那几家 provider", () => {
    const catalog = parse(UPSTREAM, "2026-09-20T00:00:00.000Z");
    expect(catalog.source).toBe("network");
    expect(catalog.fetchedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(catalog.url).toBe(CATALOG_URL);
    expect(catalog.version).toBe(CACHE_VERSION);
    expect([...new Set(catalog.models.map((m) => m.provider))].sort()).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  it("没有可用价格的模型是缺 `cost`，不是 `cost: 0`", () => {
    const catalog = parse(UPSTREAM, "2026-09-20T00:00:00.000Z");
    const subscription = catalog.models.find(
      (model) => model.modelId === "claude-subscription-only",
    );
    expect(subscription).toBeDefined();
    expect(subscription?.cost).toBeUndefined();
    // 0 的上限同理：缺席，不是 0。
    expect(subscription?.limit.context).toBeUndefined();
  });

  it("只读四个头条数字，缺的缓存价按 0 记", () => {
    const catalog = parse(UPSTREAM, "2026-09-20T00:00:00.000Z");
    const sonnet = catalog.models.find(
      (model) => model.modelId === "claude-sonnet-4-6",
    );
    expect(sonnet?.cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(sonnet?.limit).toEqual({ context: 1_000_000, output: 128_000 });
    expect(sonnet?.reasoning).toBe(true);

    const codex = catalog.models.find(
      (model) => model.modelId === "gpt-5-codex",
    );
    // OpenAI 不按缓存写计费，上游也没发布这个数字。
    expect(codex?.cost?.cacheWrite).toBe(0);
    expect(codex?.reasoning).toBe(false);
  });

  it("键名在没有 `id` 时就是 id", () => {
    const catalog = parse(UPSTREAM, "2026-09-20T00:00:00.000Z");
    expect(
      catalog.models.some((model) => model.modelId === "claude-haiku-4-5"),
    ).toBe(true);
  });

  it("读不动的文档和一家都不认得的文档都是错误", () => {
    expect(() => parse("not json", "2026-09-20T00:00:00.000Z")).toThrow(
      /models\.dev/,
    );
    expect(() => parse("[]", "2026-09-20T00:00:00.000Z")).toThrow(
      /models\.dev/,
    );
    expect(() =>
      parse(JSON.stringify({ mistral: { models: {} } }), "x"),
    ).toThrow(/provider/);
  });

  it("一个 provider 的模型按发布日期倒序", () => {
    const catalog = parse(UPSTREAM, "2026-09-20T00:00:00.000Z");
    expect(
      providerModels(catalog, "anthropic").map((model) => model.modelId),
    ).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      // 没有日期的排在最后。
      "claude-subscription-only",
    ]);
  });
});

describe("目录的年龄", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");

  it("从没抓到过的目录没有年龄，而且过期", () => {
    const catalog = emptyCatalog();
    expect(ageMs(catalog, NOW)).toBeUndefined();
    expect(isStale(catalog, NOW)).toBe(true);
  });

  it("读不懂的时间戳一律当作过期", () => {
    const catalog = { ...emptyCatalog(), fetchedAt: "不是日期" };
    expect(ageMs(catalog, NOW)).toBeUndefined();
    expect(isStale(catalog, NOW)).toBe(true);
  });

  it("一天之内的不过期，一天之外的过期", () => {
    const fresh = {
      ...emptyCatalog(),
      fetchedAt: new Date(NOW - 3_600_000).toISOString(),
    };
    expect(isStale(fresh, NOW)).toBe(false);
    const old = {
      ...emptyCatalog(),
      fetchedAt: new Date(NOW - REFRESH_INTERVAL_MS - 1).toISOString(),
    };
    expect(isStale(old, NOW)).toBe(true);
  });
});

describe("缓存文件", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "armadra-catalog-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("写进去再读回来，来源变成 cache", () => {
    const path = cachePath(directory);
    expect(path.endsWith("models-catalog.json")).toBe(true);
    const catalog = parse(UPSTREAM, "2026-09-20T00:00:00.000Z");
    writeCache(path, catalog);
    const back = readCache(path);
    expect(back?.source).toBe("cache");
    expect(back?.fetchedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(back?.models).toHaveLength(catalog.models.length);
  });

  it("文件不在、读不动、空的、或者更新版本写的，都是「没有目录」", () => {
    const path = cachePath(directory);
    expect(readCache(path)).toBeUndefined();
    writeFileSync(path, "{");
    expect(readCache(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ version: 1, models: [] }));
    expect(readCache(path)).toBeUndefined();
    writeFileSync(
      path,
      JSON.stringify({
        version: CACHE_VERSION + 1,
        models: [{ provider: "anthropic", modelId: "x", name: "x" }],
      }),
    );
    expect(readCache(path)).toBeUndefined();
  });
});

/**
 * 目录里的价格进本地成本统计：`priceFor` 的第二级回退。
 *
 * 之前成本看板只认内置价目表，目录里明明有价格的模型照样被算进
 * `unpricedModels`——数字偏低而看板说不出为什么。
 */
describe("目录价格接进成本", () => {
  it("带价格的条目变成价目表，没价格的不进", () => {
    const catalog = parse(UPSTREAM, "network");
    const table = catalogPrices(catalog);
    const priced = catalog.models.filter((model) => model.cost !== undefined);
    expect(priced.length).toBeGreaterThan(0);
    for (const model of priced) {
      expect(table[model.modelId], model.modelId).toEqual({
        input: model.cost?.input,
        output: model.cost?.output,
        cacheRead: model.cost?.cacheRead,
        cacheWrite: model.cost?.cacheWrite,
      });
      // 大小写两种写法都在：转录写的 id 不保证和目录一致，而 `priceFor` 不猜。
      expect(table[model.modelId.toLowerCase()]).toBeDefined();
    }
    for (const model of catalog.models) {
      if (model.cost !== undefined) continue;
      expect(table[model.modelId], model.modelId).toBeUndefined();
    }
  });

  it("没有目录就是一张空表，回退到只有内置价", () => {
    expect(catalogPrices(undefined)).toEqual({});
    const layered = [BUILT_IN_PRICES, catalogPrices(undefined)];
    expect(priceFor(layered, "claude-opus-5")).toBeDefined();
  });

  it("内置表 ∪ 目录的去重计数和价目表对得上", () => {
    const catalog = parse(UPSTREAM, "network");
    expect(pricedModels(catalog)).toBeGreaterThanOrEqual(
      Object.keys(BUILT_IN_PRICES).length,
    );
  });
});
