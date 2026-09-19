/**
 * Provider payload → one normalized `AgentEvent` (contract §5.4).
 *
 * Every CLI reports something different: Claude and Codex send a flat object
 * keyed by `hook_event_name`, Copilot sends camelCase event names with its own
 * vocabulary, opencode sends a bus topic with a `properties` bag. The reducer
 * must not know any of that, so each provider gets a module here whose only
 * job is to answer one question: *what does this payload say about the node's
 * state?*
 *
 * Unknown events are not errors. A CLI is free to add hooks we never
 * subscribed to, and a client one revision ahead will send them; `undefined`
 * means "nothing to say", and the caller answers 204.
 */

/** Mirrors `agentEventKindSchema` in packages/shared. */
export type EventKind = "state" | "session" | "subagent-start" | "subagent-end";

export function isSubagent(kind: EventKind): boolean {
  return kind === "subagent-start" || kind === "subagent-end";
}

/** Mirrors `agentStateSchema`. */
export const WORKING = "working";
export const WAITING = "waiting";
export const BLOCKED = "blocked";
export const DONE = "done";

export type AgentState =
  | typeof WORKING
  | typeof WAITING
  | typeof BLOCKED
  | typeof DONE;

export type SessionPhase = "start" | "end";

/**
 * Twin of `agentEventSchema` (packages/shared/src/domain.ts). Field names and
 * omission rules match it exactly: absent optionals are omitted from the
 * serialized form, never sent as `null`.
 */
export interface AgentEvent {
  nodeId: string;
  agentId: string;
  kind: EventKind;
  state?: AgentState;
  /**
   * Which channel this report arrived on (协作通道 §3.2). Set by the ingest
   * route from the provider, never parsed out of the payload: an extension and
   * a command Hook post identical bodies, so a payload that could name its own
   * source could name the strongest one.
   */
  stateSource?: string;
  newTurn?: boolean;
  interrupted?: boolean;
  errored?: boolean;
  idle?: boolean;
  awaitingInput?: boolean;
  pendingId?: string;
  askKind?: string;
  sessionId?: string;
  sessionPhase?: SessionPhase;
  lastMessage?: string;
  toolUseId?: string;
  subagentType?: string;
  taskLabel?: string;
  durationMs?: number;
  tokens?: number;
  toolUses?: number;
  result?: string;
  verified?: boolean;
  clientRevision?: number;
  /**
   * Not part of the shared schema: where the CLI keeps this session's
   * transcript. The context-link verbs need it and only the hook knows.
   */
  transcriptPath?: string;
  /**
   * A synthetic end the user has nothing to read — today, a terminal that
   * exited. The terminal's own exit badge already says what happened, so
   * raising the unread badge on top of it would be noise.
   *
   * Never serialized: this is a reducer control, not part of the shared
   * `AgentEvent`, and no hook client can set it.
   */
  silent?: boolean;
  /**
   * A session start that the prompt already in flight created, rather than one
   * that precedes any work. Copilot CLI opens the session *from* the first
   * prompt and echoes that prompt back as `initialPrompt`, so its
   * `sessionStart` lands after the turn it belongs to has begun.
   *
   * Never serialized, for the same reason as `silent`.
   */
  sessionOpenedByPrompt?: boolean;
}

/** The two keys that never travel on the wire. */
const UNSERIALIZED = new Set(["silent", "sessionOpenedByPrompt"]);

/**
 * The event as the canvas sees it: absent optionals omitted, reducer controls
 * dropped.
 */
export function serializeEvent(event: AgentEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined || UNSERIALIZED.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function newEvent(
  nodeId: string,
  agentId: string,
  kind: EventKind,
): AgentEvent {
  return { nodeId, agentId, kind };
}

export function stateEvent(
  nodeId: string,
  agentId: string,
  state: AgentState,
): AgentEvent {
  return { nodeId, agentId, kind: "state", state };
}

export function sessionEvent(
  nodeId: string,
  agentId: string,
  phase: SessionPhase,
): AgentEvent {
  const event = newEvent(nodeId, agentId, "session");
  event.sessionPhase = phase;
  return event;
}

/* ------------------------- shared payload accessors ------------------------ */

export type Payload = unknown;

function asObject(payload: Payload): Record<string, unknown> | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

/**
 * Field lookup that tolerates both snake_case and camelCase. The CLIs are not
 * consistent with each other and some are not consistent with themselves
 * across versions; a report is worth more than a purity argument.
 */
export function field(
  payload: Payload,
  snake: string,
  camel: string,
): unknown | undefined {
  const object = asObject(payload);
  if (object === undefined) return undefined;
  const value = object[snake] ?? object[camel];
  return value === null ? undefined : value;
}

/**
 * The shared schema caps `lastMessage` / `result` at 20,000 characters; a
 * transcript tail can be far longer than that, so it is cut on a code-point
 * boundary before it ever reaches SQLite or a WebSocket frame.
 */
export function truncate(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit
    ? value
    : characters.slice(0, limit).join("");
}

export function text(
  payload: Payload,
  snake: string,
  camel: string,
): string | undefined {
  const value = field(payload, snake, camel);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : truncate(trimmed, 20_000);
}

export function number(
  payload: Payload,
  snake: string,
  camel: string,
): number | undefined {
  const value = field(payload, snake, camel);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

export function flag(
  payload: Payload,
  snake: string,
  camel: string,
): boolean | undefined {
  const value = field(payload, snake, camel);
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Common to Claude and Codex: the transcript and session identity ride along
 * on every event, whatever the event says.
 */
export function applyCommon(event: AgentEvent, payload: Payload): void {
  if (event.sessionId === undefined) {
    const id = text(payload, "session_id", "sessionId");
    if (id !== undefined) event.sessionId = truncate(id, 200);
  }
  if (event.transcriptPath === undefined) {
    event.transcriptPath = text(payload, "transcript_path", "transcriptPath");
  }
}
