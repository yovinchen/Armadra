import type {
  AutomationPlan,
  AutomationPlanConfig,
  AutomationReceipt,
  AutomationRun,
  AutomationTarget,
} from "@armadra/protocol";

import type { ScheduleStore } from "./store";

/**
 * 调度内核与外界之间的那几个契约。
 *
 * 分出来是因为它们是**两个方向的边界**：内核向下要一个投递方和一个授权方，向上
 * 交出两种快照。把它们和内核写在一个文件里，读的人要先翻过一千行才知道内核到底
 * 依赖什么。
 */

/** 调用方的稳定身份。**永远不要**把浏览器的访问/刷新密钥放进这两个字段。 */
export interface Authorization {
  readonly principalId: string;
  readonly authorizationId: string;
}

export type TargetState =
  | "unknown"
  | "ready"
  | "busy"
  | "offline"
  | "unsupported";

export interface TargetStatus {
  readonly state: TargetState;
  readonly generation: number;
}

/**
 * 投递方。实现必须尊重超时；`lookup` 的「不知道」包括日志本身读不到，
 * 而「没投递」必须有肯定的、持久的证据。
 */
export interface Dispatcher {
  supports(target: AutomationTarget): Promise<TargetStatus>;
  dispatch(run: AutomationRun): Promise<AutomationReceipt | undefined>;
  /** 拿整个运行而不只是操作标识：哪本日志记着这张收据是目标的性质。 */
  lookup(run: AutomationRun): Promise<AutomationReceipt | undefined>;
}

/** 投递时重新核一次授权。核的是当初记下来的那份，不是一个活会话。 */
export interface Authorizer {
  verify(
    authorization: Authorization,
    config: AutomationPlanConfig,
  ): Promise<void>;
}

export interface EngineOptions {
  readonly store: ScheduleStore;
  readonly dispatcher: Dispatcher;
  readonly authorizer: Authorizer;
  readonly hostId: string;
  readonly instanceId?: string;
  readonly clock?: () => number;
  /** 独立注入，给时钟跳变的用例。只管进程内的等待，不进任何持久标识。 */
  readonly monotonic?: () => number;
  readonly claimLeaseMs?: number;
  readonly dispatchTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface PlanSnapshot {
  readonly plan: AutomationPlan;
  readonly revision: number;
}

export interface RunSnapshot {
  readonly run: AutomationRun;
  readonly revision: number;
}
