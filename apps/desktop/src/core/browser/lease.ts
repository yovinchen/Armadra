import type { Refusal } from "../collab/refusals";
import {
  DriveLease,
  type IdleWindows,
  LEASE_GENERATION,
  LEASE_HELD_BY_AGENT,
  LEASE_HELD_BY_HUMAN,
  LEASE_REVOKED,
  leaseRefusalFor,
} from "../drive/lease";
import type { Lease } from "./model";
import { freeLease } from "./model";

/**
 * 浏览器这一域的控制租约：谁被允许驱动一个会话。
 *
 * 状态机本身在 `core/drive/lease.ts`——它是中立的，终端域持有它的另一份实例
 * （设计 `agent-delivery.md` §6.2）。这里只剩三样东西：浏览器自己的两个时间
 * 常数、把它们绑上去的 {@link LeaseMachine}，以及把那四个码渲染成浏览器措辞
 * 的 {@link leaseRefusal}。读不取租约，任何输入形状的动作都取，同一时刻只有
 * 一个持有者。两条规矩撑起整个设计：
 *
 * * 刚点了什么的人立刻从 Agent 手里夺走租约，Agent 的**下一次**动作等他停手
 *   ——最多五秒，然后是拒绝而不是无限排队；
 * * 按了「接管」的人直接撤销 Agent 的租约，在他交还之前 Agent 一律被拒。
 */

/**
 * 人最后一次输入这么久之后租约自然失效，于是在等的 Agent 不用谁点什么就能
 * 继续。
 */
export const HUMAN_IDLE_SECONDS = 10;
/**
 * Agent 最后一次动作这么久之后租约自然失效。比人长，因为 Agent 在两次点击
 * 之间要想。
 */
export const AGENT_IDLE_SECONDS = 30;
/**
 * 一次 Agent 动作等人停手多久才被拒。拒绝就是设计本身：一个无限增长的队列会
 * 把「人在打字」变成「Agent 挂了」。
 */
export const AGENT_QUEUE_MS = 5_000;

/** 这一域在拒绝文案里的名字。 */
const SUBJECT = "browser";

const BROWSER_IDLE: IdleWindows = {
  humanIdleSeconds: HUMAN_IDLE_SECONDS,
  agentIdleSeconds: AGENT_IDLE_SECONDS,
};

export {
  LEASE_GENERATION,
  LEASE_HELD_BY_AGENT,
  LEASE_HELD_BY_HUMAN,
  LEASE_REVOKED,
} from "../drive/lease";
export {
  type Actor,
  type Grant,
  GRANTED,
  QUEUE,
  actorId,
  agentActor,
  deviceOrLocal,
  humanActor,
  rfc3339,
  truncateName,
} from "../drive/lease";

/** 拒绝带的那句话，也就是人真正读到的东西。 */
export function leaseRefusal(code: string): Refusal {
  return leaseRefusalFor(code, SUBJECT);
}

/**
 * 绑上浏览器常数的那台状态机。
 *
 * 常数不进共用模块，而是在这里传进构造函数：两个域的窗口差一个量级，一个写在
 * 共用模块里的默认值会安静地把另一个域的策略改掉。
 */
export class LeaseMachine extends DriveLease {
  constructor(storedGeneration: number) {
    super(storedGeneration, BROWSER_IDLE);
  }

  /** 浏览器措辞的拒绝，调用方不必每次传那个名词。 */
  override release(actor: Parameters<DriveLease["release"]>[0]): void {
    super.release(actor, SUBJECT);
  }
}

/** 从存下来的那个代次继续的一台机器。 */
export function resumingLease(storedGeneration: number): LeaseMachine {
  return new LeaseMachine(storedGeneration);
}

/** 没人持有的租约快照，给一个还没有租约的会话。 */
export function freeSnapshot(generation: number): Lease {
  return freeLease(generation);
}
