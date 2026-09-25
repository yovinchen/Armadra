import type { AgentStatus } from "../agent/status";
import type { DependencyCondition, DependencyRow } from "./store";

/**
 * 「上游这一次上报，对等着它的那条边意味着什么」（设计 §6）。
 *
 * 纯函数：输入是边与上游那一行 `agent_status`，输出是一个裁决。服务拿裁决去
 * 改表、去启动；这里不碰数据库，所以每一条规则都能用字面量钉住。
 *
 * 四条规矩，全部来自设计的原话：
 *
 *   1. **只认基准之后的结束。** 创建时记下上游当时的状态与最后一次上报的时
 *      刻；之后的一次 done 要么晚于那个时刻，要么在基准之后见过它忙过——否则
 *      那是一条旧 done，重放它就是「满足一次之后又启动一次」。
 *   2. **失败、中断不放行。** `current` 等的是上游手上这一轮，这一轮失败了，
 *      边就是 `failed`，由人决定；`next` 等的是「下一次成功结束」，失败的一轮
 *      只是还没等到，基准挪过去继续等。
 *   3. **未知不放行。** 从来没报过状态的上游不算完成——乐观放行等于让下游在
 *      别人还没写完时开工。
 *   4. **上游被删不是成功。** 旧的页面实现把它当作满足（等不到了，放行），
 *      这里改成 `missing`，交给人移除这条边或放弃。
 */

/** 上游正在干活，或停在一个问题上：这一轮还没结束。 */
const BUSY_STATES: readonly string[] = ["working", "waiting", "blocked"];

export interface Baseline {
  readonly baselineState: string | null;
  readonly baselineEventAt: string | null;
  readonly observedBusy: boolean;
  /** 创建那一刻就已经成立。 */
  readonly satisfied: boolean;
}

/** 这一行说的是一轮已经结束了。 */
function ended(status: AgentStatus): boolean {
  return status.state === "done" || status.state === "error";
}

/** 结束了，但不是干净地结束。 */
function failure(status: AgentStatus): string | undefined {
  if (status.state === "error" || status.errored === true) {
    return "upstreamFailed";
  }
  if (status.interrupted === true) return "upstreamInterrupted";
  return undefined;
}

function later(value: string | undefined, than: string | null): boolean {
  if (value === undefined) return false;
  if (than === null) return true;
  const a = Date.parse(value);
  const b = Date.parse(than);
  if (Number.isNaN(a) || Number.isNaN(b)) return value > than;
  return a > b;
}

/**
 * 建边那一刻的基准。
 *
 * `current` 且上游已经干净地停下来了：它手上没有「这一轮」可等，等于已经满
 * 足——旧 `--after` 就是这个语义，用户说「等 A 做完」时 A 早就做完了。上游停
 * 在一次失败上则不算：那一轮已经过去了，要等它下一次干净的结束。
 */
export function baselineFor(
  condition: DependencyCondition,
  status: AgentStatus | undefined,
): Baseline {
  if (status === undefined) {
    return {
      baselineState: null,
      baselineEventAt: null,
      observedBusy: false,
      satisfied: false,
    };
  }
  const state = status.state ?? null;
  return {
    baselineState: state,
    baselineEventAt: status.lastEventAt ?? null,
    observedBusy: state !== null && BUSY_STATES.includes(state),
    satisfied:
      condition === "current" &&
      state === "done" &&
      failure(status) === undefined,
  };
}

export type Verdict =
  | { readonly kind: "wait" }
  /** 基准之后第一次见它忙：记下来，之后的第一次结束就是这一轮的。 */
  | { readonly kind: "busy" }
  | { readonly kind: "satisfied" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "missing" }
  /** `next` 撞上了一次失败的结束：不放行，基准挪到这里继续等。 */
  | {
      readonly kind: "rebaseline";
      readonly reason: string;
      readonly state: string | null;
      readonly eventAt: string | null;
    };

export function evaluate(
  dependency: DependencyRow,
  upstream: { readonly exists: boolean; readonly status?: AgentStatus },
): Verdict {
  if (!upstream.exists) return { kind: "missing" };
  const status = upstream.status;
  if (status === undefined || status.state === undefined) {
    return { kind: "wait" };
  }
  if (BUSY_STATES.includes(status.state)) {
    return dependency.observedBusy ? { kind: "wait" } : { kind: "busy" };
  }
  if (!ended(status)) return { kind: "wait" };
  const fresh =
    dependency.observedBusy ||
    later(status.lastEventAt, dependency.baselineEventAt);
  if (!fresh) return { kind: "wait" };
  const failed = failure(status);
  if (failed === undefined) return { kind: "satisfied" };
  if (dependency.condition === "current") {
    return { kind: "failed", reason: failed };
  }
  return {
    kind: "rebaseline",
    reason: failed,
    state: status.state,
    eventAt: status.lastEventAt ?? null,
  };
}
