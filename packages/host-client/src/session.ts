import {
  create,
  fromBinary,
  toBinary,
  CloseSessionRequestSchema,
  CloseSessionResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  GetSessionContextUsageRequestSchema,
  GetSessionContextUsageResponseSchema,
  GetSessionRequestSchema,
  GetSessionResponseSchema,
  ListSessionsRequestSchema,
  ListSessionsResponseSchema,
  RecycleSessionRequestSchema,
  RecycleSessionResponseSchema,
  SessionAttachState,
  SessionKind,
  SessionStatus,
  StartSessionRequestSchema,
  StartSessionResponseSchema,
  SuggestSessionTitleRequestSchema,
  SuggestSessionTitleResponseSchema,
  TerminateSessionRequestSchema,
  TerminateSessionResponseSchema,
  TerminationIntent,
  type Session,
  type SessionRun,
} from "@armadra/protocol";
import type { HostAuthenticatedTransport } from "./automation.js";
import { classifyCanvasFailure, HostCanvasError } from "./canvas.js";

const SERVICE = "SessionService";

/**
 * Whether a session should exist, and what it was frozen to launch
 * (Go Host 业务所有权迁移 §2.6).
 *
 * This client starts no process and carries no bytes. The terminal stream is
 * still a WebSocket to the execution host, unchanged, because attaching is
 * execution and stays where the program runs. What moved is the decision — and
 * that decision used to be taken by a browser as a side effect of rendering a
 * node, which meant a page that mounted twice could start two programs.
 *
 * So creating and starting are two calls, deliberately. `create` records the
 * intent under an operation id and a revision; `start` is a separate request
 * that asks the machine for a run. A caller that only wants to attach never
 * makes either: it calls `get` and connects.
 */

/** Which of the six lifecycle states a session is in. */
export type SessionState =
  | "pending"
  | "starting"
  | "running"
  | "exited"
  /**
   * Nobody can currently see this session. It is *not* "exited": the execution
   * host may well still be holding the pane, and drawing it as ended would
   * offer the user a second program on top of the first.
   */
  | "lost"
  | "reclaiming";

export type SessionAttach = "detached" | "attached" | "exited";
export type SessionKindName = "terminal" | "agent" | "command";
export type SessionIntent = "none" | "user" | "recycle" | "hostShutdown";

/** What a session was frozen to launch. Environment values never travel. */
export interface SessionLaunchRecord {
  workingDirectory: string;
  shell: string;
  command: string;
  args: string[];
  /** Names only; a value here would be a secret in the Host's database. */
  envRefs: string[];
  sshTargetId: string;
  agentId: string;
}

/** One session, in the shape a caller renders. */
export interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  /** Empty means this machine; anything else is a `settings.ssh.hosts[].id`. */
  executionHostId: string;
  /** Survives a recycle, which is what a mounting node looks a session up by. */
  sessionKey: string;
  ownerNodeId: string;
  kind: SessionKindName;
  state: SessionState;
  attach: SessionAttach;
  intent: SessionIntent;
  backendKind: string;
  /** The Worker's value. A client compares it to know its socket is current. */
  generation: bigint;
  /** Absent means nobody watched this session end — not that it ended well. */
  exitCode?: number;
  launch: SessionLaunchRecord;
  reasonCode: string;
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  endedAtUnixMs: bigint;
  lastOutputAtUnixMs: bigint;
  /** u64. Compared as BigInt; a Number would stop being exact above 2^53. */
  revision: bigint;
}

/** One generation of one session. */
export interface SessionRunRecord {
  sessionId: string;
  generation: bigint;
  workerInstanceId: string;
  /** Opaque: a handle on an object inside a process nobody here runs. */
  backendRef: string;
  exitCode?: number;
  reasonCode: string;
  startedAtUnixMs: bigint;
  endedAtUnixMs: bigint;
}

const states: Record<number, SessionState> = {
  [SessionStatus.PENDING]: "pending",
  [SessionStatus.STARTING]: "starting",
  [SessionStatus.RUNNING]: "running",
  [SessionStatus.EXITED]: "exited",
  [SessionStatus.LOST]: "lost",
  [SessionStatus.RECLAIMING]: "reclaiming",
};

const attachments: Record<number, SessionAttach> = {
  [SessionAttachState.DETACHED]: "detached",
  [SessionAttachState.ATTACHED]: "attached",
  [SessionAttachState.EXITED]: "exited",
};

const kinds: Record<number, SessionKindName> = {
  [SessionKind.TERMINAL]: "terminal",
  [SessionKind.AGENT]: "agent",
  [SessionKind.COMMAND]: "command",
};

const intents: Record<number, SessionIntent> = {
  [TerminationIntent.NONE]: "none",
  [TerminationIntent.USER]: "user",
  [TerminationIntent.RECYCLE]: "recycle",
  [TerminationIntent.HOST_SHUTDOWN]: "hostShutdown",
};

/**
 * Decodes one record.
 *
 * An unspecified enum value is refused rather than defaulted, because every
 * default here would be a lie a UI acts on: a session drawn as `running`
 * because its status was unreadable is one nobody will restart, and one drawn
 * as `exited` for the same reason is one somebody will start twice.
 */
function decodeSession(session: Session | undefined): SessionRecord {
  const state = session && states[session.status];
  const attach = session && attachments[session.attachState];
  const kind = session && kinds[session.kind];
  if (
    !session ||
    session.sessionId === "" ||
    session.deleted ||
    session.revision <= 0n ||
    !state ||
    !attach ||
    !kind
  )
    throw new HostCanvasError("response");
  const launch = session.launch;
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    executionHostId: session.executionHostId,
    sessionKey: session.sessionKey,
    ownerNodeId: session.ownerNodeId,
    kind,
    state,
    attach,
    intent: intents[session.terminationIntent] ?? "none",
    backendKind: session.backendKind,
    generation: session.generation,
    exitCode: session.exitCode,
    launch: {
      workingDirectory: launch?.workingDirectory ?? "",
      shell: launch?.shell ?? "",
      command: launch?.command ?? "",
      args: launch?.args ?? [],
      envRefs: launch?.envRefs ?? [],
      sshTargetId: launch?.sshTargetId ?? "",
      agentId: launch?.agent?.agentId ?? "",
    },
    reasonCode: session.reasonCode,
    createdAtUnixMs: session.createdAtUnixMs,
    updatedAtUnixMs: session.updatedAtUnixMs,
    endedAtUnixMs: session.endedAtUnixMs,
    lastOutputAtUnixMs: session.lastOutputAtUnixMs,
    revision: session.revision,
  };
}

function decodeRun(run: SessionRun | undefined): SessionRunRecord | undefined {
  if (!run || run.sessionId === "" || run.generation <= 0n) return undefined;
  return {
    sessionId: run.sessionId,
    generation: run.generation,
    workerInstanceId: run.workerInstanceId,
    backendRef: run.backendRef,
    exitCode: run.exitCode,
    reasonCode: run.reasonCode,
    startedAtUnixMs: run.startedAtUnixMs,
    endedAtUnixMs: run.endedAtUnixMs,
  };
}

export interface HostSessionClientOptions {
  session: HostAuthenticatedTransport;
  hostId: string;
  /** The workspace this client speaks for. The surface is workspace-scoped. */
  workspaceId: string;
}

export interface CreateSessionInput {
  operationId: string;
  sessionId: string;
  sessionKey: string;
  ownerNodeId?: string;
  kind: SessionKindName;
  executionHostId?: string;
  workingDirectory: string;
  shell?: string;
  command?: string;
  args?: string[];
  envRefs?: string[];
  sshTargetId?: string;
  agentId?: string;
  permissionMode?: string;
  modelId?: string;
  /** The revision the caller read. 0 means "no session under this id". */
  expectedRevision: bigint;
}

export interface SessionDecision {
  operationId: string;
  sessionId: string;
  expectedRevision: bigint;
}

/** How hard to stop it, in the execution host's own vocabulary. */
export type TerminateMode = "interrupt" | "process" | "session";

const idPattern = /^[0-9a-f]{32}$/;

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `session-${Date.now().toString(36)}-${counter}`;
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validDecision(input: SessionDecision | undefined): boolean {
  return (
    !!input &&
    validOperationId(input.operationId) &&
    typeof input.sessionId === "string" &&
    input.sessionId.length > 0 &&
    typeof input.expectedRevision === "bigint" &&
    input.expectedRevision > 0n
  );
}

const kindNumbers: Record<SessionKindName, SessionKind> = {
  terminal: SessionKind.TERMINAL,
  agent: SessionKind.AGENT,
  command: SessionKind.COMMAND,
};

export class HostSessionClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;
  readonly #workspaceId: string;

  constructor(options: HostSessionClientOptions) {
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

  /**
   * One session and its current run.
   *
   * This is the read a mounting terminal node makes, and it is the whole point
   * of the domain that it is only a read: the node learns whether a session
   * exists and attaches to it, and whether one should be created is a separate
   * request somebody makes on purpose.
   */
  async get(lookup: {
    sessionId?: string;
    sessionKey?: string;
  }): Promise<{ session: SessionRecord; run?: SessionRunRecord }> {
    const byId =
      typeof lookup?.sessionId === "string" && lookup.sessionId !== "";
    const byKey =
      typeof lookup?.sessionKey === "string" && lookup.sessionKey !== "";
    // Naming both would let the two disagree, and resolving that by precedence
    // would answer about a session the caller did not ask for.
    if (byId === byKey) throw new HostCanvasError("invalid");
    const request = create(GetSessionRequestSchema, {
      meta: this.#meta(),
      sessionId: byId ? lookup.sessionId : "",
      sessionKey: byKey ? lookup.sessionKey : "",
    });
    return this.#call(
      "Get",
      toBinary(GetSessionRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(GetSessionResponseSchema, wire);
        return {
          session: decodeSession(value.session),
          run: decodeRun(value.run),
        };
      },
    );
  }

  /** Every session in this workspace, newest identifiers last. */
  async list(kinds?: SessionKindName[]): Promise<SessionRecord[]> {
    const request = create(ListSessionsRequestSchema, {
      meta: this.#meta(),
      kinds: (kinds ?? []).map((kind) => kindNumbers[kind]),
    });
    return this.#call(
      "List",
      toBinary(ListSessionsRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListSessionsResponseSchema, wire).sessions.map(
          decodeSession,
        ),
    );
  }

  /**
   * Records the intent. Nothing starts: the launch is frozen here and the
   * decision to run it is a second call.
   */
  async create(input: CreateSessionInput): Promise<SessionRecord> {
    if (
      !input ||
      !validOperationId(input.operationId) ||
      typeof input.sessionId !== "string" ||
      input.sessionId.length === 0 ||
      typeof input.sessionKey !== "string" ||
      input.sessionKey.length === 0 ||
      typeof input.workingDirectory !== "string" ||
      input.workingDirectory.length === 0 ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision < 0n
    )
      throw new HostCanvasError("invalid");
    const request = create(CreateSessionRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      session: {
        sessionId: input.sessionId,
        workspaceId: this.#workspaceId,
        executionHostId: input.executionHostId ?? "",
        sessionKey: input.sessionKey,
        ownerNodeId: input.ownerNodeId ?? "",
        kind: kindNumbers[input.kind],
        launch: {
          workingDirectory: input.workingDirectory,
          shell: input.shell ?? "",
          command: input.command ?? "",
          args: input.args ?? [],
          envRefs: input.envRefs ?? [],
          sshTargetId: input.sshTargetId ?? "",
          agent: input.agentId
            ? {
                agentId: input.agentId,
                workingDirectory: input.workingDirectory,
                permissionMode: input.permissionMode ?? "",
                modelId: input.modelId ?? "",
              }
            : undefined,
        },
      },
    });
    return this.#call(
      "Create",
      toBinary(CreateSessionRequestSchema, request),
      true,
      (wire) =>
        decodeSession(fromBinary(CreateSessionResponseSchema, wire).session),
    );
  }

  /**
   * Asks the execution host for a run.
   *
   * The launch is not in the request: it was frozen at creation, and a start
   * that could restate it would be a second place the command line is decided.
   */
  async start(
    input: SessionDecision,
  ): Promise<{ session: SessionRecord; run?: SessionRunRecord }> {
    if (!validDecision(input)) throw new HostCanvasError("invalid");
    const request = create(StartSessionRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      sessionId: input.sessionId,
    });
    return this.#call(
      "Start",
      toBinary(StartSessionRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(StartSessionResponseSchema, wire);
        return {
          session: decodeSession(value.session),
          run: decodeRun(value.run),
        };
      },
    );
  }

  /** Ends the run and keeps the record, with its history. */
  async terminate(
    input: SessionDecision & { mode?: TerminateMode },
  ): Promise<SessionRecord> {
    if (!validDecision(input)) throw new HostCanvasError("invalid");
    const request = create(TerminateSessionRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      sessionId: input.sessionId,
      mode: input.mode ?? "process",
      intent: TerminationIntent.USER,
    });
    return this.#call(
      "Terminate",
      toBinary(TerminateSessionRequestSchema, request),
      true,
      (wire) =>
        decodeSession(fromBinary(TerminateSessionResponseSchema, wire).session),
    );
  }

  /**
   * Same logical session, next generation. It is one call rather than
   * terminate-then-start because a client that died between the two would
   * leave a session recorded as running with no process behind it.
   */
  async recycle(
    input: SessionDecision,
  ): Promise<{ session: SessionRecord; run?: SessionRunRecord }> {
    if (!validDecision(input)) throw new HostCanvasError("invalid");
    const request = create(RecycleSessionRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      sessionId: input.sessionId,
    });
    return this.#call(
      "Recycle",
      toBinary(RecycleSessionRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(RecycleSessionResponseSchema, wire);
        return {
          session: decodeSession(value.session),
          run: decodeRun(value.run),
        };
      },
    );
  }

  /**
   * Withdraws the intent. It kills nothing: a caller that wants the process
   * gone terminates first, because "remove this from my board" and "kill this
   * program" are two decisions and must not be one button.
   */
  async close(input: SessionDecision): Promise<string> {
    if (!validDecision(input)) throw new HostCanvasError("invalid");
    const request = create(CloseSessionRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      sessionId: input.sessionId,
    });
    return this.#call(
      "Close",
      toBinary(CloseSessionRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(CloseSessionResponseSchema, wire);
        if (value.sessionId !== input.sessionId)
          throw new HostCanvasError("response", true);
        return value.sessionId;
      },
    );
  }

  /** A title from the transcript or the live pane, both on the machine. */
  async suggestTitle(
    sessionId: string,
  ): Promise<{ title: string; source: string }> {
    if (typeof sessionId !== "string" || sessionId.length === 0)
      throw new HostCanvasError("invalid");
    const request = create(SuggestSessionTitleRequestSchema, {
      meta: this.#meta(),
      sessionId,
    });
    return this.#call(
      "SuggestTitle",
      toBinary(SuggestSessionTitleRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(SuggestSessionTitleResponseSchema, wire);
        return { title: value.title, source: value.source };
      },
    );
  }

  /**
   * The execution host's own context-usage snapshot.
   *
   * It stays opaque bytes with a digest, because the shape belongs to the agent
   * domain and expanding it here would freeze it before that batch decides it.
   * A caller that wants numbers decodes them itself and stays responsible for
   * the version it decoded.
   */
  async contextUsage(
    sessionId: string,
    refresh = false,
  ): Promise<{ usage: Uint8Array; schemaVersion: number }> {
    if (typeof sessionId !== "string" || sessionId.length === 0)
      throw new HostCanvasError("invalid");
    const request = create(GetSessionContextUsageRequestSchema, {
      meta: this.#meta(),
      sessionId,
      refresh,
    });
    return this.#call(
      "GetContextUsage",
      toBinary(GetSessionContextUsageRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(GetSessionContextUsageResponseSchema, wire);
        // The digest is the only thing that says the bytes arrived whole, so a
        // snapshot without one is refused rather than shown.
        if (value.usage.length > 0 && value.usageSha256.length !== 32)
          throw new HostCanvasError("response");
        return { usage: value.usage, schemaVersion: value.schemaVersion };
      },
    );
  }
}
