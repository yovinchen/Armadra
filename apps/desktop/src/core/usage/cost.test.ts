import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILT_IN_PRICES,
  bucketKey,
  MANUAL_COOLDOWN_MS,
  ScanState,
  WINDOW_DAYS,
  costOf,
  emptySummary,
  priceFor,
  summarize,
  undated,
} from "./cost";

/** 移植自 `apps/runtime/src/usage/cost/{scan,pricing,mod}.rs` 的用例。 */
describe("价格表", () => {
  it("带日期的快照落回它不带日期的 id", async () => {
    expect(undated("claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
    expect(undated("gpt-5-2026-01-02")).toBe("gpt-5");
    // 一次部分匹配必须落空而不是被截断。
    expect(undated("gpt-5-mini")).toBeUndefined();
    expect(undated("o4-mini")).toBeUndefined();
    expect(undated("gpt")).toBeUndefined();
  });

  it("不在表里的模型完全没有成本，而不是从相近的名字估", async () => {
    expect(priceFor(BUILT_IN_PRICES, "claude-opus-5")).toBeDefined();
    expect(priceFor(BUILT_IN_PRICES, "claude-opus-5-20261001")).toBeDefined();
    expect(priceFor(BUILT_IN_PRICES, "some-unknown-model")).toBeUndefined();
    // 「像 opus」不是价格。
    expect(priceFor(BUILT_IN_PRICES, "claude-opus-9")).toBeUndefined();
  });

  it("OpenAI 的行不按缓存写计费", async () => {
    expect(BUILT_IN_PRICES["gpt-5"]?.cacheWrite).toBe(0);
    // Anthropic 的行是 1.25×。
    expect(BUILT_IN_PRICES["claude-opus-5"]?.cacheWrite).toBe(6.25);
  });

  it("一桶 token 按每百万的价格算", async () => {
    const price = BUILT_IN_PRICES["claude-opus-5"];
    expect(price).toBeDefined();
    expect(
      costOf(price as NonNullable<typeof price>, {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 0,
        cacheCreation: 0,
      }),
    ).toBe(30);
  });
});

describe("记录扫描", () => {
  let home: string;
  let previous: { claude?: string; codex?: string };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "armadra-cost-"));
    previous = {
      ...(process.env.CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { claude: process.env.CLAUDE_CONFIG_DIR }),
      ...(process.env.CODEX_HOME === undefined
        ? {}
        : { codex: process.env.CODEX_HOME }),
    };
  });

  afterEach(() => {
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous.claude;
    if (previous.codex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codex;
    rmSync(home, { recursive: true, force: true });
  });

  function write(relative: string, lines: readonly string[]): string {
    const path = join(home, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  const today = (): string => {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };

  it("一个 request id 在整个扫描里只被计一次", async () => {
    const stamp = `${today()}T10:00:00Z`;
    write(".claude/projects/demo/session.jsonl", [
      JSON.stringify({
        type: "assistant",
        requestId: "req-1",
        timestamp: stamp,
        message: {
          model: "claude-opus-5",
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
        },
      }),
      // 一次恢复或者分叉的会话会逐字重复这一行。
      JSON.stringify({
        type: "assistant",
        requestId: "req-1",
        timestamp: stamp,
        message: {
          model: "claude-opus-5",
          usage: { input_tokens: 100, output_tokens: 200 },
        },
      }),
    ]);
    const result = await new ScanState().scan([
      ["claude", join(home, ".claude/projects")],
    ]);
    const bucket = [...result.buckets.entries()].find(([key]) =>
      key.endsWith("claude-opus-5"),
    );
    expect(bucket?.[1]).toEqual({
      input: 100,
      output: 200,
      cacheRead: 50,
      cacheCreation: 25,
    });
  });

  it("Codex 记的是每一轮的增量，缓存的那部分从 input 里减掉", async () => {
    write(".codex/sessions/2026/09/20/rollout.jsonl", [
      JSON.stringify({
        timestamp: `${today()}T09:00:00Z`,
        type: "session_meta",
        payload: { id: "s1", model: "gpt-5-codex" },
      }),
      JSON.stringify({
        timestamp: `${today()}T09:01:00Z`,
        payload: {
          type: "token_count",
          info: {
            // 累计的那个会把这个会话的成本乘上它的轮数，所以不能用它。
            total_token_usage: { input_tokens: 9_999, output_tokens: 9_999 },
            last_token_usage: {
              input_tokens: 1_000,
              cached_input_tokens: 400,
              output_tokens: 50,
            },
          },
        },
      }),
    ]);
    const result = await new ScanState().scan([
      ["codex", join(home, ".codex/sessions")],
    ]);
    const bucket = [...result.buckets.entries()].find(([key]) =>
      key.endsWith("gpt-5-codex"),
    );
    expect(bucket?.[1]).toEqual({
      input: 600,
      output: 50,
      cacheRead: 400,
      cacheCreation: 0,
    });
  });

  it("只有追加的字节被重新解析", async () => {
    const path = write(".claude/projects/demo/session.jsonl", [
      JSON.stringify({
        requestId: "req-1",
        timestamp: `${today()}T10:00:00Z`,
        message: {
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
    ]);
    const state = new ScanState();
    const roots = [["claude", join(home, ".claude/projects")]] as const;
    expect((await state.scan(roots)).buckets.size).toBe(1);
    writeFileSync(
      path,
      `${JSON.stringify({
        requestId: "req-1",
        timestamp: `${today()}T10:00:00Z`,
        message: {
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      })}\n${JSON.stringify({
        requestId: "req-2",
        timestamp: `${today()}T10:05:00Z`,
        message: {
          model: "claude-sonnet-5",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      })}\n`,
    );
    const second = await state.scan(roots);
    // 第一行没有被再算一次，第二行进来了。
    expect(second.buckets.size).toBe(2);
    const opus = [...second.buckets].find(([key]) =>
      key.endsWith("claude-opus-5"),
    );
    expect(opus?.[1].input).toBe(10);
  });

  it("结尾那条不完整的行留给下一趟", async () => {
    const path = join(home, ".claude/projects/demo/session.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"requestId":"req-1","message":{"usage":{"input');
    const result = await new ScanState().scan([
      ["claude", join(home, ".claude/projects")],
    ]);
    expect(result.buckets.size).toBe(0);
  });

  it("消失了的文件把它的贡献一起带走", async () => {
    const path = write(".claude/projects/demo/session.jsonl", [
      JSON.stringify({
        requestId: "req-1",
        timestamp: `${today()}T10:00:00Z`,
        message: {
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
    ]);
    const state = new ScanState();
    const roots = [["claude", join(home, ".claude/projects")]] as const;
    expect((await state.scan(roots)).buckets.size).toBe(1);
    rmSync(path);
    expect((await state.scan(roots)).buckets.size).toBe(0);
  });
});

describe("汇总", () => {
  const NOW = Date.parse("2026-09-20T12:00:00Z");

  function scanned(entries: readonly (readonly [string, string, number])[]) {
    const buckets = new Map<string, ReturnType<typeof tokensOf>>();
    for (const [date, model, input] of entries) {
      buckets.set(bucketKey(date, model), tokensOf(input));
    }
    return {
      buckets,
      files: { claude: 1 },
      truncated: false,
      current: undefined,
    };
  }

  function tokensOf(input: number) {
    return { input, output: 0, cacheRead: 0, cacheCreation: 0 };
  }

  function localToday(): string {
    const now = new Date(NOW);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  it("补齐 30 天的轴，没有活动的那天也在", async () => {
    const summary = summarize(scanned([]), BUILT_IN_PRICES, NOW);
    expect(summary.daily).toHaveLength(WINDOW_DAYS);
    expect(summary.daily.at(-1)?.date).toBe(localToday());
    // 一次什么都没扫到的扫描是 `unavailable`，不是 `ok` 加一堆零。
    expect(summary.status).toBe("unavailable");
  });

  it("没有价格的模型只贡献 token，并让窗口变成不完整", async () => {
    const summary = summarize(
      scanned([
        [localToday(), "claude-opus-5", 1_000_000],
        [localToday(), "a-model-nobody-priced", 1_000_000],
      ]),
      BUILT_IN_PRICES,
      NOW,
    );
    expect(summary.status).toBe("ok");
    expect(summary.today.costUsd).toBe(5);
    expect(summary.today.complete).toBe(false);
    expect(summary.unpricedModels).toEqual(["a-model-nobody-priced"]);
    const unpriced = summary.today.models.find(
      (one) => one.model === "a-model-nobody-priced",
    );
    expect(unpriced?.costUsd).toBeNull();
    expect(unpriced?.tokens.input).toBe(1_000_000);
  });

  it("模型拆分按花费降序，看板自上而下读", async () => {
    const summary = summarize(
      scanned([
        [localToday(), "claude-haiku-4-5", 1_000_000],
        [localToday(), "claude-opus-5", 1_000_000],
      ]),
      BUILT_IN_PRICES,
      NOW,
    );
    expect(summary.today.models.map((one) => one.model)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
    ]);
  });

  it("窗口之外的日期不计入", async () => {
    const summary = summarize(
      scanned([["2020-01-01", "claude-opus-5", 1_000_000]]),
      BUILT_IN_PRICES,
      NOW,
    );
    expect(summary.last30Days.costUsd).toBe(0);
    expect(summary.last30Days.models).toHaveLength(0);
  });

  it("关掉的扫描答 disabled，没有读过任何文件", async () => {
    expect(emptySummary("disabled").status).toBe("disabled");
    expect(emptySummary("disabled").daily).toHaveLength(0);
    expect(MANUAL_COOLDOWN_MS).toBe(30_000);
  });
});
