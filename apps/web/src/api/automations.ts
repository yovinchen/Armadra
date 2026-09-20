/**
 * 自动化面板对 core 的调用面 —— `/api/automations/*`（R7a）。
 *
 * 取代合并前实现的 `HostAutomationClient`：方法名与参数逐条对得上，
 * 换掉的是**传输**与**写入侧的编码**。从前写一个计划要先把配置编成 protobuf 再
 * base64 一次；现在配置、启动参数和载荷都是普通 JSON，载荷是 UTF-8 文本——它本来
 * 就是用户自己敲进去的 prompt，base64 只会让人读不懂自己的计划。
 *
 * 线上的形状与 `github.ts` 同一套（`docs/contracts/core-json-api.md` §4）：
 * camelCase、`int64` / `uint64` 是十进制字符串、`bytes` 是 base64、枚举是枚举值
 * 名、`oneof` 摊平成那一个被设置的字段。这里的 zod 把它解回页面一直用的那套值：
 * `bigint`、`Uint8Array`，以及 `{ case, value }` 形状的日程。
 *
 * `schedule` 那个 `{ case, value }` 是刻意保留的：面板的「一次 / 间隔 / cron /
 * 完成后循环」四选一读的就是 `case`，而一个摊平的对象要在每个读的地方重新问
 * 「这四个字段里哪个在」。
 */

import { z } from "zod";

import {
  RuntimeConnectionError,
  RuntimeRequestError,
  request,
} from "./request";

/* -------------------------------------------------------------------------- */
/*                                   枚举                                      */
/* -------------------------------------------------------------------------- */

export const AutomationPlanState = {
  UNSPECIFIED: "AUTOMATION_PLAN_STATE_UNSPECIFIED",
  DRAFT: "AUTOMATION_PLAN_STATE_DRAFT",
  ACTIVE: "AUTOMATION_PLAN_STATE_ACTIVE",
  PAUSED: "AUTOMATION_PLAN_STATE_PAUSED",
  EXPIRED: "AUTOMATION_PLAN_STATE_EXPIRED",
  DELETED: "AUTOMATION_PLAN_STATE_DELETED",
} as const;
export type AutomationPlanState =
  (typeof AutomationPlanState)[keyof typeof AutomationPlanState];

export const AutomationMisfirePolicy = {
  UNSPECIFIED: "AUTOMATION_MISFIRE_POLICY_UNSPECIFIED",
  SKIP: "AUTOMATION_MISFIRE_POLICY_SKIP",
  COALESCE_ONE: "AUTOMATION_MISFIRE_POLICY_COALESCE_ONE",
} as const;
export type AutomationMisfirePolicy =
  (typeof AutomationMisfirePolicy)[keyof typeof AutomationMisfirePolicy];

export const AutomationConcurrencyPolicy = {
  UNSPECIFIED: "AUTOMATION_CONCURRENCY_POLICY_UNSPECIFIED",
  FORBID: "AUTOMATION_CONCURRENCY_POLICY_FORBID",
  QUEUE_ONE: "AUTOMATION_CONCURRENCY_POLICY_QUEUE_ONE",
} as const;
export type AutomationConcurrencyPolicy =
  (typeof AutomationConcurrencyPolicy)[keyof typeof AutomationConcurrencyPolicy];

export const AutomationRunState = {
  UNSPECIFIED: "AUTOMATION_RUN_STATE_UNSPECIFIED",
  DUE: "AUTOMATION_RUN_STATE_DUE",
  CLAIMED: "AUTOMATION_RUN_STATE_CLAIMED",
  WAITING_TARGET: "AUTOMATION_RUN_STATE_WAITING_TARGET",
  DISPATCHING: "AUTOMATION_RUN_STATE_DISPATCHING",
  DELIVERED: "AUTOMATION_RUN_STATE_DELIVERED",
  RUNNING: "AUTOMATION_RUN_STATE_RUNNING",
  SUCCEEDED: "AUTOMATION_RUN_STATE_SUCCEEDED",
  FAILED: "AUTOMATION_RUN_STATE_FAILED",
  CANCELLED: "AUTOMATION_RUN_STATE_CANCELLED",
  SKIPPED: "AUTOMATION_RUN_STATE_SKIPPED",
  EXPIRED: "AUTOMATION_RUN_STATE_EXPIRED",
  UNKNOWN: "AUTOMATION_RUN_STATE_UNKNOWN",
} as const;
export type AutomationRunState =
  (typeof AutomationRunState)[keyof typeof AutomationRunState];

export const AutomationTargetKind = {
  UNSPECIFIED: "AUTOMATION_TARGET_KIND_UNSPECIFIED",
  NON_INTERACTIVE_COMMAND: "AUTOMATION_TARGET_KIND_NON_INTERACTIVE_COMMAND",
  AGENT_SESSION_PROMPT: "AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT",
} as const;
export type AutomationTargetKind =
  (typeof AutomationTargetKind)[keyof typeof AutomationTargetKind];

export const AutomationColdStartPolicy = {
  UNSPECIFIED: "AUTOMATION_COLD_START_POLICY_UNSPECIFIED",
  SKIP: "AUTOMATION_COLD_START_POLICY_SKIP",
  LAUNCH_FROZEN: "AUTOMATION_COLD_START_POLICY_LAUNCH_FROZEN",
} as const;
export type AutomationColdStartPolicy =
  (typeof AutomationColdStartPolicy)[keyof typeof AutomationColdStartPolicy];

export const AutomationCommandSessionState = {
  UNSPECIFIED: "AUTOMATION_COMMAND_SESSION_STATE_UNSPECIFIED",
  READY: "AUTOMATION_COMMAND_SESSION_STATE_READY",
  UNREBUILDABLE: "AUTOMATION_COMMAND_SESSION_STATE_UNREBUILDABLE",
} as const;
export type AutomationCommandSessionState =
  (typeof AutomationCommandSessionState)[keyof typeof AutomationCommandSessionState];

/* -------------------------------------------------------------------------- */
/*                              解析的零件                                      */
/* -------------------------------------------------------------------------- */

const bigint = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => BigInt(value))
  .catch(0n)
  .default(0n);

const text = z.string().catch("").default("");
const flag = z.boolean().catch(false).default(false);
const smallint = z
  .union([z.string(), z.number()])
  .transform((value) => Number(value))
  .catch(0)
  .default(0);

/** `bytes` 在线上是 base64。 */
const bytes = z
  .string()
  .transform((value) => {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      out[index] = binary.charCodeAt(index);
    }
    return out;
  })
  .catch(new Uint8Array())
  .default(() => new Uint8Array());

function enumOf<T extends Record<string, string>>(
  values: T,
): z.ZodType<T[keyof T]> {
  const known = new Set<string>(Object.values(values));
  const fallback = values.UNSPECIFIED as string;
  // `preprocess` 而不是 `transform`：后者跟着 `z.unknown()` 会让这个键变成可选，
  // 于是一条没带状态的记录解出来是 `undefined`——那正是这里要避免的那种「缺席」。
  return z.preprocess(
    (value) =>
      typeof value === "string" && known.has(value) ? value : fallback,
    z.string(),
  ) as unknown as z.ZodType<T[keyof T]>;
}

const list = <T>(schema: z.ZodType<T>) => z.array(schema).catch([]).default([]);

/* -------------------------------------------------------------------------- */
/*                                  记录                                       */
/* -------------------------------------------------------------------------- */

export interface AgentLaunchSpec {
  agentId: string;
  workingDirectory: string;
  args: string[];
  permissionMode: string;
  modelId: string;
  accountId: string;
}

const agentLaunchSpecSchema: z.ZodType<AgentLaunchSpec> = z.object({
  agentId: text,
  workingDirectory: text,
  args: list(z.string()),
  permissionMode: text,
  modelId: text,
  accountId: text,
});

export interface CommandLaunchSpec {
  executable: string;
  args: string[];
  workingDirectory: string;
  accountId: string;
  timeoutMs: bigint;
}

const commandLaunchSpecSchema: z.ZodType<CommandLaunchSpec> = z.object({
  executable: text,
  args: list(z.string()),
  workingDirectory: text,
  accountId: text,
  timeoutMs: bigint,
});

export interface AutomationTarget {
  executionHostId: string;
  sessionId: string;
  generation: bigint;
  kind: AutomationTargetKind;
  nodeId: string;
  coldStartPolicy: AutomationColdStartPolicy;
  agentLaunch?: AgentLaunchSpec;
}

const automationTargetSchema: z.ZodType<AutomationTarget> = z.object({
  executionHostId: text,
  sessionId: text,
  generation: bigint,
  kind: enumOf(AutomationTargetKind),
  nodeId: text,
  coldStartPolicy: enumOf(AutomationColdStartPolicy),
  agentLaunch: agentLaunchSpecSchema.optional(),
});

/**
 * 日程的四选一。
 *
 * 线上是摊平的（`{ "cron": { … } }`），页面要的是 `{ case, value }`——面板按
 * `case` 分支，而一个摊平的对象会让每个读的地方重新问「这四个字段里哪个在」。
 */
export type AutomationSchedule =
  | { kind: { case: "once"; value: { atUnixMs: bigint } } }
  | {
      kind: {
        case: "interval";
        value: { anchorUnixMs: bigint; intervalMs: bigint };
      };
    }
  | {
      kind: { case: "cron"; value: { expression: string; timezone: string } };
    }
  | {
      kind: {
        case: "loopAfterCompletion";
        value: { delayMs: bigint };
      };
    }
  | { kind: { case: undefined; value?: undefined } };

const scheduleSchema: z.ZodType<AutomationSchedule> = z
  .unknown()
  .transform((raw): AutomationSchedule => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const big = (entry: unknown) => {
      try {
        return BigInt((entry ?? 0) as string | number);
      } catch {
        return 0n;
      }
    };
    if (value.once !== undefined) {
      const once = value.once as Record<string, unknown>;
      return {
        kind: { case: "once", value: { atUnixMs: big(once.atUnixMs) } },
      };
    }
    if (value.interval !== undefined) {
      const interval = value.interval as Record<string, unknown>;
      return {
        kind: {
          case: "interval",
          value: {
            anchorUnixMs: big(interval.anchorUnixMs),
            intervalMs: big(interval.intervalMs),
          },
        },
      };
    }
    if (value.cron !== undefined) {
      const cron = value.cron as Record<string, unknown>;
      return {
        kind: {
          case: "cron",
          value: {
            expression: String(cron.expression ?? ""),
            timezone: String(cron.timezone ?? ""),
          },
        },
      };
    }
    if (value.loopAfterCompletion !== undefined) {
      const loop = value.loopAfterCompletion as Record<string, unknown>;
      return {
        kind: {
          case: "loopAfterCompletion",
          value: { delayMs: big(loop.delayMs) },
        },
      };
    }
    return { kind: { case: undefined } };
  }) as unknown as z.ZodType<AutomationSchedule>;

/** `{ case, value }` → 线上那份摊平的对象。 */
function scheduleToWire(schedule: AutomationSchedule | undefined): unknown {
  const kind = schedule?.kind;
  if (kind === undefined || kind.case === undefined) return {};
  return { [kind.case]: kind.value };
}

export interface AutomationPlanConfig {
  workspaceId: string;
  title: string;
  schedule?: AutomationSchedule;
  target?: AutomationTarget;
  payloadRef: string;
  payloadSha256: Uint8Array;
  misfirePolicy: AutomationMisfirePolicy;
  concurrencyPolicy: AutomationConcurrencyPolicy;
  misfireGraceMs: bigint;
  busyTtlMs: bigint;
  maxRuns: bigint;
  expiresAtUnixMs: bigint;
  safeRetryLimit: number;
  retryBackoffMs: bigint;
}

const planConfigSchema: z.ZodType<AutomationPlanConfig> = z.object({
  workspaceId: text,
  title: text,
  schedule: scheduleSchema.optional(),
  target: automationTargetSchema.optional(),
  payloadRef: text,
  payloadSha256: bytes,
  misfirePolicy: enumOf(AutomationMisfirePolicy),
  concurrencyPolicy: enumOf(AutomationConcurrencyPolicy),
  misfireGraceMs: bigint,
  busyTtlMs: bigint,
  maxRuns: bigint,
  expiresAtUnixMs: bigint,
  safeRetryLimit: smallint,
  retryBackoffMs: bigint,
});

export interface AutomationActivation {
  planId: string;
  configVersion: bigint;
  configSha256: Uint8Array;
  activationSha256: Uint8Array;
  hostId: string;
  principalId: string;
  authorizationId: string;
  authorizedAtUnixMs: bigint;
  enabled: boolean;
}

const activationSchema: z.ZodType<AutomationActivation> = z.object({
  planId: text,
  configVersion: bigint,
  configSha256: bytes,
  activationSha256: bytes,
  hostId: text,
  principalId: text,
  authorizationId: text,
  authorizedAtUnixMs: bigint,
  enabled: flag,
});

export interface AutomationPlan {
  id: string;
  configVersion: bigint;
  config?: AutomationPlanConfig;
  state: AutomationPlanState;
  activationSha256: Uint8Array;
  nextDueUnixMs: bigint;
  observedThroughUnixMs: bigint;
  runCount: bigint;
  activeRunId: string;
  pendingRunId: string;
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  needsAttention: boolean;
  attentionReasonCode: string;
  attentionStreak: number;
}

export const automationPlanSchema: z.ZodType<AutomationPlan> = z.object({
  id: text,
  configVersion: bigint,
  config: planConfigSchema.optional(),
  state: enumOf(AutomationPlanState),
  activationSha256: bytes,
  nextDueUnixMs: bigint,
  observedThroughUnixMs: bigint,
  runCount: bigint,
  activeRunId: text,
  pendingRunId: text,
  createdAtUnixMs: bigint,
  updatedAtUnixMs: bigint,
  needsAttention: flag,
  attentionReasonCode: text,
  attentionStreak: smallint,
});

export interface AutomationRun {
  id: string;
  planId: string;
  workspaceId: string;
  configVersion: bigint;
  scheduledSlot: string;
  scheduledAtUnixMs: bigint;
  misfire: boolean;
  missedSlots: bigint;
  missedSlotsTruncated: boolean;
  frozenConfig?: AutomationPlanConfig;
  activation?: AutomationActivation;
  operationId: string;
  requestSha256: Uint8Array;
  state: AutomationRunState;
  claimOwner: string;
  leaseUntilUnixMs: bigint;
  dispatchAttempts: number;
  nextAttemptUnixMs: bigint;
  waitingExpiresAtUnixMs: bigint;
  receiptSequence: bigint;
  receiptSha256: Uint8Array;
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  completedAtUnixMs: bigint;
  reasonCode: string;
  deliveryObserved: boolean;
}

export const automationRunSchema: z.ZodType<AutomationRun> = z.object({
  id: text,
  planId: text,
  workspaceId: text,
  configVersion: bigint,
  scheduledSlot: text,
  scheduledAtUnixMs: bigint,
  misfire: flag,
  missedSlots: bigint,
  missedSlotsTruncated: flag,
  frozenConfig: planConfigSchema.optional(),
  activation: activationSchema.optional(),
  operationId: text,
  requestSha256: bytes,
  state: enumOf(AutomationRunState),
  claimOwner: text,
  leaseUntilUnixMs: bigint,
  dispatchAttempts: smallint,
  nextAttemptUnixMs: bigint,
  waitingExpiresAtUnixMs: bigint,
  receiptSequence: bigint,
  receiptSha256: bytes,
  createdAtUnixMs: bigint,
  updatedAtUnixMs: bigint,
  completedAtUnixMs: bigint,
  reasonCode: text,
  deliveryObserved: flag,
});

export interface AutomationPlanSnapshot {
  plan?: AutomationPlan;
  revision: bigint;
  /** 存下来那份**规范 JSON** 的摘要，激活时必须带上它。 */
  configSha256: Uint8Array;
}

const planSnapshotSchema: z.ZodType<AutomationPlanSnapshot> = z.object({
  plan: automationPlanSchema.optional(),
  revision: bigint,
  configSha256: bytes,
});

export interface AutomationRunSnapshot {
  run?: AutomationRun;
  revision: bigint;
}

const runSnapshotSchema: z.ZodType<AutomationRunSnapshot> = z.object({
  run: automationRunSchema.optional(),
  revision: bigint,
});

export interface AutomationCommandSession {
  sessionId: string;
  workspaceId: string;
  executionHostId: string;
  rootPath: string;
  launch?: CommandLaunchSpec;
  generation: bigint;
  launchSha256: Uint8Array;
  state: AutomationCommandSessionState;
  reasonCode: string;
  revision: bigint;
  createdAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
}

const commandSessionSchema: z.ZodType<AutomationCommandSession> = z.object({
  sessionId: text,
  workspaceId: text,
  executionHostId: text,
  rootPath: text,
  launch: commandLaunchSpecSchema.optional(),
  generation: bigint,
  launchSha256: bytes,
  state: enumOf(AutomationCommandSessionState),
  reasonCode: text,
  revision: bigint,
  createdAtUnixMs: bigint,
  updatedAtUnixMs: bigint,
});

export interface ListAutomationPlansResponse {
  plans: AutomationPlanSnapshot[];
  nextId: string;
  hasMore: boolean;
}

const listPlansSchema: z.ZodType<ListAutomationPlansResponse> = z.object({
  plans: list(planSnapshotSchema),
  nextId: text,
  hasMore: flag,
});

export interface ListAutomationRunsResponse {
  runs: AutomationRunSnapshot[];
  nextId: string;
  hasMore: boolean;
}

const listRunsSchema: z.ZodType<ListAutomationRunsResponse> = z.object({
  runs: list(runSnapshotSchema),
  nextId: text,
  hasMore: flag,
});

export interface ListCommandSessionsResponse {
  sessions: AutomationCommandSession[];
  nextId: string;
  hasMore: boolean;
}

const listSessionsSchema: z.ZodType<ListCommandSessionsResponse> = z.object({
  sessions: list(commandSessionSchema),
  nextId: text,
  hasMore: flag,
});

const payloadSchema = z.object({
  planId: text,
  payload: text,
  payloadSha256: text,
});

/* -------------------------------------------------------------------------- */
/*                              空记录的工厂                                    */
/* -------------------------------------------------------------------------- */

const zero =
  <T>(base: T) =>
  (init: Partial<T> = {}): T => ({ ...base, ...init });

export const agentLaunchSpec = zero<AgentLaunchSpec>({
  agentId: "",
  workingDirectory: "",
  args: [],
  permissionMode: "",
  modelId: "",
  accountId: "",
});

export const commandLaunchSpec = zero<CommandLaunchSpec>({
  executable: "",
  args: [],
  workingDirectory: "",
  accountId: "",
  timeoutMs: 0n,
});

export const automationTarget = zero<AutomationTarget>({
  executionHostId: "",
  sessionId: "",
  generation: 0n,
  kind: AutomationTargetKind.UNSPECIFIED,
  nodeId: "",
  coldStartPolicy: AutomationColdStartPolicy.UNSPECIFIED,
});

export const automationPlanConfig = zero<AutomationPlanConfig>({
  workspaceId: "",
  title: "",
  payloadRef: "",
  payloadSha256: new Uint8Array(),
  misfirePolicy: AutomationMisfirePolicy.UNSPECIFIED,
  concurrencyPolicy: AutomationConcurrencyPolicy.UNSPECIFIED,
  misfireGraceMs: 0n,
  busyTtlMs: 0n,
  maxRuns: 0n,
  expiresAtUnixMs: 0n,
  safeRetryLimit: 0,
  retryBackoffMs: 0n,
});

export const automationPlan = zero<AutomationPlan>({
  id: "",
  configVersion: 0n,
  state: AutomationPlanState.UNSPECIFIED,
  activationSha256: new Uint8Array(),
  nextDueUnixMs: 0n,
  observedThroughUnixMs: 0n,
  runCount: 0n,
  activeRunId: "",
  pendingRunId: "",
  createdAtUnixMs: 0n,
  updatedAtUnixMs: 0n,
  needsAttention: false,
  attentionReasonCode: "",
  attentionStreak: 0,
});

export const automationRun = zero<AutomationRun>({
  id: "",
  planId: "",
  workspaceId: "",
  configVersion: 0n,
  scheduledSlot: "",
  scheduledAtUnixMs: 0n,
  misfire: false,
  missedSlots: 0n,
  missedSlotsTruncated: false,
  operationId: "",
  requestSha256: new Uint8Array(),
  state: AutomationRunState.UNSPECIFIED,
  claimOwner: "",
  leaseUntilUnixMs: 0n,
  dispatchAttempts: 0,
  nextAttemptUnixMs: 0n,
  waitingExpiresAtUnixMs: 0n,
  receiptSequence: 0n,
  receiptSha256: new Uint8Array(),
  createdAtUnixMs: 0n,
  updatedAtUnixMs: 0n,
  completedAtUnixMs: 0n,
  reasonCode: "",
  deliveryObserved: false,
});

export const automationPlanSnapshot = zero<AutomationPlanSnapshot>({
  revision: 0n,
  configSha256: new Uint8Array(),
});

export const automationRunSnapshot = zero<AutomationRunSnapshot>({
  revision: 0n,
});

/* -------------------------------------------------------------------------- */
/*                                  错误                                       */
/* -------------------------------------------------------------------------- */

export type AutomationApiFailure =
  | "invalid"
  | "unauthenticated"
  | "permission"
  | "unsupported"
  | "notFound"
  | "conflict"
  | "response"
  | "cancelled"
  | "network";

export class AutomationApiError extends Error {
  readonly name = "AutomationApiError";
  constructor(
    readonly failure: AutomationApiFailure,
    /** 一次到达了 core 而结果没有被读到的写。 */
    readonly outcomeUnknown = false,
    readonly httpStatus?: number,
    readonly hostCode?: string,
  ) {
    super(`Automation request failed (${failure}).`);
  }
}

/** 这一面的 `code` 是 snake_case，和其余 `/api/` 一致。 */
export function classifyAutomationFailure(error: unknown): AutomationApiError {
  if (error instanceof AutomationApiError) return error;
  if (error instanceof RuntimeConnectionError)
    return new AutomationApiError("network");
  if (!(error instanceof RuntimeRequestError))
    return new AutomationApiError("network");
  const code = error.code ?? "";
  const fail = (failure: AutomationApiFailure) =>
    new AutomationApiError(failure, false, error.status, code);
  switch (code) {
    case "unauthenticated":
      return fail("unauthenticated");
    case "forbidden":
      return fail("permission");
    case "unsupported":
      return fail("unsupported");
    case "not_found":
      return fail("notFound");
    case "conflict":
      return fail("conflict");
    case "bad_request":
      return fail("invalid");
    default:
      return fail("network");
  }
}

/* -------------------------------------------------------------------------- */
/*                                  客户端                                     */
/* -------------------------------------------------------------------------- */

/** 载荷上限，和 core 的一致。 */
export const MAX_AUTOMATION_PAYLOAD_BYTES = 256 * 1024;

const scopedId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function body(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Uint8Array) {
      let binary = "";
      for (const byte of entry) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
    return entry;
  });
}

function page(after: string, limit: number): { after: string; limit: number } {
  if (typeof after !== "string" || after.length > 512) {
    throw new AutomationApiError("invalid");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new AutomationApiError("invalid");
  }
  return { after, limit };
}

export interface AutomationApiOptions {
  readonly workspaceId: string;
}

/** core 的自动化面，带类型。 */
export class AutomationApi {
  readonly #workspaceId: string;

  constructor(options: AutomationApiOptions) {
    if (!scopedId.test(options?.workspaceId ?? "")) {
      throw new AutomationApiError("invalid");
    }
    this.#workspaceId = options.workspaceId;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  #path(suffix: string, query: Record<string, string> = {}): string {
    const search = new URLSearchParams({
      workspaceId: this.#workspaceId,
      ...query,
    });
    return `/api/automations${suffix}?${search.toString()}`;
  }

  async #call<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<T> {
    try {
      return await request(path, schema, init);
    } catch (error) {
      if (error instanceof z.ZodError) throw new AutomationApiError("response");
      throw classifyAutomationFailure(error);
    }
  }

  /* --------------------------------------------------------- 命令会话 */

  async defineCommandSession(input: {
    sessionId: string;
    rootPath: string;
    launch: CommandLaunchSpec;
  }): Promise<AutomationCommandSession> {
    if (
      !scopedId.test(input?.sessionId ?? "") ||
      typeof input.rootPath !== "string" ||
      !input.rootPath.trim() ||
      input.rootPath.includes(" ") ||
      !input.launch ||
      typeof input.launch.executable !== "string" ||
      !input.launch.executable.trim()
    ) {
      throw new AutomationApiError("invalid");
    }
    return this.#call(this.#path("/command-sessions"), commandSessionSchema, {
      method: "POST",
      body: body({
        sessionId: input.sessionId,
        rootPath: input.rootPath,
        launch: input.launch,
      }),
    });
  }

  async listCommandSessions(
    afterId = "",
    limit = 50,
  ): Promise<ListCommandSessionsResponse> {
    const bounds = page(afterId, limit);
    return this.#call(
      this.#path("/command-sessions", {
        after: bounds.after,
        limit: String(bounds.limit),
      }),
      listSessionsSchema,
    );
  }

  /* --------------------------------------------------------- 计划 */

  async definePlan(input: {
    planId: string;
    config: AutomationPlanConfig;
    /** 冻结的 stdin / prompt。文本，因为它本来就是人敲进去的。 */
    payload: string;
    expectedRevision: bigint;
  }): Promise<AutomationPlanSnapshot> {
    if (
      !scopedId.test(input?.planId ?? "") ||
      !input.config ||
      !input.config.target ||
      typeof input.payload !== "string" ||
      new TextEncoder().encode(input.payload).byteLength >
        MAX_AUTOMATION_PAYLOAD_BYTES ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision < 0n
    ) {
      throw new AutomationApiError("invalid");
    }
    return this.#call(this.#path("/plans"), planSnapshotSchema, {
      method: "POST",
      body: body({
        planId: input.planId,
        config: configToWire(input.config),
        payload: input.payload,
        expectedRevision: Number(input.expectedRevision),
      }),
    });
  }

  /**
   * 读回一个计划冻结的 stdin / prompt。
   *
   * 编辑一个计划要重发整份配置，所以读不回载荷的面板只能让人重打一遍 prompt，
   * 或者悄悄把它换成空的。
   */
  async planPayload(planId: string): Promise<string> {
    if (!scopedId.test(planId ?? "")) throw new AutomationApiError("invalid");
    const answer = await this.#call(
      this.#path(`/plans/${encodeURIComponent(planId)}/payload`),
      payloadSchema,
    );
    // 另一个计划的字节不是这个问题的答案。
    if (answer.planId !== planId) throw new AutomationApiError("response");
    return answer.payload;
  }

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
    ) {
      throw new AutomationApiError("invalid");
    }
    return this.#call(
      this.#path(`/plans/${encodeURIComponent(input.planId)}/activate`),
      planSnapshotSchema,
      {
        method: "POST",
        body: body({
          expectedRevision: Number(input.expectedRevision),
          configVersion: Number(input.configVersion),
          configSha256: input.configSha256,
        }),
      },
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
    ) {
      throw new AutomationApiError("invalid");
    }
    return this.#call(
      this.#path(`/plans/${encodeURIComponent(input.planId)}/pause`),
      planSnapshotSchema,
      {
        method: "POST",
        body: body({ expectedRevision: Number(input.expectedRevision) }),
      },
    );
  }

  /** 多排一个手动时槽。它不改日程，也不绕开闸门、激活检查或并发策略。 */
  async runNow(input: {
    planId: string;
    expectedRevision: bigint;
  }): Promise<AutomationRunSnapshot> {
    if (
      !scopedId.test(input?.planId ?? "") ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision <= 0n
    ) {
      throw new AutomationApiError("invalid");
    }
    return this.#call(
      this.#path(`/plans/${encodeURIComponent(input.planId)}/run`),
      runSnapshotSchema,
      {
        method: "POST",
        body: body({ expectedRevision: Number(input.expectedRevision) }),
      },
    );
  }

  async listPlans(
    afterId = "",
    limit = 50,
  ): Promise<ListAutomationPlansResponse> {
    const bounds = page(afterId, limit);
    return this.#call(
      this.#path("/plans", {
        after: bounds.after,
        limit: String(bounds.limit),
      }),
      listPlansSchema,
    );
  }

  async listRuns(
    planId: string,
    afterId = "",
    limit = 50,
  ): Promise<ListAutomationRunsResponse> {
    if (!scopedId.test(planId ?? "")) throw new AutomationApiError("invalid");
    const bounds = page(afterId, limit);
    return this.#call(
      this.#path(`/plans/${encodeURIComponent(planId)}/runs`, {
        after: bounds.after,
        limit: String(bounds.limit),
      }),
      listRunsSchema,
    );
  }
}

/** 配置 → 线上那份 JSON：只有日程要换形状，其余字段名本来就一样。 */
function configToWire(config: AutomationPlanConfig): Record<string, unknown> {
  return { ...config, schedule: scheduleToWire(config.schedule) };
}

export const automationsApi = {
  /** 一块工作空间上的自动化面。工作空间不合法就在这里被拒。 */
  openAutomations: (workspaceId: string) => new AutomationApi({ workspaceId }),
};
