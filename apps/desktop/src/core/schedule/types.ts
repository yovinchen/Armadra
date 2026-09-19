/**
 * 自动化域自己的类型。
 *
 * R7 之前这些形状由 `proto/armadra/v1/automation.proto` 说了算，类型从
 * `packages/protocol` 的生成码来。`proto/` 与两份生成码在 R7 一起删掉，所以这个
 * 域的记录长什么样，从这里往后由**本文件**回答，线上的字节由
 * `docs/contracts/core-json-api.md` §4 回答——两者说的是同一件事。
 *
 * 保留的三件事与它们的理由：
 *
 *   * **`int64` / `uint64` 是 `bigint`**。运行编号、时间戳与代数都是 64 位，
 *     `number` 在 2^53 之上会悄悄改值，而一个被改了的代数会让投递写进别人的会话。
 *   * **`bytes` 是 `Uint8Array`**。摘要是字节，不是一串碰巧能显示的字符。
 *   * **枚举的值就是它的名字**（`"AUTOMATION_PLAN_STATE_ACTIVE"`）。契约里写的是
 *     名字，让内存里也是名字，编码这一步就没有一张可以对错的映射表。
 *
 * 描述符（`*Schema`）不是为了留着 protobuf，而是因为这个域有十五种记录、每种都
 * 要「建一份带默认值的」「编成 JSON」「从 JSON 读回来」三件事。写成一张字段表，
 * 这三件事各只有一份实现；写成三十份手写函数，它们会各自漂移。编解码在
 * `json.ts`，本文件只管类型、字段表与 `create`。
 */

/* ---------------------------------- 枚举 ---------------------------------- */

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

export const AutomationOutcome = {
  UNSPECIFIED: "AUTOMATION_OUTCOME_UNSPECIFIED",
  UNKNOWN: "AUTOMATION_OUTCOME_UNKNOWN",
  /** 执行方给出的「没有产生任何副作用」的证明。传输失败永远不是这个值。 */
  NOT_DISPATCHED: "AUTOMATION_OUTCOME_NOT_DISPATCHED",
  DELIVERED: "AUTOMATION_OUTCOME_DELIVERED",
  RUNNING: "AUTOMATION_OUTCOME_RUNNING",
  SUCCEEDED: "AUTOMATION_OUTCOME_SUCCEEDED",
  FAILED: "AUTOMATION_OUTCOME_FAILED",
  CANCELLED: "AUTOMATION_OUTCOME_CANCELLED",
} as const;
export type AutomationOutcome =
  (typeof AutomationOutcome)[keyof typeof AutomationOutcome];

export const AutomationTargetKind = {
  /** 按 NON_INTERACTIVE_COMMAND 读：这个字段出现之前存下的计划不该换一种目标。 */
  UNSPECIFIED: "AUTOMATION_TARGET_KIND_UNSPECIFIED",
  NON_INTERACTIVE_COMMAND: "AUTOMATION_TARGET_KIND_NON_INTERACTIVE_COMMAND",
  AGENT_SESSION_PROMPT: "AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT",
} as const;
export type AutomationTargetKind =
  (typeof AutomationTargetKind)[keyof typeof AutomationTargetKind];

export const AutomationColdStartPolicy = {
  /** 按 SKIP 读：计划绝不启动一个没被交代要启动的进程。 */
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

/* ---------------------------------- 记录 ---------------------------------- */

export interface AutomationOnce {
  atUnixMs: bigint;
}

export interface AutomationInterval {
  anchorUnixMs: bigint;
  intervalMs: bigint;
}

export interface AutomationCron {
  expression: string;
  timezone: string;
}

export interface AutomationLoopAfterCompletion {
  delayMs: bigint;
}

/** `oneof kind` 摊平成那一个被设置的分支。没设置就是 `undefined`。 */
export type AutomationScheduleKind =
  | { case: "once"; value: AutomationOnce }
  | { case: "interval"; value: AutomationInterval }
  | { case: "cron"; value: AutomationCron }
  | { case: "loopAfterCompletion"; value: AutomationLoopAfterCompletion }
  | { case: undefined; value?: undefined };

export interface AutomationSchedule {
  kind: AutomationScheduleKind;
}

/** 冻结的 Agent 定义。不含任何凭据。 */
export interface AgentLaunchSpec {
  agentId: string;
  workingDirectory: string;
  args: string[];
  permissionMode: string;
  modelId: string;
  accountId: string;
}

export interface AutomationTarget {
  executionHostId: string;
  sessionId: string;
  generation: bigint;
  kind: AutomationTargetKind;
  nodeId: string;
  coldStartPolicy: AutomationColdStartPolicy;
  agentLaunch?: AgentLaunchSpec;
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

export interface AutomationRunRef {
  runId: string;
  planId: string;
  workspaceId: string;
}

export interface AutomationTargetGate {
  executionHostId: string;
  sessionId: string;
  active?: AutomationRunRef;
  nodeId: string;
}

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

export interface AutomationReceipt {
  operationId: string;
  requestSha256: Uint8Array;
  outcome: AutomationOutcome;
  sequence: bigint;
  observedAtUnixMs: bigint;
  reasonCode: string;
}

export interface CommandLaunchSpec {
  executable: string;
  args: string[];
  workingDirectory: string;
  accountId: string;
  timeoutMs: bigint;
}

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

/* --------------------------------- 字段表 --------------------------------- */

export type FieldDesc =
  | { readonly kind: "string" }
  | { readonly kind: "bool" }
  | { readonly kind: "uint32" }
  | { readonly kind: "int64" }
  | { readonly kind: "uint64" }
  | { readonly kind: "bytes" }
  | { readonly kind: "enum"; readonly unspecified: string }
  | { readonly kind: "strings" }
  | { readonly kind: "message"; readonly of: () => MessageDesc<never> }
  | {
      readonly kind: "oneof";
      readonly cases: Readonly<Record<string, () => MessageDesc<never>>>;
    };

export interface MessageDesc<T> {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldDesc>>;
  /** 只为把描述符和它描述的类型绑在一起，运行时永远是 `undefined`。 */
  readonly _type?: T;
}

const str: FieldDesc = { kind: "string" };
const bool: FieldDesc = { kind: "bool" };
const u32: FieldDesc = { kind: "uint32" };
const i64: FieldDesc = { kind: "int64" };
const u64: FieldDesc = { kind: "uint64" };
const bytes: FieldDesc = { kind: "bytes" };
const strings: FieldDesc = { kind: "strings" };
const enumOf = (unspecified: string): FieldDesc => ({
  kind: "enum",
  unspecified,
});
const msg = <T>(of: () => MessageDesc<T>): FieldDesc => ({
  kind: "message",
  of: of as () => MessageDesc<never>,
});

function desc<T>(
  name: string,
  fields: Readonly<Record<string, FieldDesc>>,
): MessageDesc<T> {
  return { name, fields };
}

export const AutomationOnceSchema = desc<AutomationOnce>("AutomationOnce", {
  atUnixMs: i64,
});

export const AutomationIntervalSchema = desc<AutomationInterval>(
  "AutomationInterval",
  { anchorUnixMs: i64, intervalMs: i64 },
);

export const AutomationCronSchema = desc<AutomationCron>("AutomationCron", {
  expression: str,
  timezone: str,
});

export const AutomationLoopAfterCompletionSchema =
  desc<AutomationLoopAfterCompletion>("AutomationLoopAfterCompletion", {
    delayMs: i64,
  });

export const AutomationScheduleSchema = desc<AutomationSchedule>(
  "AutomationSchedule",
  {
    kind: {
      kind: "oneof",
      cases: {
        once: () => AutomationOnceSchema as MessageDesc<never>,
        interval: () => AutomationIntervalSchema as MessageDesc<never>,
        cron: () => AutomationCronSchema as MessageDesc<never>,
        loopAfterCompletion: () =>
          AutomationLoopAfterCompletionSchema as MessageDesc<never>,
      },
    },
  },
);

export const AgentLaunchSpecSchema = desc<AgentLaunchSpec>("AgentLaunchSpec", {
  agentId: str,
  workingDirectory: str,
  args: strings,
  permissionMode: str,
  modelId: str,
  accountId: str,
});

export const AutomationTargetSchema = desc<AutomationTarget>(
  "AutomationTarget",
  {
    executionHostId: str,
    sessionId: str,
    generation: u64,
    kind: enumOf(AutomationTargetKind.UNSPECIFIED),
    nodeId: str,
    coldStartPolicy: enumOf(AutomationColdStartPolicy.UNSPECIFIED),
    agentLaunch: msg(() => AgentLaunchSpecSchema),
  },
);

export const AutomationPlanConfigSchema = desc<AutomationPlanConfig>(
  "AutomationPlanConfig",
  {
    workspaceId: str,
    title: str,
    schedule: msg(() => AutomationScheduleSchema),
    target: msg(() => AutomationTargetSchema),
    payloadRef: str,
    payloadSha256: bytes,
    misfirePolicy: enumOf(AutomationMisfirePolicy.UNSPECIFIED),
    concurrencyPolicy: enumOf(AutomationConcurrencyPolicy.UNSPECIFIED),
    misfireGraceMs: i64,
    busyTtlMs: i64,
    maxRuns: u64,
    expiresAtUnixMs: i64,
    safeRetryLimit: u32,
    retryBackoffMs: i64,
  },
);

export const AutomationActivationSchema = desc<AutomationActivation>(
  "AutomationActivation",
  {
    planId: str,
    configVersion: u64,
    configSha256: bytes,
    activationSha256: bytes,
    hostId: str,
    principalId: str,
    authorizationId: str,
    authorizedAtUnixMs: i64,
    enabled: bool,
  },
);

export const AutomationPlanSchema = desc<AutomationPlan>("AutomationPlan", {
  id: str,
  configVersion: u64,
  config: msg(() => AutomationPlanConfigSchema),
  state: enumOf(AutomationPlanState.UNSPECIFIED),
  activationSha256: bytes,
  nextDueUnixMs: i64,
  observedThroughUnixMs: i64,
  runCount: u64,
  activeRunId: str,
  pendingRunId: str,
  createdAtUnixMs: i64,
  updatedAtUnixMs: i64,
  needsAttention: bool,
  attentionReasonCode: str,
  attentionStreak: u32,
});

export const AutomationRunRefSchema = desc<AutomationRunRef>(
  "AutomationRunRef",
  { runId: str, planId: str, workspaceId: str },
);

export const AutomationTargetGateSchema = desc<AutomationTargetGate>(
  "AutomationTargetGate",
  {
    executionHostId: str,
    sessionId: str,
    active: msg(() => AutomationRunRefSchema),
    nodeId: str,
  },
);

export const AutomationRunSchema = desc<AutomationRun>("AutomationRun", {
  id: str,
  planId: str,
  workspaceId: str,
  configVersion: u64,
  scheduledSlot: str,
  scheduledAtUnixMs: i64,
  misfire: bool,
  missedSlots: u64,
  missedSlotsTruncated: bool,
  frozenConfig: msg(() => AutomationPlanConfigSchema),
  activation: msg(() => AutomationActivationSchema),
  operationId: str,
  requestSha256: bytes,
  state: enumOf(AutomationRunState.UNSPECIFIED),
  claimOwner: str,
  leaseUntilUnixMs: i64,
  dispatchAttempts: u32,
  nextAttemptUnixMs: i64,
  waitingExpiresAtUnixMs: i64,
  receiptSequence: u64,
  receiptSha256: bytes,
  createdAtUnixMs: i64,
  updatedAtUnixMs: i64,
  completedAtUnixMs: i64,
  reasonCode: str,
  deliveryObserved: bool,
});

export const AutomationReceiptSchema = desc<AutomationReceipt>(
  "AutomationReceipt",
  {
    operationId: str,
    requestSha256: bytes,
    outcome: enumOf(AutomationOutcome.UNSPECIFIED),
    sequence: u64,
    observedAtUnixMs: i64,
    reasonCode: str,
  },
);

export const CommandLaunchSpecSchema = desc<CommandLaunchSpec>(
  "CommandLaunchSpec",
  {
    executable: str,
    args: strings,
    workingDirectory: str,
    accountId: str,
    timeoutMs: u64,
  },
);

export const AutomationCommandSessionSchema = desc<AutomationCommandSession>(
  "AutomationCommandSession",
  {
    sessionId: str,
    workspaceId: str,
    executionHostId: str,
    rootPath: str,
    launch: msg(() => CommandLaunchSpecSchema),
    generation: u64,
    launchSha256: bytes,
    state: enumOf(AutomationCommandSessionState.UNSPECIFIED),
    reasonCode: str,
    revision: u64,
    createdAtUnixMs: i64,
    updatedAtUnixMs: i64,
  },
);

/* ---------------------------------- 造一份 --------------------------------- */

export type DeepPartial<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | Uint8Array
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

function zero(field: FieldDesc): unknown {
  switch (field.kind) {
    case "string":
      return "";
    case "bool":
      return false;
    case "uint32":
      return 0;
    case "int64":
    case "uint64":
      return 0n;
    case "bytes":
      return new Uint8Array(0);
    case "enum":
      return field.unspecified;
    case "strings":
      return [];
    case "message":
      // 消息字段有显式的「在不在」：缺席就是缺席，不是一份全零的子记录。
      return undefined;
    case "oneof":
      return { case: undefined };
  }
}

function coerce(field: FieldDesc, value: unknown): unknown {
  switch (field.kind) {
    case "int64":
    case "uint64":
      return typeof value === "bigint" ? value : BigInt(value as number);
    case "uint32":
      return Number(value);
    case "bytes":
      return value instanceof Uint8Array
        ? value
        : new Uint8Array(value as ArrayLike<number>);
    case "strings":
      return [...(value as readonly string[])];
    case "message":
      return create(field.of(), value as never);
    case "oneof": {
      const chosen = value as { case?: string; value?: unknown } | undefined;
      if (chosen?.case === undefined) return { case: undefined };
      const sub = field.cases[chosen.case];
      if (sub === undefined) {
        throw new Error(`未知的分支 ${chosen.case}`);
      }
      return { case: chosen.case, value: create(sub(), chosen.value as never) };
    }
    default:
      return value;
  }
}

/**
 * 造一份记录：给了的字段按它的类型归一化，没给的填零值。
 *
 * 「没给」和「给了零」得到同一份记录——线上也只有一种写法（零值照写），所以一条
 * 记录在内存里、库里和线上是同一句话。
 */
export function create<T>(
  schema: MessageDesc<T>,
  init: DeepPartial<T> = {} as DeepPartial<T>,
): T {
  const out: Record<string, unknown> = {};
  const given = init as Record<string, unknown>;
  for (const [name, field] of Object.entries(schema.fields)) {
    const value = given[name];
    out[name] = value === undefined ? zero(field) : coerce(field, value);
  }
  return out as T;
}
