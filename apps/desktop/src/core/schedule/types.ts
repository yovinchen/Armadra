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
 * 描述符（`*Schema`）是这些记录的字段表，编解码的实现在 `../contract/message`，
 * 域内的入口在 `json.ts`。本文件只管类型与字段表。
 */

import {
  bool,
  bytes,
  create,
  describe,
  enumOf,
  i64,
  msg,
  oneof,
  str,
  strings,
  u32,
  u64,
  type MessageDesc,
} from "../contract/message";

export { create };
export type { MessageDesc };

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

export const AutomationOnceSchema = describe<AutomationOnce>("AutomationOnce", {
  atUnixMs: i64,
});

export const AutomationIntervalSchema = describe<AutomationInterval>(
  "AutomationInterval",
  { anchorUnixMs: i64, intervalMs: i64 },
);

export const AutomationCronSchema = describe<AutomationCron>("AutomationCron", {
  expression: str,
  timezone: str,
});

export const AutomationLoopAfterCompletionSchema =
  describe<AutomationLoopAfterCompletion>("AutomationLoopAfterCompletion", {
    delayMs: i64,
  });

export const AutomationScheduleSchema = describe<AutomationSchedule>(
  "AutomationSchedule",
  {
    kind: oneof({
      once: () => AutomationOnceSchema as MessageDesc<never>,
      interval: () => AutomationIntervalSchema as MessageDesc<never>,
      cron: () => AutomationCronSchema as MessageDesc<never>,
      loopAfterCompletion: () =>
        AutomationLoopAfterCompletionSchema as MessageDesc<never>,
    }),
  },
);

export const AgentLaunchSpecSchema = describe<AgentLaunchSpec>(
  "AgentLaunchSpec",
  {
    agentId: str,
    workingDirectory: str,
    args: strings,
    permissionMode: str,
    modelId: str,
    accountId: str,
  },
);

export const AutomationTargetSchema = describe<AutomationTarget>(
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

export const AutomationPlanConfigSchema = describe<AutomationPlanConfig>(
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

export const AutomationActivationSchema = describe<AutomationActivation>(
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

export const AutomationPlanSchema = describe<AutomationPlan>("AutomationPlan", {
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

export const AutomationRunRefSchema = describe<AutomationRunRef>(
  "AutomationRunRef",
  { runId: str, planId: str, workspaceId: str },
);

export const AutomationTargetGateSchema = describe<AutomationTargetGate>(
  "AutomationTargetGate",
  {
    executionHostId: str,
    sessionId: str,
    active: msg(() => AutomationRunRefSchema),
    nodeId: str,
  },
);

export const AutomationRunSchema = describe<AutomationRun>("AutomationRun", {
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

export const AutomationReceiptSchema = describe<AutomationReceipt>(
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

export const CommandLaunchSpecSchema = describe<CommandLaunchSpec>(
  "CommandLaunchSpec",
  {
    executable: str,
    args: strings,
    workingDirectory: str,
    accountId: str,
    timeoutMs: u64,
  },
);

export const AutomationCommandSessionSchema =
  describe<AutomationCommandSession>("AutomationCommandSession", {
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
  });
