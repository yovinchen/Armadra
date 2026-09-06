import {
  create,
  fromBinary,
  toBinary,
  ActivateAutomationRequestSchema,
  AutomationCommandSessionSchema,
  AutomationPlanSnapshotSchema,
  AutomationRunSnapshotSchema,
  DefineAutomationRequestSchema,
  DefineCommandSessionRequestSchema,
  GetAutomationPayloadRequestSchema,
  GetAutomationPayloadResponseSchema,
  ListAutomationPlansRequestSchema,
  ListAutomationPlansResponseSchema,
  ListAutomationRunsRequestSchema,
  ListAutomationRunsResponseSchema,
  ListCommandSessionsRequestSchema,
  ListCommandSessionsResponseSchema,
  PauseAutomationRequestSchema,
  RunAutomationNowRequestSchema,
  type AutomationCommandSession,
  type AutomationPlanConfig,
  type AutomationPlanSnapshot,
  type AutomationRunSnapshot,
  type CommandLaunchSpec,
  type ListAutomationPlansResponse,
  type ListAutomationRunsResponse,
  type ListCommandSessionsResponse,
} from "@armadra/protocol";
import { HostIdentityError } from "./identity.js";

export type {
  AutomationCommandSession,
  AutomationPlan,
  AutomationPlanConfig,
  AutomationPlanSnapshot,
  AutomationRun,
  AutomationRunSnapshot,
  CommandLaunchSpec,
} from "@armadra/protocol";

const SERVICE = "AutomationService";
const MAX_PAGE = 200;
/** Mirrors the Host's storage.MaxAutomationPayloadBytes guard. */
export const MAX_AUTOMATION_PAYLOAD_BYTES = 64 * 1024;

/**
 * What went wrong, in terms a panel can act on. Deliberately not the HTTP
 * status: the caller decides whether to re-authenticate, reload a revision or
 * tell the user this Host has no execution Worker, and each of those is a
 * different repair.
 */
export type HostAutomationFailure =
  | "invalid"
  | "unauthenticated"
  | "permission"
  | "unsupported"
  | "notFound"
  | "conflict"
  | "response"
  | "cancelled"
  | "network";

/** Carries only stable metadata; never a response body, token or URL. */
export class HostAutomationError extends Error {
  readonly name = "HostAutomationError";
  constructor(
    readonly failure: HostAutomationFailure,
    /** A mutation that reached the Host but whose result was never read. */
    readonly outcomeUnknown = false,
    readonly httpStatus?: number,
    readonly hostCode?: string,
  ) {
    super(`Host automation request failed (${failure}).`);
  }
}

/**
 * The authenticated session an automation call rides on. `HostIdentityClient`
 * satisfies it; tests supply their own so no real cookie jar is needed.
 */
export interface HostAuthenticatedTransport {
  send(
    service: string,
    action: string,
    body: Uint8Array,
    mutation: boolean,
  ): Promise<Uint8Array>;
}

export interface HostAutomationClientOptions {
  session: HostAuthenticatedTransport;
  /** This Host's id; it is also the only execution host a plan may target. */
  hostId: string;
  workspaceId: string;
}

const idPattern = /^[0-9a-f]{32}$/;
const scopedId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function reject(failure: HostAutomationFailure): never {
  throw new HostAutomationError(failure);
}

/**
 * Maps a transport failure onto a repair. An UNKNOWN or unrecognised remote
 * code is never softened into "invalid": a mutation whose outcome was not read
 * stays flagged so the caller reloads instead of silently retrying.
 */
export function classifyAutomationFailure(error: unknown): HostAutomationError {
  if (error instanceof HostAutomationError) return error;
  if (!(error instanceof HostIdentityError))
    return new HostAutomationError("network");
  const { code, hostCode, httpStatus, outcomeUnknown } = error;
  const fail = (failure: HostAutomationFailure) =>
    new HostAutomationError(failure, outcomeUnknown, httpStatus, hostCode);
  if (code === "CANCELLED" || code === "TIMEOUT") return fail("cancelled");
  if (code === "INVALID_OPTIONS") return fail("invalid");
  if (
    code === "MALFORMED_RESPONSE" ||
    code === "RESPONSE_TOO_LARGE" ||
    code === "UNEXPECTED_CONTENT_TYPE"
  )
    return fail("response");
  if (code !== "REMOTE_ERROR") return fail("network");
  switch (hostCode) {
    case "UNAUTHENTICATED":
      return fail("unauthenticated");
    case "PERMISSION_DENIED":
      return fail("permission");
    case "UNSUPPORTED":
      return fail("unsupported");
    case "NOT_FOUND":
      return fail("notFound");
    case "CONFLICT":
      return fail("conflict");
    case "INVALID_ARGUMENT":
      return fail("invalid");
    default:
      return fail("network");
  }
}

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `automation-${Date.now().toString(36)}-${counter}`;
}

function page(
  after: string,
  limit: number,
): { afterId: string; limit: number } {
  if (
    typeof after !== "string" ||
    after.length > 200 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE
  )
    reject("invalid");
  return { afterId: after, limit };
}

/**
 * Typed access to the Host's authenticated automation surface.
 *
 * Every call is scoped to one workspace and this Host; the session supplies the
 * principal, so nothing here carries identity. Responses are validated before
 * they reach the UI, because a panel that renders a half-decoded plan would be
 * claiming the Host said something it did not.
 */
export class HostAutomationClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;
  readonly #workspaceId: string;

  constructor(options: HostAutomationClientOptions) {
    if (
      !options ||
      typeof options.session?.send !== "function" ||
      !idPattern.test(options.hostId ?? "") ||
      !scopedId.test(options.workspaceId ?? "")
    )
      reject("invalid");
    this.#session = options.session;
    this.#hostId = options.hostId;
    this.#workspaceId = options.workspaceId;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }
  get hostId(): string {
    return this.#hostId;
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
      throw classifyAutomationFailure(error);
    }
    try {
      return decode(wire);
    } catch (error) {
      if (error instanceof HostAutomationError) throw error;
      throw new HostAutomationError("response", mutation);
    }
  }

  /** Freezes a NEW non-interactive command session; it writes into no terminal. */
  async defineCommandSession(input: {
    sessionId: string;
    rootPath: string;
    launch: CommandLaunchSpec;
  }): Promise<AutomationCommandSession> {
    if (
      !scopedId.test(input?.sessionId ?? "") ||
      typeof input.rootPath !== "string" ||
      !input.rootPath.trim() ||
      input.rootPath.includes("\u0000") ||
      !input.launch ||
      typeof input.launch.executable !== "string" ||
      !input.launch.executable.trim()
    )
      reject("invalid");
    const request = create(DefineCommandSessionRequestSchema, {
      meta: this.#meta(),
      sessionId: input.sessionId,
      rootPath: input.rootPath,
      launch: input.launch,
    });
    return this.#call(
      "DefineCommandSession",
      toBinary(DefineCommandSessionRequestSchema, request),
      true,
      (wire) =>
        this.#session_(fromBinary(AutomationCommandSessionSchema, wire)),
    );
  }

  async listCommandSessions(
    afterId = "",
    limit = 50,
  ): Promise<ListCommandSessionsResponse> {
    const bounds = page(afterId, limit);
    const request = create(ListCommandSessionsRequestSchema, {
      meta: this.#meta(),
      ...bounds,
    });
    return this.#call(
      "ListCommandSessions",
      toBinary(ListCommandSessionsRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListCommandSessionsResponseSchema, wire);
        if (value.sessions.length > bounds.limit) reject("response");
        for (const session of value.sessions) this.#session_(session);
        if (value.hasMore && (!value.nextId || value.nextId === afterId))
          reject("response");
        return value;
      },
    );
  }

  /** `payload` is the frozen stdin; the Host derives and owns its digest. */
  async definePlan(input: {
    planId: string;
    config: AutomationPlanConfig;
    payload: Uint8Array;
    expectedRevision: bigint;
  }): Promise<AutomationPlanSnapshot> {
    if (
      !scopedId.test(input?.planId ?? "") ||
      !input.config ||
      !input.config.target ||
      !(input.payload instanceof Uint8Array) ||
      input.payload.byteLength > MAX_AUTOMATION_PAYLOAD_BYTES ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision < 0n
    )
      reject("invalid");
    const request = create(DefineAutomationRequestSchema, {
      meta: this.#meta(),
      planId: input.planId,
      config: input.config,
      payload: input.payload,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "Define",
      toBinary(DefineAutomationRequestSchema, request),
      true,
      (wire) => this.#plan(fromBinary(AutomationPlanSnapshotSchema, wire)),
    );
  }

  /**
   * The stdin / prompt a plan was defined with.
   *
   * An edit re-sends the whole configuration, so the form has to start from
   * the payload the plan really has: retyping it is a burden, and sending an
   * empty one would silently turn a plan into one that types nothing.
   */
  async planPayload(planId: string): Promise<Uint8Array> {
    if (!scopedId.test(planId ?? "")) reject("invalid");
    const request = create(GetAutomationPayloadRequestSchema, {
      meta: this.#meta(),
      planId,
    });
    return this.#call(
      "GetPayload",
      toBinary(GetAutomationPayloadRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(GetAutomationPayloadResponseSchema, wire);
        // Bytes for another plan are not an answer to this question.
        if (value.planId !== planId) reject("response");
        if (value.payload.byteLength > MAX_AUTOMATION_PAYLOAD_BYTES)
          reject("response");
        return value.payload;
      },
    );
  }

  /**
   * Activation binds the exact revision, configuration version and digest the
   * user reviewed. A mismatch is the Host's job to refuse, not ours to paper
   * over, so the caller must pass what it actually displayed.
   */
  async activatePlan(input: {
    planId: string;
    expectedRevision: bigint;
    configVersion: bigint;
    configSha256: Uint8Array;
  }): Promise<AutomationPlanSnapshot> {
    if (
      !scopedId.test(input?.planId ?? "") ||
      typeof input.expectedRevision !== "bigint" ||
      typeof input.configVersion !== "bigint" ||
      input.configVersion <= 0n ||
      !(input.configSha256 instanceof Uint8Array) ||
      input.configSha256.byteLength !== 32
    )
      reject("invalid");
    const request = create(ActivateAutomationRequestSchema, {
      meta: this.#meta(),
      planId: input.planId,
      configVersion: input.configVersion,
      configSha256: input.configSha256,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "Activate",
      toBinary(ActivateAutomationRequestSchema, request),
      true,
      (wire) => this.#plan(fromBinary(AutomationPlanSnapshotSchema, wire)),
    );
  }

  async pausePlan(input: {
    planId: string;
    expectedRevision: bigint;
  }): Promise<AutomationPlanSnapshot> {
    if (
      !scopedId.test(input?.planId ?? "") ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision <= 0n
    )
      reject("invalid");
    const request = create(PauseAutomationRequestSchema, {
      meta: this.#meta(),
      planId: input.planId,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "Pause",
      toBinary(PauseAutomationRequestSchema, request),
      true,
      (wire) => this.#plan(fromBinary(AutomationPlanSnapshotSchema, wire)),
    );
  }

  /** One extra manual slot. It never edits the schedule or bypasses the gate. */
  async runNow(input: {
    planId: string;
    expectedRevision: bigint;
  }): Promise<AutomationRunSnapshot> {
    if (
      !scopedId.test(input?.planId ?? "") ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision <= 0n
    )
      reject("invalid");
    const request = create(RunAutomationNowRequestSchema, {
      meta: this.#meta(),
      planId: input.planId,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "RunNow",
      toBinary(RunAutomationNowRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(AutomationRunSnapshotSchema, wire);
        this.#run(value);
        return value;
      },
    );
  }

  async listPlans(
    afterId = "",
    limit = 50,
  ): Promise<ListAutomationPlansResponse> {
    const bounds = page(afterId, limit);
    const request = create(ListAutomationPlansRequestSchema, {
      meta: this.#meta(),
      ...bounds,
    });
    return this.#call(
      "ListPlans",
      toBinary(ListAutomationPlansRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListAutomationPlansResponseSchema, wire);
        if (value.plans.length > bounds.limit) reject("response");
        for (const snapshot of value.plans) this.#plan(snapshot);
        if (value.hasMore && (!value.nextId || value.nextId === afterId))
          reject("response");
        return value;
      },
    );
  }

  async listRuns(
    planId: string,
    afterId = "",
    limit = 50,
  ): Promise<ListAutomationRunsResponse> {
    if (!scopedId.test(planId ?? "")) reject("invalid");
    const bounds = page(afterId, limit);
    const request = create(ListAutomationRunsRequestSchema, {
      meta: this.#meta(),
      planId,
      ...bounds,
    });
    return this.#call(
      "ListRuns",
      toBinary(ListAutomationRunsRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListAutomationRunsResponseSchema, wire);
        if (value.runs.length > bounds.limit) reject("response");
        for (const snapshot of value.runs) {
          this.#run(snapshot);
          if (snapshot.run!.planId !== planId) reject("response");
        }
        if (value.hasMore && (!value.nextId || value.nextId === afterId))
          reject("response");
        return value;
      },
    );
  }

  /** A snapshot missing its digest cannot be activated, so it is not a plan. */
  #plan(snapshot: AutomationPlanSnapshot): AutomationPlanSnapshot {
    const plan = snapshot.plan;
    if (
      !plan ||
      !plan.id ||
      plan.configVersion <= 0n ||
      snapshot.revision <= 0n ||
      snapshot.configSha256.byteLength !== 32 ||
      (plan.config && plan.config.workspaceId !== this.#workspaceId)
    )
      reject("response");
    return snapshot;
  }

  #run(snapshot: AutomationRunSnapshot): AutomationRunSnapshot {
    const run = snapshot.run;
    if (
      !run ||
      !run.id ||
      !run.planId ||
      run.workspaceId !== this.#workspaceId ||
      snapshot.revision <= 0n
    )
      reject("response");
    return snapshot;
  }

  #session_(value: AutomationCommandSession): AutomationCommandSession {
    if (
      !value.sessionId ||
      value.workspaceId !== this.#workspaceId ||
      value.executionHostId !== this.#hostId ||
      value.launchSha256.byteLength !== 32 ||
      value.revision <= 0n
    )
      reject("response");
    return value;
  }
}
