/**
 * 每个 agent 的本地采集适配器。
 *
 * 加一家 agent 只有一条路径：写一个 {@link AgentCostSource}，在 {@link COST_SOURCES}
 * 里注册它——`summarize()`、线上形状和界面一行都不用改。
 *
 * 映射里**只有**在本机留下可解析记录的 agent。没有本地来源的那几家不在这里，于是
 * 它们在汇总里是 `source: "none"` 的零，而不是一个编出来的数字。
 */

import { join } from "node:path";

import type { AgentId } from "../agent/registry";
import {
  digest,
  isEmptyTokens,
  record,
  type FileState,
  type TokenTotals,
} from "./cost-buckets";
import { homeDir } from "./providers";

/**
 * 一趟扫描共用的东西。去重集合在这里而不是在适配器里：一个 request id 在**整趟
 * 扫描**里只能被计一次，而适配器是每家一个常量，不该持有状态。
 */
export interface AbsorbContext {
  readonly nowMs: number;
  /** 见过的 request id 摘要（{@link digest}）。 */
  readonly seen: Set<number>;
}

export interface AgentCostSource {
  readonly agentId: AgentId;
  /** 要扫的根目录。这台机器上认不出任何一个时是空数组。 */
  roots(): readonly string[];
  /** 解码前的字节预筛，见 `eachAppendedLine`。 */
  readonly needles: readonly Buffer[];
  /** 一行 JSON → 写桶。 */
  absorb(state: FileState, value: unknown, context: AbsorbContext): void;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `${VARIABLE:-~/.name}/leaf`，CLI 自己的覆盖优先。 */
function cliRoot(variable: string, name: string, leaf: string): string[] {
  const override = process.env[variable] ?? "";
  if (override !== "") return [join(override, leaf)];
  const home = homeDir();
  return home === undefined ? [] : [join(home, name, leaf)];
}

/** 一行重复了就返回 true，同时把它记进去。没有 id 的行一律算新的。 */
function duplicate(
  context: AbsorbContext,
  identity: string | undefined,
): boolean {
  if (identity === undefined) return false;
  const key = digest(identity);
  if (context.seen.has(key)) return true;
  context.seen.add(key);
  return false;
}

/**
 * 一行**有可能**贡献点什么吗。在字节上判，判错的方向只能是「放过一行其实没用的」。
 *
 * * claude：{@link claudeSource} 的 `absorb` 第一件事就是要 `message.usage` 是个对
 *   象；没有 `usage` 这个键的行一个 token 都出不来。
 * * codex：要么是 `token_count` 的 payload，要么是某一处 `model` 声明——后者会被
 *   记进 `state.model` 给后面的事件用，所以不能只看 `token_count`。
 *
 * 判据是 JSON 里那个键**字面的**样子。理论上 `"usage"` 是同一个键而这里会漏
 * 掉它；两家 CLI 的序列化器都不会那么写，而代价（漏算）比反过来（把整份记录全解
 * 析一遍）小得多。
 */
const claudeSource: AgentCostSource = {
  agentId: "claude",
  roots: () => cliRoot("CLAUDE_CONFIG_DIR", ".claude", "projects"),
  needles: [Buffer.from('"usage"')],
  absorb(state, value, context) {
    const line = asRecord(value);
    const message = asRecord(line?.message);
    const usage = asRecord(message?.usage);
    if (usage === undefined) return;
    // `requestId` 是 CLI 自己的字段；`message.id` 是更老记录的兜底。两个都没有的
    // 行被计入——丢掉它比重复计更常见地少报。
    const identity =
      typeof line?.requestId === "string"
        ? line.requestId
        : typeof message?.id === "string"
          ? message.id
          : undefined;
    if (duplicate(context, identity)) return;
    const tokens: TokenTotals = {
      input: number(usage.input_tokens),
      output: number(usage.output_tokens),
      cacheRead: number(usage.cache_read_input_tokens),
      cacheCreation: number(usage.cache_creation_input_tokens),
    };
    if (isEmptyTokens(tokens)) return;
    const model =
      typeof message?.model === "string" && message.model !== ""
        ? message.model
        : "unknown";
    record(state, model, line?.timestamp, tokens, context.nowMs);
  },
};

const codexSource: AgentCostSource = {
  agentId: "codex",
  roots: () => cliRoot("CODEX_HOME", ".codex", "sessions"),
  needles: [Buffer.from('"model"'), Buffer.from('"token_count"')],
  absorb(state, value, context) {
    const line = asRecord(value);
    if (line === undefined) return;
    // 模型由会话元数据和每一轮的上下文宣布；先到的那个被记住，给后面的事件用。
    for (const path of [
      ["payload", "model"],
      ["payload", "info", "model"],
      ["payload", "turn_context", "model"],
      ["model"],
    ]) {
      let node: unknown = line;
      for (const key of path) node = asRecord(node)?.[key];
      if (typeof node === "string" && node !== "") {
        state.model = node;
        break;
      }
    }
    const payload = asRecord(line.payload);
    if (payload?.type !== "token_count") return;
    // `last_token_usage` 是这一轮的增量；`total_token_usage` 是累计的，用它会把这个
    // 会话的成本乘上它的轮数。
    const info = asRecord(payload.info) ?? payload;
    const last =
      asRecord(info.last_token_usage) ?? asRecord(info.lastTokenUsage);
    if (last === undefined) return;
    const cached =
      number(last.cached_input_tokens) + number(last.cachedInputTokens);
    const rawInput = number(last.input_tokens) + number(last.inputTokens);
    const tokens: TokenTotals = {
      // Codex 把缓存的 token 报在 input **里面**，和 Claude 那边分成两个桶不一样。
      // 减掉它让 input 仍然表示「按输入价计费的那部分」。
      input: Math.max(rawInput - cached, 0),
      output: number(last.output_tokens) + number(last.outputTokens),
      cacheRead: cached,
      cacheCreation: 0,
    };
    if (isEmptyTokens(tokens)) return;
    record(
      state,
      state.model ?? "unknown",
      line.timestamp,
      tokens,
      context.nowMs,
    );
  },
};

export const COST_SOURCES: Partial<Record<AgentId, AgentCostSource>> = {
  claude: claudeSource,
  codex: codexSource,
};

export function costSource(agentId: string): AgentCostSource | undefined {
  return COST_SOURCES[agentId as AgentId];
}
