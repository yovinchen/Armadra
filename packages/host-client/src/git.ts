import {
  create,
  fromBinary,
  toBinary,
  CancelGitCloneRequestSchema,
  CancelGitCloneResponseSchema,
  CancelGitOperationRequestSchema,
  CancelGitOperationResponseSchema,
  EnqueueGitOperationRequestSchema,
  EnqueueGitOperationResponseSchema,
  GetGitCloneRequestSchema,
  GetGitCloneResponseSchema,
  GetGitOperationRequestSchema,
  GetGitOperationResponseSchema,
  GetRepositoryStateRequestSchema,
  GetRepositoryStateResponseSchema,
  GitActionKind,
  GitCloneState,
  GitOperationState,
  GitReadMethod,
  ListGitOperationsRequestSchema,
  ListGitOperationsResponseSchema,
  ReadGitRequestSchema,
  ReadGitResponseSchema,
  StartGitCloneRequestSchema,
  StartGitCloneResponseSchema,
  type GitCloneJob,
  type GitOperation,
  type RepositoryState,
} from "@armadra/protocol";
import type { HostAuthenticatedTransport } from "./automation.js";
import { classifyCanvasFailure, HostCanvasError } from "./canvas.js";

const SERVICE = "GitService";

/**
 * The git domain, as a browser talks to it (Go Host 业务所有权迁移 §2.8).
 *
 * Two things about this client are worth stating, because they are what the
 * domain is for:
 *
 * **There is one write method.** Every stage, commit, branch, push and worktree
 * change is an `enqueue`, classified by `kind` and carrying the Runtime's own
 * request body as bytes. The gateway assembles the panel's former per-action
 * calls into it. Thirty methods here would be thirty places to forget that
 * writes to one checkout are sequential.
 *
 * **`UNKNOWN_OUTCOME` is not a failure.** A push whose result nobody could read
 * comes back in its own state, and a caller that rendered it as an error would
 * invite the one action that must never be automatic: pushing again. It is
 * exported as a distinct value for exactly that reason.
 */

export {
  GitActionKind,
  GitCloneState,
  GitOperationState,
  GitReadMethod,
} from "@armadra/protocol";

/** Which checkout a request is about. `repositoryPath` is the identity. */
export interface GitRepositoryScope {
  workspaceId: string;
  /** Absolute on the execution host. */
  repositoryPath: string;
  /** SHA-256 of the canonical common git dir; shared by every worktree. */
  repositoryId?: string;
  executionHostId?: string;
  worktreeId?: string;
}

/** What the caller read before it decided. Every field it supplies must hold. */
export interface GitExpectationInput {
  headOid?: string;
  indexFingerprint?: Uint8Array;
  refName?: string;
  refOid?: string;
}

/** One queue entry, in the shape a caller renders. */
export interface GitOperationRecord {
  operationId: string;
  scope: GitRepositoryScope;
  kind: GitActionKind;
  state: GitOperationState;
  affected: string[];
  progress: number;
  /**
   * The Runtime's own camelCase JSON for this kind, exactly as the caller sent
   * it, under the version lock `WorkerServiceRequest` states.
   *
   * It travels back so a client can render *what* was queued rather than only
   * that something was. The Host never parses it — it schedules on `kind` — and
   * a caller that decodes it is reading its own bytes, not a shape this
   * protocol promises.
   */
  action: Uint8Array;
  /** A stable, localizable key. Git's own output never travels as UI text. */
  messageCode: string;
  createdAtUnixMs: bigint;
  startedAtUnixMs: bigint;
  finishedAtUnixMs: bigint;
  /** u64. A Number would stop being exact above 2^53. */
  revision: bigint;
}

/** The Host's cached reading of a checkout, with the time it was taken. */
export interface RepositoryStateRecord {
  scope: GitRepositoryScope;
  headOid: string;
  branch: string;
  detached: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  operationState: GitOperationState;
  /** When the execution host looked. This is a cache, never the repository. */
  observedAtUnixMs: bigint;
  revision: bigint;
}

export interface HostGitClientOptions {
  session: HostAuthenticatedTransport;
  hostId: string;
  workspaceId: string;
}

export interface EnqueueGitInput {
  operationId: string;
  scope: GitRepositoryScope;
  kind: GitActionKind;
  /** The Runtime's own camelCase JSON for this kind. */
  action: Uint8Array;
  expected?: GitExpectationInput;
}

export interface ReadGitInput {
  method: GitReadMethod;
  scope: GitRepositoryScope;
  /** The Runtime's own query body. Absent means the method's own default. */
  requestJson?: Uint8Array;
}

/**
 * One clone, as a caller renders it.
 *
 * The URL is deliberately absent. A clone URL can carry a credential, and a
 * record that kept one would turn a read of the Host's own store into a leak;
 * what comes back is the digest, which recognises the same clone twice, and the
 * redacted form the execution host produced from the original.
 */
export interface GitCloneRecord {
  jobId: string;
  workspaceId: string;
  urlSha256: Uint8Array;
  /** Credentials already removed, by the side that held them. */
  displayUrl: string;
  targetPath: string;
  /** 0–100, as the running `git clone --progress` reported it. */
  progress: number;
  state: GitCloneState;
  messageCode: string;
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  revision: bigint;
}

/** A forwarded read, with the status the Runtime's own route would return. */
export interface GitReadAnswer {
  httpStatus: number;
  body: Uint8Array;
}

/**
 * One clone record as it arrives. An unspecified state is refused rather than
 * defaulted: "the Host did not say" and "it is running" are different
 * statements, and reading the first as the second shows a finished clone as one
 * that never ends.
 */
function decodeClone(job: GitCloneJob | undefined): GitCloneRecord {
  if (
    !job ||
    job.jobId === "" ||
    job.revision <= 0n ||
    job.state === GitCloneState.UNSPECIFIED
  )
    throw new HostCanvasError("response");
  return {
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    urlSha256: job.urlSha256,
    displayUrl: job.displayUrl,
    targetPath: job.targetPath,
    progress: job.progress,
    state: job.state,
    messageCode: job.messageCode,
    createdAtUnixMs: job.createdAtUnixMs,
    updatedAtUnixMs: job.updatedAtUnixMs,
    revision: job.revision,
  };
}

const idPattern = /^[0-9a-f]{32}$/;

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `git-${Date.now().toString(36)}-${counter}`;
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validScope(value: unknown): value is GitRepositoryScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope.workspaceId === "string" &&
    scope.workspaceId.length > 0 &&
    typeof scope.repositoryPath === "string" &&
    scope.repositoryPath.length > 0
  );
}

function decodeScope(scope: unknown): GitRepositoryScope {
  const value = scope as Record<string, unknown> | undefined;
  if (!value || typeof value.repositoryPath !== "string")
    throw new HostCanvasError("response");
  return {
    workspaceId: String(value.workspaceId ?? ""),
    repositoryPath: value.repositoryPath,
    repositoryId: String(value.repositoryId ?? ""),
    executionHostId: String(value.executionHostId ?? ""),
    worktreeId: String(value.worktreeId ?? ""),
  };
}

/**
 * One queue entry as it arrives.
 *
 * An entry whose state is UNSPECIFIED is refused rather than defaulted: "the
 * Host did not say" and "queued" are different statements, and a panel that
 * read the first as the second would show a push as pending forever.
 */
function decodeOperation(
  operation: GitOperation | undefined,
): GitOperationRecord {
  if (
    !operation ||
    operation.operationId === "" ||
    operation.revision <= 0n ||
    operation.state === GitOperationState.UNSPECIFIED
  )
    throw new HostCanvasError("response");
  return {
    operationId: operation.operationId,
    scope: decodeScope(operation.scope),
    kind: operation.kind,
    state: operation.state,
    affected: [...operation.affected],
    progress: operation.progress,
    action: operation.action,
    messageCode: operation.messageCode,
    createdAtUnixMs: operation.createdAtUnixMs,
    startedAtUnixMs: operation.startedAtUnixMs,
    finishedAtUnixMs: operation.finishedAtUnixMs,
    revision: operation.revision,
  };
}

/**
 * A cached snapshot. `observedAtUnixMs` is required: a reading with no time on
 * it cannot be told from the repository itself, which is the one thing this
 * record must never be mistaken for.
 */
function decodeState(
  state: RepositoryState | undefined,
): RepositoryStateRecord {
  if (!state || state.observedAtUnixMs <= 0n || state.revision <= 0n)
    throw new HostCanvasError("response");
  return {
    scope: decodeScope(state.scope),
    headOid: state.headOid,
    branch: state.branch,
    detached: state.detached,
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    operationState: state.operationState,
    observedAtUnixMs: state.observedAtUnixMs,
    revision: state.revision,
  };
}

async function digest(body: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new HostCanvasError("invalid");
  return new Uint8Array(
    await subtle.digest("SHA-256", body as unknown as ArrayBuffer),
  );
}

export class HostGitClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;
  readonly #workspaceId: string;

  constructor(options: HostGitClientOptions) {
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
   * Queues one write. The digest is computed here rather than accepted, so a
   * body that was rewritten between the caller and the wire is refused by the
   * Host instead of being run as an authorized decision.
   */
  async enqueue(input: EnqueueGitInput): Promise<GitOperationRecord> {
    if (
      !input ||
      !validOperationId(input.operationId) ||
      !validScope(input.scope) ||
      !(input.action instanceof Uint8Array) ||
      input.action.length === 0 ||
      input.kind === GitActionKind.UNSPECIFIED ||
      input.kind === GitActionKind.UNSUPPORTED
    )
      throw new HostCanvasError("invalid");
    const request = create(EnqueueGitOperationRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      scope: { ...input.scope, workspaceId: this.#workspaceId },
      action: input.action,
      actionSha256: await digest(input.action),
      expected: input.expected ?? {},
      kind: input.kind,
    });
    return this.#call(
      "Enqueue",
      toBinary(EnqueueGitOperationRequestSchema, request),
      true,
      (wire) =>
        decodeOperation(
          fromBinary(EnqueueGitOperationResponseSchema, wire).operation,
        ),
    );
  }

  /** One entry, by identifier. */
  async getOperation(operationId: string): Promise<GitOperationRecord> {
    if (typeof operationId !== "string" || operationId.length === 0)
      throw new HostCanvasError("invalid");
    const request = create(GetGitOperationRequestSchema, {
      meta: this.#meta(),
      operationId,
    });
    return this.#call(
      "GetOperation",
      toBinary(GetGitOperationRequestSchema, request),
      false,
      (wire) =>
        decodeOperation(
          fromBinary(GetGitOperationResponseSchema, wire).operation,
        ),
    );
  }

  /** One repository's queue, newest first. */
  async listOperations(
    scope: GitRepositoryScope,
    options: { activeOnly?: boolean; limit?: number } = {},
  ): Promise<GitOperationRecord[]> {
    if (!validScope(scope)) throw new HostCanvasError("invalid");
    const request = create(ListGitOperationsRequestSchema, {
      meta: this.#meta(),
      scope: { ...scope, workspaceId: this.#workspaceId },
      activeOnly: options.activeOnly ?? false,
      limit: options.limit ?? 0,
    });
    return this.#call(
      "ListOperations",
      toBinary(ListGitOperationsRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListGitOperationsResponseSchema, wire).operations.map(
          decodeOperation,
        ),
    );
  }

  /**
   * Asks the execution host to stop.
   *
   * The answer is what actually happened, which may not be a cancellation: an
   * operation whose mutation had begun comes back `UNKNOWN_OUTCOME`, because a
   * stopped push may still have been accepted.
   */
  async cancelOperation(
    operationId: string,
    targetOperationId: string,
  ): Promise<GitOperationRecord> {
    if (
      !validOperationId(operationId) ||
      typeof targetOperationId !== "string" ||
      targetOperationId.length === 0
    )
      throw new HostCanvasError("invalid");
    const request = create(CancelGitOperationRequestSchema, {
      meta: this.#meta(),
      operationId,
      targetOperationId,
    });
    return this.#call(
      "CancelOperation",
      toBinary(CancelGitOperationRequestSchema, request),
      true,
      (wire) =>
        decodeOperation(
          fromBinary(CancelGitOperationResponseSchema, wire).operation,
        ),
    );
  }

  /**
   * The cached snapshot. `refresh` asks the execution host to look again,
   * which is what a person pressing reload means; without it the answer is the
   * last reading, and its `observedAtUnixMs` says how old that is.
   */
  async repositoryState(
    scope: GitRepositoryScope,
    refresh = false,
  ): Promise<RepositoryStateRecord> {
    if (!validScope(scope)) throw new HostCanvasError("invalid");
    const request = create(GetRepositoryStateRequestSchema, {
      meta: this.#meta(),
      scope: { ...scope, workspaceId: this.#workspaceId },
      refresh,
    });
    return this.#call(
      "RepositoryState",
      toBinary(GetRepositoryStateRequestSchema, request),
      false,
      (wire) =>
        decodeState(fromBinary(GetRepositoryStateResponseSchema, wire).state),
    );
  }

  /**
   * Starts one clone on the execution host.
   *
   * It is not an `Enqueue`: a clone has no repository yet, so there is nothing
   * to lock, no worktree to serialize with and no precondition to state. What
   * the Host does keep is the job record, because the execution host forgets a
   * clone when its process ends and the Host does not.
   */
  async startClone(input: {
    operationId: string;
    url: string;
    targetPath?: string;
  }): Promise<GitCloneRecord> {
    if (
      !input ||
      !validOperationId(input.operationId) ||
      typeof input.url !== "string" ||
      input.url.length === 0
    )
      throw new HostCanvasError("invalid");
    const request = create(StartGitCloneRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      url: input.url,
      targetPath: input.targetPath ?? "",
    });
    return this.#call(
      "Clone",
      toBinary(StartGitCloneRequestSchema, request),
      true,
      (wire) => decodeClone(fromBinary(StartGitCloneResponseSchema, wire).job),
    );
  }

  /**
   * One clone's record, refreshed from the execution host while it is still
   * running. A finished job is answered from the record alone.
   */
  async getClone(jobId: string): Promise<GitCloneRecord> {
    if (typeof jobId !== "string" || jobId.length === 0)
      throw new HostCanvasError("invalid");
    const request = create(GetGitCloneRequestSchema, {
      meta: this.#meta(),
      jobId,
    });
    return this.#call(
      "GetClone",
      toBinary(GetGitCloneRequestSchema, request),
      false,
      (wire) => decodeClone(fromBinary(GetGitCloneResponseSchema, wire).job),
    );
  }

  /**
   * Stops a running clone. Unlike a push there is no unknown outcome to worry
   * about: a clone writes into a directory this side named, and cancelling it
   * keeps whatever it had already written rather than deleting a path a person
   * chose.
   */
  async cancelClone(
    operationId: string,
    jobId: string,
  ): Promise<GitCloneRecord> {
    if (!validOperationId(operationId) || typeof jobId !== "string" || !jobId)
      throw new HostCanvasError("invalid");
    const request = create(CancelGitCloneRequestSchema, {
      meta: this.#meta(),
      operationId,
      jobId,
    });
    return this.#call(
      "CancelClone",
      toBinary(CancelGitCloneRequestSchema, request),
      true,
      (wire) => decodeClone(fromBinary(CancelGitCloneResponseSchema, wire).job),
    );
  }

  /**
   * Forwards one repository query.
   *
   * The status comes back untouched, so a caller distinguishes "that commit
   * does not exist" from "the request failed" exactly as it does against the
   * Runtime's own routes.
   */
  async read(input: ReadGitInput): Promise<GitReadAnswer> {
    if (
      !input ||
      input.method === GitReadMethod.UNSPECIFIED ||
      !input.scope ||
      typeof input.scope.workspaceId !== "string"
    )
      throw new HostCanvasError("invalid");
    const request = create(ReadGitRequestSchema, {
      meta: this.#meta(),
      read: {
        scope: { ...input.scope, workspaceId: this.#workspaceId },
        requestJson: input.requestJson ?? new Uint8Array(),
        method: input.method,
      },
    });
    return this.#call(
      "Read",
      toBinary(ReadGitRequestSchema, request),
      false,
      (wire) => {
        const result = fromBinary(ReadGitResponseSchema, wire).result;
        if (!result || result.httpStatus === 0)
          throw new HostCanvasError("response");
        return { httpStatus: result.httpStatus, body: result.responseJson };
      },
    );
  }
}
