import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REFRESH_COOLDOWN_MS, cachePath, writeCache, parse } from "./catalog";
import { CatalogService } from "./service";

const UPSTREAM = JSON.stringify({
  anthropic: {
    models: {
      "claude-sonnet-4-6": {
        name: "Claude Sonnet 4.6",
        release_date: "2026-02-17",
        cost: { input: 3, output: 15 },
      },
    },
  },
});

const OTHER = JSON.stringify({
  anthropic: {
    models: {
      "claude-opus-5": {
        name: "Claude Opus 5",
        release_date: "2026-05-01",
        cost: { input: 5, output: 25 },
      },
    },
  },
});

describe("目录服务", () => {
  let directory: string;
  let clock: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "armadra-catalog-service-"));
    clock = Date.parse("2026-09-20T12:00:00.000Z");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function service(fetches: (string | Error)[], onInstalled?: () => void) {
    let index = 0;
    return new CatalogService({
      dataDir: directory,
      now: () => clock,
      fetch: async () => {
        const answer = fetches[Math.min(index, fetches.length - 1)];
        index += 1;
        if (answer instanceof Error) throw answer;
        return answer as string;
      },
      ...(onInstalled === undefined ? {} : { onInstalled }),
    });
  }

  it("装配时只读盘，读不到就是内置表", () => {
    const fresh = service([UPSTREAM]);
    fresh.load();
    expect(fresh.current().source).toBe("builtIn");
    expect(fresh.current().models).toHaveLength(0);

    writeCache(
      cachePath(directory),
      parse(UPSTREAM, new Date(clock - 3_600_000).toISOString()),
    );
    const warm = service([UPSTREAM]);
    warm.load();
    expect(warm.current().source).toBe("cache");
    expect(warm.ageHours()).toBe(1);
  });

  it("一次成功的刷新装上目录并写缓存", async () => {
    let installed = 0;
    const catalog = service([UPSTREAM], () => {
      installed += 1;
    });
    const outcome = await catalog.refresh();
    expect(outcome.error).toBeUndefined();
    expect(catalog.current().source).toBe("network");
    expect(catalog.current().models).toHaveLength(1);
    expect(catalog.ageHours()).toBe(0);
    expect(existsSync(cachePath(directory))).toBe(true);
    // 菜单缓存要被作废，否则刚点了刷新的人还得等满 10 分钟。
    expect(installed).toBe(1);
  });

  it("抓不到不改变目录，只多一行原因", async () => {
    const catalog = service([UPSTREAM, new Error("offline")]);
    await catalog.refresh();
    clock += REFRESH_COOLDOWN_MS;
    const failed = await catalog.refresh();
    expect(failed.error).toBe("offline");
    // 手上那份目录一个字都没变。
    expect(catalog.current().source).toBe("network");
    expect(catalog.current().models).toHaveLength(1);
  });

  it("一份坏答复顶不掉一份好缓存", async () => {
    const catalog = service([UPSTREAM, "not json"]);
    await catalog.refresh();
    clock += REFRESH_COOLDOWN_MS;
    const failed = await catalog.refresh();
    expect(failed.error).toMatch(/models\.dev/);
    expect(catalog.current().models[0]?.modelId).toBe("claude-sonnet-4-6");
  });

  it("冷却期内的刷新不去问，返回当前这份，也不算失败", async () => {
    const catalog = service([UPSTREAM, OTHER]);
    await catalog.refresh();
    clock += REFRESH_COOLDOWN_MS - 1;
    const cooled = await catalog.refresh();
    expect(cooled.error).toBeUndefined();
    expect(cooled.catalog.models[0]?.modelId).toBe("claude-sonnet-4-6");
    // 冷却过去之后同一个手势才真的去问。
    clock += 1;
    const again = await catalog.refresh();
    expect(again.catalog.models[0]?.modelId).toBe("claude-opus-5");
  });

  it("同时来的两次刷新共用那一次抓取", async () => {
    const catalog = service([UPSTREAM, OTHER]);
    const [first, second] = await Promise.all([
      catalog.refresh(),
      catalog.refresh(),
    ]);
    expect(first.catalog.models[0]?.modelId).toBe("claude-sonnet-4-6");
    expect(second.catalog.models[0]?.modelId).toBe("claude-sonnet-4-6");
  });
});
