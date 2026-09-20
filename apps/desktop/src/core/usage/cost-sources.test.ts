import { describe, expect, it } from "vitest";

import type { AgentId } from "../agent/registry";
import {
  bucketKey,
  localDate,
  localHour,
  type FileState,
} from "./cost-buckets";
import { COST_SOURCES, costSource, type AbsorbContext } from "./cost-sources";

/**
 * 采集适配器：只有真有本地记录的 agent 在映射里，而两家各自的 `absorb` 算出的桶
 * 和拆分之前逐字一致（下面的期望值是从旧实现固化下来的）。
 */
describe("采集适配器", () => {
  const NOW = Date.parse("2026-09-20T12:00:00Z");
  const STAMP = "2026-09-20T09:30:00Z";

  function fileState(agent: AgentId): FileState {
    return {
      agent,
      len: 0,
      mtimeMs: 0,
      offset: 0,
      modifiedMs: 0,
      model: undefined,
      buckets: new Map(),
      hourBuckets: new Map(),
    };
  }

  function context(): AbsorbContext {
    return { nowMs: NOW, seen: new Set<number>() };
  }

  function absorbAll(agent: AgentId, lines: readonly unknown[]): FileState {
    const source = costSource(agent);
    expect(source).toBeDefined();
    const state = fileState(agent);
    const shared = context();
    for (const line of lines) {
      (source as NonNullable<typeof source>).absorb(state, line, shared);
    }
    return state;
  }

  it("映射里只有留下本地记录的那两家", () => {
    expect(Object.keys(COST_SOURCES)).toEqual(["claude", "codex"]);
    expect(costSource("claude")?.agentId).toBe("claude");
    expect(costSource("codex")?.agentId).toBe("codex");
    // 没有本地来源的 agent 不在映射里——汇总于是报零，而不是编一个数字。
    expect(costSource("opencode")).toBeUndefined();
    expect(costSource("pi")).toBeUndefined();
    expect(costSource("omp")).toBeUndefined();
    expect(costSource("copilot")).toBeUndefined();
    expect(costSource("nobody")).toBeUndefined();
  });

  it("两家的根目录尊重 CLI 自己的覆盖", () => {
    const previous = {
      claude: process.env.CLAUDE_CONFIG_DIR,
      codex: process.env.CODEX_HOME,
    };
    process.env.CLAUDE_CONFIG_DIR = "/tmp/elsewhere-claude";
    process.env.CODEX_HOME = "/tmp/elsewhere-codex";
    try {
      expect(costSource("claude")?.roots()).toEqual([
        "/tmp/elsewhere-claude/projects",
      ]);
      expect(costSource("codex")?.roots()).toEqual([
        "/tmp/elsewhere-codex/sessions",
      ]);
    } finally {
      if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous.claude;
      if (previous.codex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.codex;
    }
  });

  it("预筛的字节和各家记录里真出现的键对得上", () => {
    const claude = costSource("claude")?.needles.map((one) => one.toString());
    expect(claude).toEqual(['"usage"']);
    const codex = costSource("codex")?.needles.map((one) => one.toString());
    expect(codex).toEqual(['"model"', '"token_count"']);
  });

  it("claude 的一批样例行落进同一个桶，重复的 request id 只算一次", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    };
    const state = absorbAll("claude", [
      { requestId: "req-1", timestamp: STAMP, message: { model: "m", usage } },
      // 逐字重复的一行（恢复或者分叉的会话）。
      { requestId: "req-1", timestamp: STAMP, message: { model: "m", usage } },
      // 没有 usage 的行一个 token 都出不来。
      { requestId: "req-2", timestamp: STAMP, message: { model: "m" } },
      // 老记录用 `message.id` 当身份。
      {
        timestamp: STAMP,
        message: { id: "msg-1", model: "m", usage: { input_tokens: 7 } },
      },
      // 模型认不出就是 `unknown`。
      {
        requestId: "req-3",
        timestamp: STAMP,
        message: { usage: { output_tokens: 3 } },
      },
      // 全零的一行不开桶。
      {
        requestId: "req-4",
        timestamp: STAMP,
        message: { model: "m", usage: {} },
      },
    ]);
    expect([...state.buckets]).toEqual([
      [
        bucketKey(localDate(STAMP, NOW), "claude", "m"),
        { input: 107, output: 200, cacheRead: 50, cacheCreation: 25 },
      ],
      [
        bucketKey(localDate(STAMP, NOW), "claude", "unknown"),
        { input: 0, output: 3, cacheRead: 0, cacheCreation: 0 },
      ],
    ]);
  });

  it("codex 记的是每一轮的增量，缓存的那部分从 input 里减掉", () => {
    const state = absorbAll("codex", [
      { timestamp: STAMP, type: "session_meta", payload: { model: "gpt-5" } },
      {
        timestamp: STAMP,
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
      },
      // 换了模型之后的那一轮记在新模型上。
      { timestamp: STAMP, payload: { turn_context: { model: "o3" } } },
      {
        timestamp: STAMP,
        payload: {
          type: "token_count",
          info: { lastTokenUsage: { inputTokens: 10, outputTokens: 2 } },
        },
      },
    ]);
    expect([...state.buckets]).toEqual([
      [
        bucketKey(localDate(STAMP, NOW), "codex", "gpt-5"),
        { input: 600, output: 50, cacheRead: 400, cacheCreation: 0 },
      ],
      [
        bucketKey(localDate(STAMP, NOW), "codex", "o3"),
        { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
      ],
    ]);
  });

  it("够新的行同时进小时桶，旧的只进日桶", () => {
    const fresh = new Date(NOW - 60 * 60_000).toISOString();
    const stale = new Date(NOW - 72 * 60 * 60_000).toISOString();
    const state = absorbAll("claude", [
      {
        requestId: "req-fresh",
        timestamp: fresh,
        message: { model: "m", usage: { input_tokens: 5 } },
      },
      {
        requestId: "req-stale",
        timestamp: stale,
        message: { model: "m", usage: { input_tokens: 9 } },
      },
    ]);
    expect(state.buckets.size).toBe(2);
    expect([...state.hourBuckets.keys()]).toEqual([
      bucketKey(localHour(fresh, NOW), "claude", "m"),
    ]);
  });

  it("去重集合在上下文里，同一行喂给两个文件也只算一次", () => {
    const source = costSource("claude");
    const shared = context();
    const line = {
      requestId: "req-1",
      timestamp: STAMP,
      message: { model: "m", usage: { input_tokens: 5 } },
    };
    const first = fileState("claude");
    const second = fileState("claude");
    source?.absorb(first, line, shared);
    source?.absorb(second, line, shared);
    expect(first.buckets.size).toBe(1);
    expect(second.buckets.size).toBe(0);
  });
});
