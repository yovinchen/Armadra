import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../bus";
import { baseAgent, hasCapability } from "./capabilities";
import type { AgentEvent } from "./normalize";
import { normalizeAs, serializeEvent } from "./normalize";
import { type Current, emptyCurrent, reduce } from "./reduce";
import type { HookService } from "./service";
import {
  type AgentStatusRow,
  answerApproval,
  findNodeOwner,
  getAgentStatus,
  insertApproval,
  stateSourceFor,
  upsertAgentStatus,
} from "./store";
import { validAgentId } from "../settings/custom-agents";
import { validNodeId } from "./auth";

/**
 * `POST /hook/{agentId}` — the one route every CLI's hooks reach.
 *
 * The contract is deliberately blunt, because the caller is a fire-and-forget
 * client with a 1.5s deadline that must never slow a turn down:
 *
 *   * **204** on anything we accepted, including a payload we did not
 *     understand and a node we have never heard of. A hook that got a 4xx
 *     would print an error into the user's terminal for no benefit.
 *   * **403** only for the two cases that mean something is wrong with the
 *     caller rather than the payload: a bad app bearer, and a node token that
 *     was minted with our key id but the wrong MAC.
 *   * **400** only for a body we cannot parse at all.
 *
 * Everything else — an unknown event, a `{"raw": "..."}` wrapper around
 * non-JSON stdin, an event for a node with no workspace — is silently dropped.
 */

export const HOOK_TOKEN_HEADER = "x-armadra-hook-token";
export const NODE_TOKEN_HEADER = "x-armadra-node-token";
export const CLIENT_REVISION_HEADER = "x-armadra-hook-client";

/** The envelope the hook client posts; `payload` is the CLI's stdin, untouched. */
export interface HookRequest {
  readonly nodeId?: unknown;
  readonly version?: unknown;
  readonly payload?: unknown;
  readonly pendingId?: unknown;
  /**
   * Set on the *second* post of a permission round trip: the client has
   * already printed this decision back to the CLI (contract §5.5).
   */
  readonly answered?: unknown;
  readonly terminalBinding?: unknown;
}

export interface TerminalBinding {
  readonly sessionId: string;
  readonly generation: number;
  readonly sourceRevision: string;
}

function readBinding(raw: unknown): TerminalBinding | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const value = raw as Record<string, unknown>;
  // `deny_unknown_fields` on the Rust side: a binding with a key we do not
  // know is a client we do not know, and the report is dropped rather than
  // half-read.
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    typeof value.sessionId !== "string" ||
    typeof value.generation !== "number" ||
    typeof value.sourceRevision !== "string"
  ) {
    return "invalid";
  }
  return {
    sessionId: value.sessionId,
    generation: value.generation,
    sourceRevision: value.sourceRevision,
  };
}

/** What the ingest handler needs from the rest of the core. */
export interface IngestContext {
  readonly database: DatabaseSync;
  readonly bus: EventBus;
  readonly hooks: HookService;
  readonly log: {
    warn(message: string, detail?: unknown): void;
    debug(message: string, detail?: unknown): void;
  };
  /** Wall clock, injectable so the reducer's windows can be driven in tests. */
  readonly now?: () => Date;
}

/** The answer an ingest produces, in the shape the hook router sends. */
export interface IngestResult {
  readonly status: number;
  readonly body?: { readonly code: string; readonly message: string };
}

const ACCEPTED: IngestResult = { status: 204 };

export function ingest(
  context: IngestContext,
  pathAgentId: string,
  request: HookRequest,
  headers: Readonly<Record<string, string | undefined>>,
): IngestResult {
  const nodeId = typeof request.nodeId === "string" ? request.nodeId : "";
  if (!validNodeId(nodeId)) {
    // Not a 400: a malformed id is a broken client, and a broken client must
    // not make the CLI print anything.
    context.log.debug("hook report with an unusable node id", { nodeId });
    return ACCEPTED;
  }
  const verdict = context.hooks.verdict(nodeId, headers[NODE_TOKEN_HEADER]);
  if (verdict === "forged") {
    return {
      status: 403,
      body: {
        code: "forbidden",
        message:
          "The node token was minted by this core but does not match the node",
      },
    };
  }

  const owner = findNodeOwner(context.database, nodeId);
  if (owner === undefined) {
    // A node the canvas never created, or one that has been deleted. The CLI
    // is still running; there is simply nothing to attribute this to.
    context.log.debug("hook report for an unknown node", { nodeId });
    return ACCEPTED;
  }

  // The path names the provider whose hook fired; the session's own agent id
  // is the fallback for a client invoked without one.
  let provider = validAgentId(pathAgentId)
    ? pathAgentId
    : (owner.agentId ?? "claude");
  // A custom agent has no hooks of its own: the installed hook line runs
  // `armadra-hook <base>`, so the path says `claude` while the node is
  // `custom:…`. The node wins for attribution and its configured base picks
  // the parser (contract §24.1).
  let agentId = provider;
  if (owner.agentId?.startsWith("custom:") === true) {
    agentId = owner.agentId;
    provider = baseAgent(owner.agentId);
  }

  const binding = readBinding(request.terminalBinding);
  if (binding === "invalid") return ACCEPTED;
  if (binding !== undefined) {
    const revision = Number(binding.sourceRevision);
    const usable =
      verdict === "verified" &&
      /^\d+$/.test(binding.sourceRevision) &&
      Number.isFinite(revision) &&
      revision > 0 &&
      isCurrentNodeSession(context.database, nodeId, binding, agentId);
    if (!usable) return ACCEPTED;
  }

  const payload = request.payload ?? null;
  if (!hasCapability(agentId, "hooks")) return ACCEPTED;

  const event = normalizeAs(provider, agentId, nodeId, payload);
  if (event === undefined) return ACCEPTED;

  event.verified = verdict === "verified";
  // Derived from the provider, not read out of the body. An in-process
  // extension and a forked hook client post the same JSON with the same
  // headers, so a payload that could name its own channel could name the
  // strongest one (协作通道 §3.2).
  event.stateSource = stateSourceFor(provider);
  const revisionHeader = Number(headers[CLIENT_REVISION_HEADER]);
  if (Number.isInteger(revisionHeader)) event.clientRevision = revisionHeader;
  // The envelope's pendingId is authoritative: only the client knows which
  // file it wrote the request to.
  if (typeof request.pendingId === "string" && request.pendingId !== "") {
    event.pendingId = request.pendingId;
  }

  if (typeof request.answered === "string") {
    recordAnswer(context, event, request.answered);
  }

  apply(context, owner.workspaceId, agentId, event, payload);
  return ACCEPTED;
}

/**
 * Whether this binding names the terminal session the node is actually
 * running, and one that belongs to this agent.
 *
 * The Rust route asks the live terminal manager; the same question is
 * answerable from the row, which is what keeps the hook surface independent of
 * whether a backend is attached at this instant.
 */
function isCurrentNodeSession(
  database: DatabaseSync,
  nodeId: string,
  binding: TerminalBinding,
  agentId: string,
): boolean {
  const row = database
    .prepare(
      "SELECT agent_id, generation, status FROM terminal_sessions " +
        "WHERE id = ? AND owner_node_id = ?",
    )
    .get(binding.sessionId, nodeId) as Record<string, unknown> | undefined;
  if (row === undefined) return false;
  return (
    Number(row.generation) === binding.generation &&
    row.agent_id === agentId &&
    row.status === "running"
  );
}

/** Reduce → persist → publish. Split out so the sweep can reuse it. */
export function apply(
  context: IngestContext,
  workspaceId: string,
  agentId: string,
  event: AgentEvent,
  rawPayload: unknown,
): AgentStatusRow | undefined {
  if (event.kind === "subagent-start" || event.kind === "subagent-end") {
    if (!hasCapability(agentId, "subagent")) return undefined;
    // A subagent card is transient canvas state: published, never stored.
    context.bus.emit("workspace.event", {
      workspaceId,
      event: { type: "agent.subagent", event: serializeEvent(event) },
    });
    return undefined;
  }

  const existing = getAgentStatus(context.database, event.nodeId);
  const current: Current =
    existing === undefined
      ? emptyCurrent()
      : {
          state: existing.state,
          unread: existing.unread,
          sessionId: existing.sessionId,
          pendingId: existing.pendingId,
          stateSource: existing.stateSource,
          transcriptPath: existing.transcriptPath,
          sessionPhase: existing.sessionPhase,
          errored: existing.errored,
          interrupted: existing.interrupted,
          restored: existing.restored,
        };

  const now = (context.now ?? (() => new Date()))();
  const next = context.hooks.withMemory(event.nodeId, (memory) =>
    reduce(now.getTime(), current, memory, event),
  );
  if (next === undefined) return undefined;

  const approval = next.state === "blocked" ? next.pendingId : undefined;
  const status = upsertAgentStatus(
    context.database,
    {
      nodeId: event.nodeId,
      workspaceId,
      agentId,
      state: next.state,
      stateSource: next.stateSource,
      unread: next.unread,
      sessionId: next.sessionId,
      pendingId: next.pendingId,
      verified: event.verified ?? false,
      transcriptPath: next.transcriptPath,
      sessionPhase: next.sessionPhase,
      errored: next.errored,
      interrupted: next.interrupted,
      lastEventAt: now.toISOString(),
    },
    now.toISOString(),
  );
  // Not a column: the message travels with the published copy only.
  const published: AgentStatusRow = {
    ...status,
    ...(next.lastMessage === undefined
      ? {}
      : { lastMessage: next.lastMessage }),
  };

  if (approval !== undefined) {
    // The raw hook payload is the audit record — it is what the CLI asked, in
    // the CLI's own words.
    try {
      const record = insertApproval(
        context.database,
        approval,
        event.nodeId,
        workspaceId,
        rawPayload,
        now.toISOString(),
      );
      context.bus.emit("workspace.event", {
        workspaceId,
        event: {
          type: "agent.approval",
          nodeId: event.nodeId,
          pendingId: approval,
          request: record,
        },
      });
    } catch (error) {
      context.log.warn("could not record the pending approval", { error });
    }
  }

  context.bus.emit("workspace.event", {
    workspaceId,
    event: {
      type: "agent.status",
      status: published as unknown as Readonly<Record<string, unknown>>,
    },
  });
  return published;
}

/**
 * The client already answered the CLI; we only close the audit record. A
 * double answer is expected (the user's own POST got there first) and is not
 * an error worth surfacing.
 */
function recordAnswer(
  context: IngestContext,
  event: AgentEvent,
  decision: string,
): void {
  if (event.pendingId === undefined) return;
  const outcome = answerApproval(
    context.database,
    event.pendingId,
    decision,
    "hook",
  );
  if (!outcome.ok && outcome.reason === "bad_request") {
    context.log.warn("could not record the hook's approval answer", {
      message: outcome.message,
    });
  }
}
