import { z } from "zod";

/** Current context observations are distinct from cumulative billing usage. */
export const contextQualitySchema = z.enum([
  "reported",
  "estimated",
  "stale",
  "unknown",
]);
export const contextSourceSchema = z.enum([
  "provider_hook",
  "structured_transcript",
  "tokenizer_estimate",
  "unavailable",
]);
export const contextUnknownReasonSchema = z.enum([
  "unsupported",
  "awaiting_report",
  "awaiting_response",
  "session_changed",
  "session_ended",
  "source_unavailable",
]);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const contextUsageSchema = z.object({
  nodeId: z.string().min(1),
  sessionId: z.string().min(1),
  generation: count,
  providerSessionId: z.string().nullable(),
  modelId: z.string().nullable(),
  usedTokens: count.nullable(),
  capacityTokens: count.positive().nullable(),
  reservedOutputTokens: count.nullable(),
  observedAt: z.iso.datetime({ offset: true }).nullable(),
  ageMs: count,
  source: contextSourceSchema,
  quality: contextQualitySchema,
  sourceRevision: z.string().nullable(),
  compactionEpoch: count,
  unknownReason: contextUnknownReasonSchema.nullable(),
});
export type ContextUsage = z.infer<typeof contextUsageSchema>;
export type ContextQuality = z.infer<typeof contextQualitySchema>;

/** A missing/unknown observation never becomes a zero-percent progress bar. */
export function contextPercentage(usage: ContextUsage): number | null {
  if (
    usage.quality === "unknown" ||
    usage.usedTokens === null ||
    usage.capacityTokens === null ||
    usage.capacityTokens <= 0
  ) {
    return null;
  }
  return (usage.usedTokens / usage.capacityTokens) * 100;
}

/** Aging changes presentation only; it must not invent a newer observation. */
export const CONTEXT_STALE_AFTER_MS = 5 * 60_000;
export function ageContextUsage(
  usage: ContextUsage,
  elapsedSinceReceiptMs = 0,
): ContextUsage {
  if (
    usage.quality !== "unknown" &&
    usage.quality !== "stale" &&
    usage.ageMs + Math.max(0, elapsedSinceReceiptMs) > CONTEXT_STALE_AFTER_MS
  ) {
    return { ...usage, quality: "stale" };
  }
  return usage;
}
