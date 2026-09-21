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

/* ---------------------- 启动时不上报的 CLI：第一次投递 --------------------- */

/**
 * 这条路上要求的安静比 {@link OBSERVED_QUIET_MS} 长一秒。
 *
 * 那两秒量的是「我刚打进去一行，它回话了没有」；这里没有人打进去过任何东西，
 * 量的是一个还在铺开界面的 TUI，所以宁可多等一拍。
 */
/**
 * 曾经这里还有一条「3 秒内没有新输出」。真机上它永远不成立：Codex 0.155 的空闲
 * 屏有一层一直在动的背景动画，每秒都有几行在变。所以这条门不看输出，只看有
 * 没有半截没提交的行、以及会话够不够老。
 */
export const SILENT_START_QUIET_MS = 0;

/** 会话建立不满这么久，一律不走这条路。 */
export const SILENT_START_MIN_AGE_MS = 6_000;

export interface SilentStartGate {
  /** 注册表说这家 CLI 启动完成不发事件（`registry.startsSilently`）。 */
  readonly startsSilently: boolean;
  /** 这个节点**曾经**上报过（`stateSourceIsReported`）。 */
  readonly reported: boolean;
  /** 终端域对这个会话的观测；`undefined` 表示它不认识这个会话。 */
  readonly observed: ObservedActivity | undefined;
  /** 会话建立到现在多久；`undefined` 表示不知道。 */
  readonly sessionAgeMs: number | undefined;
  readonly nowMs: number;
}

/**
 * 「从未上报过的 `startsSilently` 节点，此刻可以当作 `idle`」——§4.3 的首投放
 * 行门。
 *
 * 它**不是**第六个状态，也没有动五态本身：`targetState()` 对这种节点仍然答
 * `starting`（它说的是「我们知道什么」，而我们确实什么都没收到）。这个函数说
 * 的是另一件事——「不放行的代价是这条队伍永远不动」，因为那第一条上报按定义
 * 不会来。
 *
 * 四个条件缺一不可，每一个都在挡一种具体的误判：
 *
 *   1. **注册表标了旗**。只有实测过「装好 hook 也不发 `session_start`」的那几
 *      家走这条路；别的 CLI 没报第一条就是还没起来，等着就行。
 *   2. **从未上报过**。报过一条的节点此后永远有上报（包括 `restored` 的行，
 *      它的 `stateSource` 是 `hook`），那种节点按 §4.1 排队，不走这里。
 *   3. **没有半截没提交的行**。投进去就是拼接。不看最近有没有输出：Codex 的
 *      空闲屏一直在动（背景动画），「安静」在它身上永远不成立。
 *   4. **会话不新**。起 PTY 之后 CLI 要几秒才到提示符——
 *      {@link SILENT_START_MIN_AGE_MS} 挡的就是这一段。
 *
 * 会话活着由调用方保证（它是门链上更早的一条：没有会话就是 `exited`）。
 */
export function silentStartIdle(gate: SilentStartGate): boolean {
  if (!gate.startsSilently) return false;
  if (gate.reported) return false;
  if (gate.sessionAgeMs === undefined) return false;
  if (gate.sessionAgeMs < SILENT_START_MIN_AGE_MS) return false;
  if (gate.observed === undefined) return false;
  return !gate.observed.pending;
}
