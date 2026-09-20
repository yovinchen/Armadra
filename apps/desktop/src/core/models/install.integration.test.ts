import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type RunningCore, run } from "../main";
import { cachePath, parse, writeCache } from "./catalog";

/**
 * 模型域，由真的 `run()` 装配起来。
 *
 * 这里要证明的是那三条路由**真的在答**，而不是 501——它们空着的时候，节点头的
 * 「模型」子菜单开出来是空的，而那是用户在打包验收里看见的那一幕。
 *
 * 一次网络请求都不发：目录的缓存文件在 core 起来之前就写好，后台刷新要
 * {@link FIRST_REFRESH_DELAY_MS} 之后才醒，而这个套件跑不了那么久。
 */

let core: RunningCore;
let directory: string;
let base: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "armadra-core-models-"));
  writeCache(
    cachePath(directory),
    parse(
      JSON.stringify({
        anthropic: {
          models: {
            "claude-opus-5": {
              name: "Claude Opus 5",
              release_date: "2026-05-01",
              cost: { input: 5, output: 25 },
              limit: { context: 200_000 },
            },
          },
        },
        openai: {
          models: {
            "gpt-6": {
              name: "GPT-6",
              release_date: "2026-08-01",
              cost: { input: 2, output: 8 },
            },
          },
        },
      }),
      new Date().toISOString(),
    ),
  );
  core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", directory],
    env: { ...process.env, ARMADRA_LOG: "error" },
    stdout: () => {},
  });
  const spec = core.bound[0];
  if (spec === undefined || spec.kind !== "tcp") throw new Error("no listener");
  base = `http://${spec.host}:${spec.port}`;
}, 30_000);

afterAll(async () => {
  await core?.stop();
  rmSync(directory, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const answer = await fetch(base + path, {
    method,
    headers: { origin: base },
  });
  const text = await answer.text();
  return {
    status: answer.status,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

interface CatalogBody {
  source: string;
  url: string;
  fetchedAt?: string;
  ageHours?: number;
  pricedModels: number;
  refreshError?: string;
  models: { provider: string; modelId: string }[];
}

interface ModelRow {
  id: string;
  label: string;
  source: string;
  releaseDate?: string;
}

describe("装配起来的模型域", () => {
  it("目录那条答的是缓存，不是 501", async () => {
    const answer = await call("GET", "/api/models/catalog");
    expect(answer.status).toBe(200);
    const body = answer.body as CatalogBody;
    expect(body.source).toBe("cache");
    expect(body.url).toBe("https://models.dev/api.json");
    expect(body.ageHours).toBe(0);
    // 内置价目表 ∪ 目录里带价格的两条。
    expect(body.pricedModels).toBeGreaterThan(2);
    expect(body.refreshError).toBeUndefined();
    expect(body.models.map((model) => model.modelId).sort()).toEqual([
      "claude-opus-5",
      "gpt-6",
    ]);
  });

  it("每个内置 CLI 的模型菜单都答得出来", async () => {
    const claude = await call("GET", "/api/agents/claude/models");
    expect(claude.status).toBe(200);
    const rows = claude.body as ModelRow[];
    // 这台机器上装没装 `claude` 不影响这一条：目录那一档一定在。
    expect(rows.some((row) => row.id === "claude-opus-5")).toBe(true);
    const opus = rows.find((row) => row.id === "claude-opus-5");
    expect(opus?.label).toBe("Claude Opus 5");
    expect(opus?.source).toBe("catalog");
    expect(opus?.releaseDate).toBe("2026-05-01");
    // 兜底那三条也在，菜单永远不是空的。
    expect(rows.some((row) => row.source === "builtin")).toBe(true);

    // 可以指向任意 provider 的 CLI 没有目录那一档，但路由照样答 200。
    const opencode = await call("GET", "/api/agents/opencode/models");
    expect(opencode.status).toBe(200);
    expect(Array.isArray(opencode.body)).toBe(true);
  });

  it("不认识的 Agent 是 404，不是 501 也不是 500", async () => {
    const answer = await call("GET", "/api/agents/nope/models");
    expect(answer.status).toBe(404);
    expect((answer.body as { code: string }).code).toBe("not_found");
    expect((answer.body as { message: string }).message).toContain("nope");
  });

  it("`GET /api/agents` 带上探测那一栏（还没探到时就没有这一栏）", async () => {
    const answer = await call("GET", "/api/agents");
    expect(answer.status).toBe(200);
    const rows = answer.body as { id: string; probe?: { status: string } }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.probe === undefined) continue;
      // 有就必须是这两种之一：「问不出来」从不写成「支持」。
      expect(["ok", "failed"]).toContain(row.probe.status);
    }
  });
});
