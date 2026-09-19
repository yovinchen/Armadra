import type { DatabaseSync } from "node:sqlite";
import { readLines } from "../conversations/scan";
import { getAgentStatus } from "../agent/status";
import {
  type AgentSettings,
  baseAgent,
  hasCapability,
} from "../agent/registry";
import { locate } from "../collab/transcript";
import { loadNode } from "../collab/nodes";
import { forbidden, notFound } from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";

/**
 * How much of its context window one agent node has used.
 *
 * Ported from `apps/runtime/src/context_usage.rs`. Live observations only —
 * never cumulative billing totals, never a guess dressed as a measurement.
 *
 * Every answer carries a `source` and a `quality`, and the pair is the whole
 * point. There are exactly three sources and a client is expected to draw
 * them differently:
 *
 *   * `provider_hook` / `reported` — the CLI published a live window and this
 *     is what it said. Claude's status line, Pi's and Oh My Pi's in-process
 *     extension. A measurement.
 *   * `structured_transcript` / `estimated` — the CLI publishes nothing, but
 *     writes a transcript with token counts in it, so the number is a sum this
 *     core computed. Codex. An estimate, and labelled as one.
 *   * `unavailable` / `unknown` — nothing can be said, and `unknownReason`
 *     says which kind of nothing. Never a zero: "0 tokens used" and "we do not
 *     know" render identically on a progress bar and mean opposite things.
 *
 * The cache belongs to this core instance and is deliberately not persisted: a
 * reading is about a live session, and a number that survived a restart would
 * describe a session that no longer exists.
 */

const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;
const STALE_AFTER_MS = 5 * 60_000;
const MAX_ENTRIES = 4096;

export type UsageSource =
  | "provider_hook"
  | "structured_transcript"
  | "unavailable";

export type UsageQuality = "reported" | "estimated" | "stale" | "unknown";

export interface ContextUsage {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly providerSessionId: string | null;
  readonly modelId: string | null;
  readonly usedTokens: number | null;
  readonly capacityTokens: number | null;
  readonly reservedOutputTokens: number | null;
  readonly observedAt: string | null;
  /**
   * Monotonic age at serialisation. Clients add elapsed local time; they never
   * subtract their own wall clock from this core's display timestamp.
   */
  readonly ageMs: number;
  readonly source: UsageSource;
  readonly quality: UsageQuality;
  readonly sourceRevision: string | null;
  readonly compactionEpoch: number;
  readonly unknownReason: string | null;
  /** Only present on an estimated reading; absent on a reported one. */
  readonly estimate?: Record<string, unknown>;
}

export function unknownUsage(
  nodeId: string,
  sessionId: string,
  generation: number,
  reason: string,
): ContextUsage {
  return {
    nodeId,
    sessionId,
    generation,
    providerSessionId: null,
    modelId: null,
    usedTokens: null,
    capacityTokens: null,
    reservedOutputTokens: null,
    observedAt: null,
    ageMs: 0,
    source: "unavailable",
    quality: "unknown",
    sourceRevision: null,
    compactionEpoch: 0,
    unknownReason: reason,
  };
}

/**
 * One report from a CLI. The client filters its own input before sending it;
 * session identity and generation are checked against the live PTY before the
 * cache accepts it.
 */
export interface ContextReport {
  readonly sessionId: string;
  readonly generation: number;
  readonly sourceRevision: string;
  readonly data: Record<string, unknown>;
}

interface Entry {
  readonly received: number;
  readonly revision: number;
  readonly snapshot: ContextUsage;
}

export class ContextUsageCache {
  private readonly entries = new Map<string, Entry>();

  /**
   * Accepts one report, or says why not.
   *
   * `false` for malformed data, a duplicate revision, or a delayed old
   * observation. The caller must have authenticated and verified the live
   * binding first — this only defends against *stale*, not against forged.
   */
  report(nodeId: string, report: ContextReport, nowMs: number): boolean {
    const parsed = parseReport(nodeId, report, nowMs);
    if (parsed === undefined) return false;
    const revision = Number.parseInt(report.sourceRevision, 10);
    if (!Number.isFinite(revision)) return false;
    let snapshot = parsed;
    const previous = this.entries.get(nodeId);
    if (
      previous !== undefined &&
      previous.snapshot.sessionId === report.sessionId
    ) {
      if (previous.snapshot.generation > report.generation) return false;
      if (previous.snapshot.generation === report.generation) {
        if (previous.revision >= revision) return false;
        if (
          previous.snapshot.providerSessionId === snapshot.providerSessionId &&
          previous.snapshot.modelId === snapshot.modelId
        ) {
          let epoch = previous.snapshot.compactionEpoch;
          // The provider explicitly clears `current_usage` after a compaction.
          // Nothing is inferred from a mere reduction in token count: a smaller
          // number is a normal turn, not evidence of anything.
          const window = asRecord(report.data.context_window);
          if (
            previous.snapshot.usedTokens !== null &&
            snapshot.usedTokens === null &&
            window !== undefined &&
            window.current_usage === null
          ) {
            epoch += 1;
          }
          snapshot = { ...snapshot, compactionEpoch: epoch };
        }
      }
    }
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(nodeId)) {
      let oldest: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.received < oldestAt) {
          oldestAt = entry.received;
          oldest = key;
        }
      }
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(nodeId, { received: Date.now(), revision, snapshot });
    return true;
  }

  snapshot(
    nodeId: string,
    sessionId: string,
    generation: number,
  ): ContextUsage {
    const entry = this.entries.get(nodeId);
    if (entry === undefined) {
      return unknownUsage(nodeId, sessionId, generation, "awaiting_report");
    }
    if (
      entry.snapshot.sessionId !== sessionId ||
      entry.snapshot.generation !== generation
    ) {
      return unknownUsage(nodeId, sessionId, generation, "session_changed");
    }
    const ageMs = Math.min(MAX_SAFE_COUNT, Date.now() - entry.received);
    const quality: UsageQuality =
      entry.snapshot.quality !== "unknown" && ageMs > STALE_AFTER_MS
        ? "stale"
        : entry.snapshot.quality;
    return { ...entry.snapshot, ageMs, quality };
  }

  clear(nodeId: string): void {
    this.entries.delete(nodeId);
  }

  /** For the tests: pretend this node's reading arrived `ms` ago. */
  age(nodeId: string, ms: number): void {
    const entry = this.entries.get(nodeId);
    if (entry === undefined) return;
    this.entries.set(nodeId, { ...entry, received: entry.received - ms });
  }
}

/**
 * Which providers hand this core a measured window instead of a transcript to
 * add up.
 *
 * Claude reports one through its status line; Pi and Oh My Pi report one from
 * inside the CLI process. All three send the same envelope — one already
 * summed count in the first of the three disjoint buckets, a capacity, and a
 * null `current_usage` when the reading no longer describes the session — so
 * all three read `provider_hook` / `reported`. That is the whole point: the
 * number is measured, not guessed.
 */
export function reportsALiveWindow(provider: string): boolean {
  return provider === "claude" || provider === "pi" || provider === "omp";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  if (typeof value !== "string" || value === "" || value.length > 200) {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  return /[ -]/.test(value) ? undefined : value;
}

function count(
  source: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 0 && value <= MAX_SAFE_COUNT ? value : undefined;
}

export function parseReport(
  nodeId: string,
  report: ContextReport,
  nowMs: number,
): ContextUsage | undefined {
  const revision = Number.parseInt(report.sourceRevision, 10);
  if (
    report.sessionId === "" ||
    report.sessionId.length > 200 ||
    report.generation > MAX_SAFE_COUNT ||
    !Number.isFinite(revision) ||
    revision <= 0 ||
    String(revision) !== report.sourceRevision.trim()
  ) {
    return undefined;
  }
  const providerSession = text(report.data, "session_id");
  if (providerSession === undefined) return undefined;
  const model = text(asRecord(report.data.model), "id");
  if (model === undefined) return undefined;
  const window = asRecord(report.data.context_window);
  if (window === undefined) return undefined;
  const rawCapacity = window.context_window_size;
  const capacity =
    typeof rawCapacity === "number" &&
    Number.isInteger(rawCapacity) &&
    rawCapacity > 0 &&
    rawCapacity <= MAX_SAFE_COUNT
      ? rawCapacity
      : null;
  const hasUsageKey = Object.prototype.hasOwnProperty.call(
    window,
    "current_usage",
  );
  const current = asRecord(window.current_usage);
  let used: number | null = null;
  if (window.current_usage !== null && window.current_usage !== undefined) {
    if (current === undefined) return undefined;
    // These categories are disjoint. Do not add `total_input_tokens`,
    // `output_tokens`, cost, rate limits, or prompt-cache session totals.
    const input = count(current, "input_tokens");
    const creation = count(current, "cache_creation_input_tokens");
    const read = count(current, "cache_read_input_tokens");
    if (input === undefined || creation === undefined || read === undefined) {
      return undefined;
    }
    const total = input + creation + read;
    if (total > MAX_SAFE_COUNT) return undefined;
    used = total;
  }
  return {
    nodeId,
    sessionId: report.sessionId,
    generation: report.generation,
    providerSessionId: providerSession,
    modelId: model,
    usedTokens: used,
    capacityTokens: capacity,
    reservedOutputTokens: null,
    observedAt: new Date(nowMs).toISOString(),
    ageMs: 0,
    source: "provider_hook",
    quality: used === null ? "unknown" : "reported",
    sourceRevision: report.sourceRevision,
    compactionEpoch: 0,
    unknownReason:
      used === null
        ? hasUsageKey
          ? "awaiting_response"
          : "source_unavailable"
        : null,
  };
}

/* --------------------------------- the read -------------------------------- */

export interface ContextQuery {
  readonly sessionId: string;
  readonly generation: number;
  /**
   * The model the node was launched with, used only as the denominator's
   * fallback when the transcript itself does not name one. A hint, never an
   * override: a transcript that says which model answered wins, which is what
   * keeps the ratio honest after a mid-session model switch.
   */
  readonly modelId?: string;
}

export interface ContextUsageDeps {
  readonly database: DatabaseSync;
  readonly settings: AgentSettings;
  readonly cache: ContextUsageCache;
  /** Whether this really is the session the node is running right now. */
  readonly isCurrentNodeSession?: (
    nodeId: string,
    sessionId: string,
    generation: number,
  ) => Promise<boolean>;
}

/** `GET /api/workspaces/{id}/nodes/{nodeId}/context-usage`. */
export async function contextUsage(
  deps: ContextUsageDeps,
  workspaceId: string,
  nodeId: string,
  query: ContextQuery,
): Promise<ContextUsage> {
  const workspace = getWorkspace(deps.database, workspaceId);
  if (!workspace.permissions.read) {
    throw forbidden("Workspace read permission is required");
  }
  const row = deps.database
    .prepare(
      "SELECT id, workspace_id, owner_node_id, agent_id, generation FROM terminal_sessions WHERE id = ?",
    )
    .get(query.sessionId) as
    | {
        id: string;
        workspace_id: string;
        owner_node_id: string | null;
        agent_id: string | null;
        generation: number;
      }
    | undefined;
  if (row === undefined) throw notFound("Terminal session was not found");
  const node = loadNode(deps.database, nodeId);
  if (node === undefined) throw notFound("Context node was not found");
  if (row.workspace_id !== workspaceId || row.owner_node_id !== nodeId) {
    throw notFound("Context session was not found in this workspace");
  }
  if (node.workspaceId !== workspaceId) {
    throw notFound("Context node was not found in this workspace");
  }
  const unknown = (reason: string): ContextUsage =>
    unknownUsage(nodeId, query.sessionId, query.generation, reason);
  if (node.agentId !== row.agent_id) return unknown("session_changed");
  if (row.generation < 0 || Number(row.generation) !== query.generation) {
    return unknown("session_changed");
  }
  if (deps.isCurrentNodeSession !== undefined) {
    const current = await deps.isCurrentNodeSession(
      nodeId,
      row.id,
      query.generation,
    );
    if (!current) return unknown("session_ended");
  }
  const agentId = row.agent_id;
  if (agentId === null) return unknown("unsupported");
  if (!hasCapability(deps.settings, agentId, "contextUsage")) {
    return unknown("unsupported");
  }
  // Only a provider that publishes a live window is answered from the cache;
  // everything else that declares the capability is read from its structured
  // transcript.
  const provider = baseAgent(deps.settings, agentId);
  if (reportsALiveWindow(provider)) {
    return deps.cache.snapshot(nodeId, row.id, query.generation);
  }
  return estimatedSnapshot(deps, nodeId, provider, query);
}

/**
 * A `structured_transcript` reading.
 *
 * Every step can decline, and declining produces an explicit unknown rather
 * than a zero: no status row, no locatable transcript, nothing readable inside
 * it. The capacity stays `null` for a model this build does not recognise, so
 * an unknown denominator shows as unknown rather than as a percentage of a
 * guessed window.
 */
function estimatedSnapshot(
  deps: ContextUsageDeps,
  nodeId: string,
  provider: string,
  query: ContextQuery,
): ContextUsage {
  const unknown = (reason: string): ContextUsage =>
    unknownUsage(nodeId, query.sessionId, query.generation, reason);
  const status = getAgentStatus(deps.database, nodeId);
  const located = locate(provider, status?.transcriptPath, status?.sessionId);
  if (located === undefined) return unknown("source_unavailable");
  const estimate = estimateFromTranscript(located.path);
  if (estimate === undefined) return unknown("source_unavailable");
  const modelId =
    estimate.modelId ??
    (query.modelId !== undefined && query.modelId !== ""
      ? query.modelId
      : null);
  return {
    nodeId,
    sessionId: query.sessionId,
    generation: query.generation,
    providerSessionId: estimate.providerSessionId ?? status?.sessionId ?? null,
    modelId,
    usedTokens: estimate.usedTokens,
    capacityTokens: contextCapacity(modelId),
    reservedOutputTokens: null,
    observedAt: new Date().toISOString(),
    ageMs: 0,
    source: "structured_transcript",
    quality: "estimated",
    // The file's own identity is the revision: a transcript that has not grown
    // is the same observation, not a newer one.
    sourceRevision: null,
    // Compaction is not observable in a transcript that keeps every turn.
    compactionEpoch: 0,
    unknownReason: null,
    estimate: {
      method: "structuredTokenCounts",
      turns: estimate.turns,
    },
  };
}

interface TranscriptEstimate {
  readonly usedTokens: number;
  readonly turns: number;
  readonly modelId: string | null;
  readonly providerSessionId: string | null;
}

/**
 * Adds up the per-turn token counts a codex rollout records.
 *
 * The *last* usage record wins rather than the sum of every turn: a rollout
 * reports the running window, so adding the turns up would count the same
 * prompt once per turn and produce a number several times the real one.
 */
export function estimateFromTranscript(
  path: string,
): TranscriptEstimate | undefined {
  const lines = readLines(path, 2 * 1024 * 1024, 4_000);
  let usedTokens: number | undefined;
  let turns = 0;
  let modelId: string | null = null;
  let providerSessionId: string | null = null;
  for (const line of lines) {
    if (line === "") continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object") continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = asRecord(record.payload) ?? record;
    if (record.type === "session_meta") {
      const id = payload.id;
      if (typeof id === "string") providerSessionId = id;
    }
    const model = payload.model;
    if (typeof model === "string" && model !== "") modelId = model;
    const info = asRecord(payload.info) ?? asRecord(payload.usage);
    const total = asRecord(info?.total_token_usage) ?? info;
    const input = count(total, "input_tokens");
    const cached = count(total, "cached_input_tokens") ?? 0;
    const output = count(total, "output_tokens") ?? 0;
    if (input !== undefined) {
      usedTokens = input + cached + output;
      turns += 1;
    }
  }
  if (usedTokens === undefined) return undefined;
  return { usedTokens, turns, modelId, providerSessionId };
}

/**
 * The context window of a model this build recognises, or `null`.
 *
 * Deliberately short and deliberately not a default. A model nobody listed
 * here has an unknown denominator, and "unknown" is the honest answer: a
 * guessed window would turn a correct numerator into a wrong percentage.
 */
export function contextCapacity(modelId: string | null): number | null {
  if (modelId === null) return null;
  const id = modelId.toLowerCase();
  if (id.includes("gpt-5") || id.includes("o3") || id.includes("o4")) {
    return 400_000;
  }
  if (id.includes("gpt-4.1")) return 1_047_576;
  if (id.includes("gpt-4o")) return 128_000;
  return null;
}
