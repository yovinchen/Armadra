import {
  create,
  fromBinary,
  toBinary,
  AcceptHandoffRequestSchema,
  AcceptHandoffResponseSchema,
  AgentState,
  AnswerApprovalRequestSchema,
  AnswerApprovalResponseSchema,
  ApprovalState,
  CancelHandoffRequestSchema,
  CancelHandoffResponseSchema,
  DeliveryOutcome,
  GetHandoffRequestSchema,
  GetHandoffResponseSchema,
  HandoffState,
  CaptureAgentScreenCommandSchema,
  CaptureAgentScreenCommandResponseSchema,
  InstallHooksRequestSchema,
  InstallHooksResponseSchema,
  ReadAgentTranscriptRequestSchema,
  ReadAgentTranscriptResponseSchema,
  ListAgentStatusRequestSchema,
  ListAgentStatusResponseSchema,
  ListApprovalsRequestSchema,
  ListApprovalsResponseSchema,
  ListContextLinksRequestSchema,
  ListContextLinksResponseSchema,
  ListDeliveriesRequestSchema,
  ListDeliveriesResponseSchema,
  ListHandoffsRequestSchema,
  ListHandoffsResponseSchema,
  ListMailboxRequestSchema,
  ListMailboxResponseSchema,
  MarkAgentReadRequestSchema,
  MarkAgentReadResponseSchema,
  PrepareHandoffRequestSchema,
  PrepareHandoffResponseSchema,
  UninstallHooksRequestSchema,
  UninstallHooksResponseSchema,
  type Approval,
  type AgentStatus,
  type ContextLinks,
  type Delivery,
  type Handoff,
  type HookInstallState,
  type MailboxMessage,
} from "@armadra/protocol";
import type { HostAuthenticatedTransport } from "./automation.js";
import { classifyCanvasFailure, HostCanvasError } from "./canvas.js";

const SERVICE = "AgentService";

/**
 * What each agent node is doing, and the decisions somebody takes about it
 * (Go Host 业务所有权迁移 §2.7).
 *
 * This client runs no CLI and reads no transcript. What it reaches is the
 * record half of the domain: the reduced state of each node, the permission
 * questions a CLI has stopped on, the messages nodes have left each other, the
 * receipts of what was actually delivered, and where each handoff stands.
 *
 * Two shapes recur, and both are deliberate.
 *
 * An approval's `request` and a handoff's `bundle` are bytes. They are one
 * provider's own JSON and a snapshot of a conversation; the Host stores them
 * with their digests and hands them back unchanged, and a client that wants to
 * render one decodes it itself. Typing them here would make a new CLI a wire
 * change for everybody.
 *
 * And `decision` is a string, not an enum. It is the CLI's own word — `allow`,
 * `deny`, `allow_always` — and mapping it would be this client deciding what a
 * provider meant.
 */

/** The reduced state of one node, as `hook/reduce.rs` computed it. */
export type AgentStateName =
  | "idle"
  | "working"
  | "waiting"
  /** The CLI cannot proceed until a question is answered. */
  | "blocked"
  | "done";

export type ApprovalStateName = "pending" | "answered" | "expired";

/**
 * What became of one attempt to put something in front of an agent.
 *
 * `unknown` is not a failure. It means neither "it arrived" nor "it did not"
 * can be shown, and nothing retries from it automatically — a client draws it
 * as "we cannot tell" and leaves the decision to a person.
 */
export type DeliveryOutcomeName = "submitted" | "notWritten" | "unknown";

export type HandoffStateName =
  | "prepared"
  | "queued"
  | "dispatching"
  | "delivered"
  | "acknowledged"
  | "cancelled"
  | "failed"
  | "unknownOutcome";

export type ContextLinkDirectionName = "outgoing" | "incoming";

export interface AgentStatusRecord {
  nodeId: string;
  workspaceId: string;
  sessionId: string;
  generation: bigint;
  agentId: string;
  unread: number;
  verified: boolean;
  restored: boolean;
  /**
   * Absent means nobody has reported anything, which is a different picture
   * from a CLI that reported no error. Collapsing the two would make every node
   * that has never run look like one that ran cleanly.
   */
  errored?: boolean;
  interrupted?: boolean;
  /** Opaque: the Worker's own way of naming this node's transcript. */
  transcriptRef: Uint8Array;
  state: AgentStateName;
  sessionPhase: string;
  reasonCode: string;
  lastEventAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  /** u64. Compared as BigInt; a Number would stop being exact above 2^53. */
  revision: bigint;
}

export interface ApprovalRecord {
  approvalId: string;
  nodeId: string;
  workspaceId: string;
  sessionId: string;
  generation: bigint;
  /** The provider's own JSON. Decoded by whoever renders it, not here. */
  request: Uint8Array;
  requestSha256: Uint8Array;
  /** The CLI's own word for the answer, or empty while nobody has answered. */
  decision: string;
  answeredBy: string;
  state: ApprovalStateName;
  reasonCode: string;
  createdAtUnixMs: bigint;
  answeredAtUnixMs: bigint;
  revision: bigint;
}

export interface MailboxRecord {
  messageId: string;
  workspaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
  messageKey: string;
  body: string;
  /** The inbox's own order, unrelated to the event stream's sequence. */
  sequence: bigint;
  createdAtUnixMs: bigint;
  expiresAtUnixMs: bigint;
  /** Zero means nobody has read it. */
  acknowledgedAtUnixMs: bigint;
  revision: bigint;
}

export interface DeliveryRecord {
  traceId: string;
  workspaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
  receipt: string;
  bodyChars: number;
  outcome: DeliveryOutcomeName;
  reasonCode: string;
  createdAtUnixMs: bigint;
  revision: bigint;
}

export interface HandoffRecord {
  handoffId: string;
  workspaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
  source: { sessionId: string; generation: bigint };
  target: { sessionId: string; generation: bigint };
  /** Frozen at preparation. Both sides refuse a change to it. */
  bundle: Uint8Array;
  bundleSha256: Uint8Array;
  mailboxId: string;
  traceId: string;
  attempts: number;
  state: HandoffStateName;
  errorCode: string;
  createdAtUnixMs: bigint;
  acceptedAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  revision: bigint;
}

export interface ContextLinkRecord {
  targetNodeId: string;
  direction: ContextLinkDirectionName;
  kind: string;
}

export interface ContextLinksRecord {
  nodeId: string;
  workspaceId: string;
  links: ContextLinkRecord[];
  updatedAtUnixMs: bigint;
  revision: bigint;
}

/**
 * One node's own material, forwarded from the execution host and stored
 * nowhere. `truncated` is why the excerpt is a record rather than a string: a
 * cut-off conversation read as a whole one is a wrong answer, not a short one.
 */
export interface TranscriptExcerptRecord {
  nodeId: string;
  text: string;
  truncated: boolean;
  observedAtUnixMs: bigint;
}

export interface HookInstallRecord {
  agentId: string;
  installed: boolean;
  clientRevision: number;
  configPath: string;
  reasonCode: string;
  installedAtUnixMs: bigint;
}

const stateNames: Record<number, AgentStateName> = {
  [AgentState.IDLE]: "idle",
  [AgentState.WORKING]: "working",
  [AgentState.WAITING]: "waiting",
  [AgentState.BLOCKED]: "blocked",
  [AgentState.DONE]: "done",
};

const approvalNames: Record<number, ApprovalStateName> = {
  [ApprovalState.PENDING]: "pending",
  [ApprovalState.ANSWERED]: "answered",
  [ApprovalState.EXPIRED]: "expired",
};

const outcomeNames: Record<number, DeliveryOutcomeName> = {
  [DeliveryOutcome.SUBMITTED]: "submitted",
  [DeliveryOutcome.NOT_WRITTEN]: "notWritten",
  [DeliveryOutcome.UNKNOWN]: "unknown",
};

const handoffNames: Record<number, HandoffStateName> = {
  [HandoffState.PREPARED]: "prepared",
  [HandoffState.QUEUED]: "queued",
  [HandoffState.DISPATCHING]: "dispatching",
  [HandoffState.DELIVERED]: "delivered",
  [HandoffState.ACKNOWLEDGED]: "acknowledged",
  [HandoffState.CANCELLED]: "cancelled",
  [HandoffState.FAILED]: "failed",
  [HandoffState.UNKNOWN_OUTCOME]: "unknownOutcome",
};

/**
 * An enum value this build has never heard of is a response failure, not a
 * default. Reading an unknown state as `idle` would draw a node as finished on
 * the strength of a number nobody can explain.
 */
function named<T>(table: Record<number, T>, value: number): T {
  const name = table[value];
  if (name === undefined) throw new HostCanvasError("response");
  return name;
}

function decodeStatus(status: AgentStatus | undefined): AgentStatusRecord {
  if (!status?.nodeId) throw new HostCanvasError("response");
  return {
    nodeId: status.nodeId,
    workspaceId: status.workspaceId,
    sessionId: status.sessionId,
    generation: status.generation,
    agentId: status.agentId,
    unread: status.unread,
    verified: status.verified,
    restored: status.restored,
    ...(status.errored === undefined ? {} : { errored: status.errored }),
    ...(status.interrupted === undefined
      ? {}
      : { interrupted: status.interrupted }),
    transcriptRef: status.transcriptRef,
    state: named(stateNames, status.state),
    sessionPhase: status.sessionPhase,
    reasonCode: status.reasonCode,
    lastEventAtUnixMs: status.lastEventAtUnixMs,
    updatedAtUnixMs: status.updatedAtUnixMs,
    revision: status.revision,
  };
}

function decodeApproval(approval: Approval | undefined): ApprovalRecord {
  if (!approval?.approvalId) throw new HostCanvasError("response");
  return {
    approvalId: approval.approvalId,
    nodeId: approval.nodeId,
    workspaceId: approval.workspaceId,
    sessionId: approval.sessionId,
    generation: approval.generation,
    request: approval.request,
    requestSha256: approval.requestSha256,
    decision: approval.decision,
    answeredBy: approval.answeredBy,
    state: named(approvalNames, approval.state),
    reasonCode: approval.reasonCode,
    createdAtUnixMs: approval.createdAtUnixMs,
    answeredAtUnixMs: approval.answeredAtUnixMs,
    revision: approval.revision,
  };
}

function decodeMessage(message: MailboxMessage | undefined): MailboxRecord {
  if (!message?.messageId) throw new HostCanvasError("response");
  return {
    messageId: message.messageId,
    workspaceId: message.workspaceId,
    sourceNodeId: message.sourceNodeId,
    targetNodeId: message.targetNodeId,
    messageKey: message.messageKey,
    body: message.body,
    sequence: message.sequence,
    createdAtUnixMs: message.createdAtUnixMs,
    expiresAtUnixMs: message.expiresAtUnixMs,
    acknowledgedAtUnixMs: message.acknowledgedAtUnixMs,
    revision: message.revision,
  };
}

function decodeDelivery(delivery: Delivery | undefined): DeliveryRecord {
  if (!delivery?.traceId) throw new HostCanvasError("response");
  return {
    traceId: delivery.traceId,
    workspaceId: delivery.workspaceId,
    sourceNodeId: delivery.sourceNodeId,
    targetNodeId: delivery.targetNodeId,
    receipt: delivery.receipt,
    bodyChars: delivery.bodyChars,
    outcome: named(outcomeNames, delivery.outcome),
    reasonCode: delivery.reasonCode,
    createdAtUnixMs: delivery.createdAtUnixMs,
    revision: delivery.revision,
  };
}

function decodeHandoff(handoff: Handoff | undefined): HandoffRecord {
  if (!handoff?.handoffId) throw new HostCanvasError("response");
  return {
    handoffId: handoff.handoffId,
    workspaceId: handoff.workspaceId,
    sourceNodeId: handoff.sourceNodeId,
    targetNodeId: handoff.targetNodeId,
    source: {
      sessionId: handoff.source?.sessionId ?? "",
      generation: handoff.source?.generation ?? 0n,
    },
    target: {
      sessionId: handoff.target?.sessionId ?? "",
      generation: handoff.target?.generation ?? 0n,
    },
    bundle: handoff.bundle,
    bundleSha256: handoff.bundleSha256,
    mailboxId: handoff.mailboxId,
    traceId: handoff.traceId,
    attempts: handoff.attempts,
    state: named(handoffNames, handoff.state),
    errorCode: handoff.errorCode,
    createdAtUnixMs: handoff.createdAtUnixMs,
    acceptedAtUnixMs: handoff.acceptedAtUnixMs,
    updatedAtUnixMs: handoff.updatedAtUnixMs,
    revision: handoff.revision,
  };
}

function decodeLinks(links: ContextLinks): ContextLinksRecord {
  return {
    nodeId: links.nodeId,
    workspaceId: links.workspaceId,
    links: links.links.map((link) => ({
      targetNodeId: link.targetNodeId,
      direction: link.direction === 2 ? "incoming" : "outgoing",
      kind: link.kind,
    })),
    updatedAtUnixMs: links.updatedAtUnixMs,
    revision: links.revision,
  };
}

function decodeHooks(state: HookInstallState | undefined): HookInstallRecord {
  if (!state?.agentId) throw new HostCanvasError("response");
  return {
    agentId: state.agentId,
    installed: state.installed,
    clientRevision: state.clientRevision,
    configPath: state.configPath,
    reasonCode: state.reasonCode,
    installedAtUnixMs: state.installedAtUnixMs,
  };
}

export interface HostAgentClientOptions {
  session: HostAuthenticatedTransport;
  hostId: string;
  /** The workspace this client speaks for. The surface is workspace-scoped. */
  workspaceId: string;
}

/** A decision about a record the caller has already read. */
export interface AgentDecision {
  operationId: string;
  expectedRevision: bigint;
}

export interface PrepareHandoffInput extends AgentDecision {
  handoffId: string;
  sourceNodeId: string;
  targetNodeId: string;
  source?: { sessionId: string; generation: bigint };
  target?: { sessionId: string; generation: bigint };
  bundle: Uint8Array;
}

const idPattern = /^[0-9a-f]{32}$/;

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `agent-${Date.now().toString(36)}-${counter}`;
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export class HostAgentClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;
  readonly #workspaceId: string;

  constructor(options: HostAgentClientOptions) {
    if (
      !options ||
      typeof options.session?.send !== "function" ||
      !idPattern.test(options.hostId ?? "") ||
      typeof options.workspaceId !== "string" ||
      options.workspaceId.length === 0
    )
      throw new HostCanvasError("invalid");
    this.#session = options.session;
    this.#hostId = options.hostId;
    this.#workspaceId = options.workspaceId;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  #meta() {
    return {
      requestId: requestId(),
      scope: {
        hostId: this.#hostId,
        workspaceId: this.#workspaceId,
        executionHostId: this.#hostId,
      },
    };
  }

  async #call<T>(
    action: string,
    body: Uint8Array,
    mutation: boolean,
    decode: (wire: Uint8Array) => T,
  ): Promise<T> {
    let wire: Uint8Array;
    try {
      wire = await this.#session.send(SERVICE, action, body, mutation);
    } catch (error) {
      throw classifyCanvasFailure(error);
    }
    try {
      return decode(wire);
    } catch (error) {
      if (error instanceof HostCanvasError) throw error;
      throw new HostCanvasError("response", mutation);
    }
  }

  /** Every agent node in this workspace, in node order. */
  async listStatus(
    after?: string,
    limit?: number,
  ): Promise<AgentStatusRecord[]> {
    const request = create(ListAgentStatusRequestSchema, {
      meta: this.#meta(),
      afterNodeId: after ?? "",
      limit: limit ?? 0,
    });
    return this.#call(
      "ListStatus",
      toBinary(ListAgentStatusRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListAgentStatusResponseSchema, wire).statuses.map(
          decodeStatus,
        ),
    );
  }

  /**
   * Clears one node's unread badge.
   *
   * It carries a revision because two clients clearing one badge are two
   * decisions about one record: without it, a badge cleared on a phone
   * reappears when a laptop's stale write lands.
   */
  async markRead(
    input: AgentDecision & { nodeId: string },
  ): Promise<AgentStatusRecord> {
    if (!validOperationId(input?.operationId) || !input.nodeId)
      throw new HostCanvasError("invalid");
    const request = create(MarkAgentReadRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      nodeId: input.nodeId,
    });
    return this.#call(
      "MarkRead",
      toBinary(MarkAgentReadRequestSchema, request),
      true,
      (wire) =>
        decodeStatus(fromBinary(MarkAgentReadResponseSchema, wire).status),
    );
  }

  /** The questions open on one node, oldest first. */
  async listApprovals(
    nodeId: string,
    includeAnswered = false,
  ): Promise<ApprovalRecord[]> {
    const request = create(ListApprovalsRequestSchema, {
      meta: this.#meta(),
      nodeId,
      includeAnswered,
    });
    return this.#call(
      "ListApprovals",
      toBinary(ListApprovalsRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListApprovalsResponseSchema, wire).approvals.map(
          decodeApproval,
        ),
    );
  }

  /**
   * Answers one permission question.
   *
   * The decision is the CLI's own word and travels unchanged. The Host records
   * it under the revision named here *before* it asks the machine to write the
   * file the CLI is blocked on, which is what makes the answer singular: a
   * second device that read the same revision is refused before anything
   * reaches the terminal.
   */
  async answerApproval(
    input: AgentDecision & { approvalId: string; decision: string },
  ): Promise<ApprovalRecord> {
    if (
      !validOperationId(input?.operationId) ||
      !input.approvalId ||
      !input.decision
    )
      throw new HostCanvasError("invalid");
    const request = create(AnswerApprovalRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      approvalId: input.approvalId,
      decision: input.decision,
    });
    return this.#call(
      "AnswerApproval",
      toBinary(AnswerApprovalRequestSchema, request),
      true,
      (wire) =>
        decodeApproval(fromBinary(AnswerApprovalResponseSchema, wire).approval),
    );
  }

  /** One node's inbox, oldest first. */
  async listMailbox(
    targetNodeId: string,
    includeAcknowledged = false,
  ): Promise<MailboxRecord[]> {
    const request = create(ListMailboxRequestSchema, {
      meta: this.#meta(),
      targetNodeId,
      includeAcknowledged,
    });
    return this.#call(
      "ListMailbox",
      toBinary(ListMailboxRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListMailboxResponseSchema, wire).messages.map(decodeMessage),
    );
  }

  /** What a node was told, newest first. */
  async listDeliveries(
    nodeId: string,
    limit?: number,
  ): Promise<DeliveryRecord[]> {
    const request = create(ListDeliveriesRequestSchema, {
      meta: this.#meta(),
      nodeId,
      limit: limit ?? 0,
    });
    return this.#call(
      "ListDeliveries",
      toBinary(ListDeliveriesRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListDeliveriesResponseSchema, wire).deliveries.map(
          decodeDelivery,
        ),
    );
  }

  /**
   * Freezes a bundle. Nothing is sent.
   *
   * Preparing and accepting are separate calls because a bundle that could
   * change between being reviewed and being delivered is a bundle nobody
   * reviewed.
   */
  async prepareHandoff(input: PrepareHandoffInput): Promise<HandoffRecord> {
    if (
      !validOperationId(input?.operationId) ||
      !input.handoffId ||
      !input.sourceNodeId ||
      !input.targetNodeId ||
      !(input.bundle instanceof Uint8Array) ||
      input.bundle.length === 0
    )
      throw new HostCanvasError("invalid");
    const request = create(PrepareHandoffRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      handoffId: input.handoffId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      ...(input.source ? { source: input.source } : {}),
      ...(input.target ? { target: input.target } : {}),
      bundle: input.bundle,
    });
    return this.#call(
      "PrepareHandoff",
      toBinary(PrepareHandoffRequestSchema, request),
      true,
      (wire) =>
        decodeHandoff(fromBinary(PrepareHandoffResponseSchema, wire).handoff),
    );
  }

  /** Queues a prepared bundle and puts it in front of the target. */
  async acceptHandoff(
    input: AgentDecision & { handoffId: string },
  ): Promise<HandoffRecord> {
    if (!validOperationId(input?.operationId) || !input.handoffId)
      throw new HostCanvasError("invalid");
    const request = create(AcceptHandoffRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      handoffId: input.handoffId,
    });
    return this.#call(
      "AcceptHandoff",
      toBinary(AcceptHandoffRequestSchema, request),
      true,
      (wire) =>
        decodeHandoff(fromBinary(AcceptHandoffResponseSchema, wire).handoff),
    );
  }

  /** Withdraws one before it lands. A delivered handoff cannot be cancelled. */
  async cancelHandoff(
    input: AgentDecision & { handoffId: string; reasonCode?: string },
  ): Promise<HandoffRecord> {
    if (!validOperationId(input?.operationId) || !input.handoffId)
      throw new HostCanvasError("invalid");
    const request = create(CancelHandoffRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      handoffId: input.handoffId,
      reasonCode: input.reasonCode ?? "",
    });
    return this.#call(
      "CancelHandoff",
      toBinary(CancelHandoffRequestSchema, request),
      true,
      (wire) =>
        decodeHandoff(fromBinary(CancelHandoffResponseSchema, wire).handoff),
    );
  }

  /** Both directions for one node: what it was handed, and what it handed on. */
  async listHandoffs(nodeId: string, limit?: number): Promise<HandoffRecord[]> {
    const request = create(ListHandoffsRequestSchema, {
      meta: this.#meta(),
      nodeId,
      limit: limit ?? 0,
    });
    return this.#call(
      "ListHandoffs",
      toBinary(ListHandoffsRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListHandoffsResponseSchema, wire).handoffs.map(
          decodeHandoff,
        ),
    );
  }

  async getHandoff(handoffId: string): Promise<HandoffRecord> {
    const request = create(GetHandoffRequestSchema, {
      meta: this.#meta(),
      handoffId,
    });
    return this.#call(
      "GetHandoff",
      toBinary(GetHandoffRequestSchema, request),
      false,
      (wire) =>
        decodeHandoff(fromBinary(GetHandoffResponseSchema, wire).handoff),
    );
  }

  /**
   * The projection the canvas' edges imply. Read only, always: a client that
   * could write it could make a node read a transcript nobody connected it to.
   */
  async listContextLinks(nodeId?: string): Promise<ContextLinksRecord[]> {
    const request = create(ListContextLinksRequestSchema, {
      meta: this.#meta(),
      nodeId: nodeId ?? "",
    });
    return this.#call(
      "ListContextLinks",
      toBinary(ListContextLinksRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListContextLinksResponseSchema, wire).links.map(decodeLinks),
    );
  }

  /**
   * The tail of a node's own conversation, as the execution host renders it.
   *
   * Only the node is named. The session and the transcript reference come from
   * the Host's own record, so this cannot be pointed at a file of the caller's
   * choosing. A provider that keeps nothing readable — OpenCode's private
   * store, Pi's live window, Copilot's event log — is a refusal with a reason,
   * never an empty excerpt.
   */
  async readTranscript(input: {
    nodeId: string;
    maxBytes?: number;
  }): Promise<TranscriptExcerptRecord> {
    if (!input?.nodeId) throw new HostCanvasError("invalid");
    const request = create(ReadAgentTranscriptRequestSchema, {
      meta: this.#meta(),
      nodeId: input.nodeId,
      maxBytes: input.maxBytes ?? 0,
    });
    return this.#call(
      "ReadTranscript",
      toBinary(ReadAgentTranscriptRequestSchema, request),
      false,
      (wire) => {
        const excerpt = fromBinary(
          ReadAgentTranscriptResponseSchema,
          wire,
        ).excerpt;
        if (!excerpt?.nodeId) throw new HostCanvasError("response");
        return {
          nodeId: excerpt.nodeId,
          text: new TextDecoder().decode(excerpt.content),
          truncated: excerpt.truncated,
          observedAtUnixMs: excerpt.observedAtUnixMs,
        };
      },
    );
  }

  /** What the node's pane is showing right now, as plain text. */
  async captureScreen(input: {
    nodeId: string;
    lines?: number;
  }): Promise<string> {
    if (!input?.nodeId) throw new HostCanvasError("invalid");
    const request = create(CaptureAgentScreenCommandSchema, {
      meta: this.#meta(),
      nodeId: input.nodeId,
      lines: input.lines ?? 0,
    });
    return this.#call(
      "CaptureScreen",
      toBinary(CaptureAgentScreenCommandSchema, request),
      false,
      (wire) => {
        const screen = fromBinary(
          CaptureAgentScreenCommandResponseSchema,
          wire,
        ).screen;
        if (!screen?.nodeId) throw new HostCanvasError("response");
        return screen.data;
      },
    );
  }

  /** Installs a CLI's Hook configuration on the execution host. */
  async installHooks(input: {
    operationId: string;
    agentId: string;
  }): Promise<HookInstallRecord> {
    if (!validOperationId(input?.operationId) || !input.agentId)
      throw new HostCanvasError("invalid");
    const request = create(InstallHooksRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      agentId: input.agentId,
    });
    return this.#call(
      "InstallHooks",
      toBinary(InstallHooksRequestSchema, request),
      true,
      (wire) => decodeHooks(fromBinary(InstallHooksResponseSchema, wire).state),
    );
  }

  async uninstallHooks(input: {
    operationId: string;
    agentId: string;
  }): Promise<HookInstallRecord> {
    if (!validOperationId(input?.operationId) || !input.agentId)
      throw new HostCanvasError("invalid");
    const request = create(UninstallHooksRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      agentId: input.agentId,
    });
    return this.#call(
      "UninstallHooks",
      toBinary(UninstallHooksRequestSchema, request),
      true,
      (wire) =>
        decodeHooks(fromBinary(UninstallHooksResponseSchema, wire).state),
    );
  }
}
