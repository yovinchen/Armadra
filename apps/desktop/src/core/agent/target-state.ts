import type { AgentStatus } from "./status";

/**
 * 投递目标的五态，以及它们各自是从哪两个已有事实算出来的。
 *
 * 纯函数，没有 I/O：设计 `agent-delivery.md` §4.1 的那张表就是这个文件，
 * §4.4 明说这五态**不落库**——它是 `agent_status` 的一行加上「终端域那边还
 * 活着没有」的函数，存下来就会有第三个答案。
 *
 * 归一化不在这里。`core/hook/normalize/*` 已经把六种 CLI 归成
 * `working / waiting / blocked / done`（§4.2 的那张表是这些事件按五态的重排，
 * 用来核对每个状态都有人写），归约的三条时序规矩在 `hook/reduce.ts`。这里只
 * 做最后一步投影。
 */

/** 五态（§4.1）。 */
export type TargetState =
  /** 会话在，但还没有过任何一条**上报**。 */
  | "starting"
  /** 空着，可以直接投。 */
  | "idle"
  /** 正在一轮里。 */
  | "busy"
  /** 停在权限提示或提问上。 */
  | "awaiting-approval"
  /** 没有活着的会话。 */
  | "exited";

export const TARGET_STATES = [
  "starting",
  "idle",
  "busy",
  "awaiting-approval",
  "exited",
] as const satisfies readonly TargetState[];

/**
 * 没有状态适配、只有 PTY 观测的那条路上，回执里写的那个值（§4.3）。
 *
 * 它**不是**第六个状态：五态说的是「我们知道什么」，这个说的是「我们没有适配，
 * 只是看它安静了」。所以它只出现在回执里，`targetState()` 永远不会返回它。
 */
export const OBSERVED_QUIET = "observed-quiet";

/**
 * 一条状态**上报**过的通道（协作通道 §3.2 的 `hook` / `extension`）。
 *
 * `observed` 与空不算：协作通道 §3.4 定死了「`observed` 不得满足空闲门」，
 * 因为一个从没人报过的节点上 `isAwaitingHuman` 恒为 `false`——那条路没法保证
 * 不替人回答权限提示。
 */
export function stateSourceIsReported(source: string | undefined): boolean {
  return source === "hook" || source === "extension";
}

/**
 * 五态投影。
 *
 * `live` 是终端域那边这个会话的 PTY 代次，`undefined` 表示没有活着的会话。
 *
 * 三条容易读错的规矩，逐条写在这里而不是散在调用点：
 *
 *   1. `error` 归 `idle`。一轮失败结束了也是结束了，接下来投进去的东西会正常
 *      开一轮。
 *   2. `restored` 的 `idle` 不算 idle。那是重启后从库里读回来的行，不是一条
 *      新鲜的上报；它走 `starting` 的路径——排队，等下一条真上报
 *      （§4.1、Q4，`hook/reduce.ts` 已有同一条规矩）。
 *   3. 没上报过的通道（`observed` 或空）也不算 idle。此时我们对这个节点一无
 *      所知，答 `starting` 而不是 `idle`；要不要放行由 §4.3 的启发式与
 *      `--unverified` 决定，不是由这里悄悄放过去。
 */
export function targetState(
  status: AgentStatus | undefined,
  live: number | undefined,
): TargetState {
  if (live === undefined) return "exited";
  if (status === undefined) return "starting";
  const state = status.state;
  if (state === undefined || state === "") return "starting";
  // 「在等人」的判据与 `agent/status.ts::isAwaitingHuman`、
  // `terminal/input.ts::BLOCKED_STATES` 是同一份，不另写一遍。
  if (state === "blocked" || state === "waiting") return "awaiting-approval";
  if (state === "working") return "busy";
  if (state !== "done" && state !== "error" && state !== "idle") {
    // 一个谁都不认识的值：当作「还没有可用的上报」，而不是当作空闲。
    return "starting";
  }
  if (status.restored) return "starting";
  if (!stateSourceIsReported(status.stateSource)) return "starting";
  return "idle";
}

/** 这个状态下 `send` 能不能直接投（§4.5 第一列）。 */
export function acceptsDelivery(state: TargetState): boolean {
  return state === "idle";
}

/**
 * 这个状态下等一等还有没有意义。`exited` 没有，`awaiting-approval` 有——它排队
 * 但不投（§4.5：`awaiting-approval` 的节点在任何参数组合下都不会被写入正文）。
 */
export function queueable(state: TargetState): boolean {
  return state !== "exited";
}

/* ----------------------- 没有 hook 的 CLI：提示符就绪 ---------------------- */

/** 输入之后这么久没有新输出，才叫安静（§4.3）。 */
export const OBSERVED_QUIET_MS = 2_000;

/**
 * 终端域对一个没有状态适配的会话知道的全部。
 *
 * 三样都是已有的东西：输入围栏的 `pending`（`terminal/input.ts` 的
 * `InputSafety`）、最后一次输入、最后一次输出。**不**解析提示符，**不**识别
 * OSC（§12 第 3 条）。
 */
export interface ObservedActivity {
  /** 有半截没提交的行。 */
  readonly pending: boolean;
  /** 最后一次写进去的时刻（毫秒）；从没写过是 `undefined`。 */
  readonly lastInputAt: number | undefined;
  /** 最后一次吐出来的时刻（毫秒）；从没吐过是 `undefined`。 */
  readonly lastOutputAt: number | undefined;
}

/**
 * 这条启发式**只用于降级，不用于放行**（§4.3）。
 *
 * 它误判的三个面写在设计里，选这条路的人应该知道自己在赌什么：半截的行、
 * 安静的忙碌（一个跑 30 秒无输出编译的 CLI 与一个空闲提示符在这里完全一样）、
 * 以及权限提示（`observed` 节点上没有「在等人」这个事实）。所以默认行为是
 * 拒绝，显式 `--unverified` 才会走到这里。
 */
export function observedQuiet(
  observed: ObservedActivity,
  nowMs: number,
  quietMs: number = OBSERVED_QUIET_MS,
): boolean {
  if (observed.pending) return false;
  const last = Math.max(observed.lastInputAt ?? 0, observed.lastOutputAt ?? 0);
  if (last === 0) return true;
  return nowMs - last >= quietMs;
}
