import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILT_IN_PRICES,
  CHUNK_BYTES,
  bucketKey,
  digest,
  MANUAL_COOLDOWN_MS,
  ScanState,
  WINDOW_DAYS,
  costOf,
  emptySummary,
  priceFor,
  summarize,
  undated,
} from "./cost";

/** 移植自 合并前实现的用例。 */
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

  it("三级回退：内置在前，目录补它没有的，两张都没有就是没有价格", async () => {
    const catalog = {
      // 内置表已经有 `claude-opus-5`：目录不该把它顶掉，否则同一台机器在两个
      // 实现下算出的数字会不一样。
      "claude-opus-5": { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
      // 内置表没有的那些，目录来答。
      "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
    };
    const layered = [BUILT_IN_PRICES, catalog];
    expect(priceFor(layered, "claude-opus-5")?.input).toBe(5);
    expect(priceFor(layered, "gemini-3-pro")?.output).toBe(12);
    expect(priceFor(layered, "nobody-prices-this")).toBeUndefined();
    // 带日期的快照命中内置表的不带日期条目，仍然算内置表答的。
    expect(priceFor(layered, "claude-opus-5-20261001")?.input).toBe(5);
    // 单张表仍然是合法的入参：旧调用点一行没改。
    expect(priceFor(BUILT_IN_PRICES, "gemini-3-pro")).toBeUndefined();
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

  /* ----------------------------- 内存的守门 ------------------------------ */

  it("扫过之后不持有任何一行记录的原文", async () => {
    // 一行里塞一段认得出来的文本，再断言扫描状态里没有它。从前这里读的是整段
    // 追加（一个八十兆的文件就是三份八十兆），而扫描器承诺的是「没有一行记录
    // 文本离开扫描器」。
    const marker = "SENTINEL-".repeat(64) + "y".repeat(2 * 1024 * 1024);
    write(".claude/projects/demo/session.jsonl", [
      JSON.stringify({
        type: "assistant",
        requestId: "req-text",
        timestamp: `${today()}T10:00:00Z`,
        message: {
          model: "claude-opus-5",
          content: [{ type: "text", text: marker }],
          usage: { input_tokens: 7, output_tokens: 7 },
        },
      }),
    ]);
    const state = new ScanState();
    const result = await state.scan([
      ["claude", join(home, ".claude/projects")],
    ]);
    expect(result.buckets.size).toBe(1);
    const held = reachableText(state);
    expect(held).not.toContain("SENTINEL");
    // 不只是「那一段文本不在」：整个扫描状态能碰到的字符串加起来也只有路径、日期
    // 和模型 id 那点东西。留着整段追加的实现在这里会是两兆。
    expect(held.length).toBeLessThan(4_096);
  });

  it("每个文件留下的只有几个数字和它的桶，行数再多也不涨", async () => {
    const stamp = `${today()}T10:00:00Z`;
    const lines: string[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          requestId: `req-${i}`,
          timestamp: stamp,
          message: {
            model: "claude-opus-5",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      );
    }
    write(".claude/projects/demo/many.jsonl", lines);
    const state = new ScanState();
    await state.scan([["claude", join(home, ".claude/projects")]]);
    const files = (
      state as unknown as {
        files: Map<string, { buckets: Map<string, unknown> }>;
      }
    ).files;
    expect(files.size).toBe(1);
    // 两千行都是同一天同一个模型，所以桶只有一个：每个文件的常驻量跟着
    // (日期 × 模型) 走，不跟着行数走。
    for (const file of files.values()) expect(file.buckets.size).toBe(1);
    // 去重集合存的是摘要，不是那七万个 id 的原文。
    const seen = (state as unknown as { seen: Set<unknown> }).seen;
    expect(seen.size).toBe(2_000);
    for (const key of seen) expect(typeof key).toBe("number");
  });

  it("一条比读块还长的行仍然被完整读出来", async () => {
    // 行跨块是 `eachAppendedLine` 里唯一一处要把上一块的尾巴带过来的地方。
    const filler = "x".repeat(CHUNK_BYTES * 2);
    write(".claude/projects/demo/huge.jsonl", [
      JSON.stringify({ type: "user", message: { content: filler } }),
      JSON.stringify({
        type: "assistant",
        requestId: "req-huge",
        timestamp: `${today()}T10:00:00Z`,
        message: {
          model: "claude-opus-5",
          content: [{ type: "text", text: filler }],
          usage: { input_tokens: 11, output_tokens: 13 },
        },
      }),
    ]);
    const result = await new ScanState().scan([
      ["claude", join(home, ".claude/projects")],
    ]);
    const bucket = [...result.buckets.values()][0];
    expect(bucket).toEqual({
      input: 11,
      output: 13,
      cacheRead: 0,
      cacheCreation: 0,
    });
  });

  it("id 的摘要是个数字，而且逐字符地区分得开", () => {
    expect(typeof digest("req-1")).toBe("number");
    expect(Number.isSafeInteger(digest("req-1"))).toBe(true);
    expect(digest("req-1")).toBe(digest("req-1"));
    expect(digest("req-1")).not.toBe(digest("req-2"));
    expect(digest("ab")).not.toBe(digest("ba"));
    expect(digest("")).toBe(digest(""));
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

  it("目录里的价格让 unpricedModels 变短", async () => {
    const rows = [
      [localToday(), "claude-opus-5", 1_000_000] as const,
      [localToday(), "gemini-3-pro", 1_000_000] as const,
    ];
    const withoutCatalog = summarize(scanned([...rows]), BUILT_IN_PRICES, NOW);
    expect(withoutCatalog.unpricedModels).toEqual(["gemini-3-pro"]);
    expect(withoutCatalog.today.complete).toBe(false);

    const withCatalog = summarize(
      scanned([...rows]),
      [
        BUILT_IN_PRICES,
        {
          "gemini-3-pro": {
            input: 2,
            output: 12,
            cacheRead: 0.2,
            cacheWrite: 0,
          },
        },
      ],
      NOW,
    );
    expect(withCatalog.unpricedModels).toEqual([]);
    expect(withCatalog.today.complete).toBe(true);
    expect(withCatalog.today.costUsd).toBe(7);
  });

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

/**
 * 从一个对象出发能碰到的所有字符串，拼成一段。守门用例拿它问「扫描状态里还有没
 * 有记录原文」——比断言某个字段不存在结实：换一个字段名也瞒不过去。
 */
function reachableText(root: unknown): string {
  const seen = new Set<unknown>();
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        walk(key, depth + 1);
        walk(entry, depth + 1);
      }
      return;
    }
    if (value instanceof Set) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    for (const entry of Object.values(value)) walk(entry, depth + 1);
  };
  walk(root, 0);
  return out.join("\u0000");
}
