import { z } from "zod";

import { ESTIMATE_CONFIDENCES } from "./model-context.js";

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

/**
 * Present only on a `structured_transcript` / `tokenizer_estimate` reading, and
 * the reason such a reading may still be shown: it says which heuristic
 * produced the number and how far it can be trusted, so the popover can label
 * it rather than passing an approximation off as a measurement.
 */
export const contextEstimateSchema = z.object({
  /** Heuristic identifier, e.g. `chars-v1` (see `model-context.ts`). */
  heuristic: z.string().min(1).max(64),
  confidence: z.enum(ESTIMATE_CONFIDENCES),
  /** Transcript bytes the estimate was computed over. */
  sampledBytes: count,
  /** The transcript was longer than the read budget, so the sum is a floor. */
  truncated: z.boolean(),
  /** Transcript messages the estimate summed. */
  messages: count,
});
export type ContextEstimate = z.infer<typeof contextEstimateSchema>;

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
  /** Absent on a provider-reported reading; see `contextEstimateSchema`. */
  estimate: contextEstimateSchema.nullish(),
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

/* ------------------------------- thresholds ------------------------------- */

/**
 * Reminder thresholds (design §2.2: "80%/95% 为初始提醒阈值，可设置"). They
 * change what the badge *says*; nothing here compacts, clears or interrupts a
 * session, and an unknown reading never crosses a threshold.
 */
export interface ContextThresholds {
  readonly warnPercent: number;
  readonly dangerPercent: number;
}

export const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds = {
  warnPercent: 80,
  dangerPercent: 95,
};

/** Both bounds are percentages, and danger is never below warn. */
export function normalizeContextThresholds(
  thresholds: Partial<ContextThresholds> | null | undefined,
): ContextThresholds {
  const clamp = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(100, Math.max(1, Math.round(value)))
      : fallback;
  const warnPercent = clamp(
    thresholds?.warnPercent,
    DEFAULT_CONTEXT_THRESHOLDS.warnPercent,
  );
  return {
    warnPercent,
    dangerPercent: Math.max(
      warnPercent,
      clamp(
        thresholds?.dangerPercent,
        DEFAULT_CONTEXT_THRESHOLDS.dangerPercent,
      ),
    ),
  };
}

export type ContextLevel = "normal" | "warn" | "danger";

/** `null` for a reading with no percentage: unknown is not "normal". */
export function contextLevel(
  percentage: number | null,
  thresholds: ContextThresholds,
): ContextLevel | null {
  if (percentage === null) return null;
  if (percentage >= thresholds.dangerPercent) return "danger";
  if (percentage >= thresholds.warnPercent) return "warn";
  return "normal";
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
