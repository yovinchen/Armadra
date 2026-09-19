/**
 * Model context windows — the *denominator* of a context-usage reading.
 *
 * docs/design/agent-automation-design.md §2.1: "分母来自该会话实际模型与配置的上下文
 * 上限；无法确认模型或上限时显示未知." So this table only carries windows the
 * vendor documents, every entry is matched against the model id the session
 * actually reports, and an id nobody here recognises returns `null` rather than
 * a plausible-looking guess. A wrong denominator is worse than an honest
 * unknown: it turns a 20 % reading into a 95 % warning, or hides a real one.
 *
 * The runtime mirrors this table in `apps/runtime/src/context_models.rs`. Both
 * sides carry the same cases in their tests; a model added here needs adding
 * there too, or the runtime will report an unknown capacity the client would
 * have recognised.
 */

/** One rule: a matcher over the normalised model id and the window it implies. */
interface Window {
  readonly match: RegExp;
  readonly capacityTokens: number;
}

/**
 * Matched in order, most specific first. Ids are lower-cased and stripped of a
 * provider prefix (`anthropic/claude-…`, `openai/gpt-5`) before matching, which
 * is how routers and the CLIs' own `--model` values differ from each other.
 */
const WINDOWS: readonly Window[] = [
  // Anthropic. The long-context variant is opt-in and carries its own suffix,
  // so it has to win over the plain family match below.
  { match: /^claude\b.*\[1m\]|-1m\b/, capacityTokens: 1_000_000 },
  { match: /^(claude\b.*)?\b(opus|sonnet|haiku)\b/, capacityTokens: 200_000 },
  { match: /^claude\b/, capacityTokens: 200_000 },

  // OpenAI / Codex.
  { match: /^gpt-5|^codex\b|-codex\b/, capacityTokens: 400_000 },
  { match: /^gpt-4\.1/, capacityTokens: 1_047_576 },
  { match: /^gpt-4o/, capacityTokens: 128_000 },
  { match: /^o[134]\b|^o[134]-/, capacityTokens: 200_000 },
];

/** Strip a router prefix and normalise case: `Anthropic/Claude-Opus-4` → `claude-opus-4`. */
export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Documented context window for a model id, or `null` when this table cannot
 * vouch for one. Callers must render `null` as "unknown", never as a percentage.
 */
export function modelContextCapacity(
  modelId: string | null | undefined,
): number | null {
  if (!modelId) return null;
  const id = normalizeModelId(modelId);
  if (!id) return null;
  return (
    WINDOWS.find((window) => window.match.test(id))?.capacityTokens ?? null
  );
}

/* --------------------------- character estimator -------------------------- */

/**
 * How the runtime turns transcript text into an approximate token count, and
 * how confident it is in the answer. Mirrors
 * `apps/runtime/src/context_estimate.rs`; the UI renders it verbatim so a
 * reader can tell an estimate from a measurement.
 */
export const ESTIMATE_CONFIDENCES = ["low", "medium"] as const;
export type EstimateConfidence = (typeof ESTIMATE_CONFIDENCES)[number];

/**
 * The heuristic identifier the runtime stamps on an estimate. Bumped whenever
 * the arithmetic changes, so an old cached reading is never presented as if it
 * came from the current estimator.
 */
export const CHARACTER_ESTIMATOR = "chars-v1";

/**
 * Reference implementation of `chars-v1`, kept here so the tests can state the
 * rule once for both sides:
 *
 *   * an ASCII run costs one token per four characters — the ratio every major
 *     BPE tokenizer lands near for English prose and source code;
 *   * a non-ASCII character costs one token — CJK, emoji and accented text sit
 *     between 0.6 and 1.5 tokens per character, so one is the honest middle.
 *
 * It is deliberately *not* a tokenizer. The reading it feeds is published as
 * `quality: "estimated"` with this identifier attached, never as `reported`.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}
