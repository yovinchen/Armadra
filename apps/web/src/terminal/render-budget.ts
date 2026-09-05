/**
 * 渲染名额（终端宿主设计 §7.1：「WebGL context 设设备预算（初始 4 个，可按测量
 * 调整），优先焦点实例，回收只释放渲染资源」）。
 *
 * 一块画布上可以摆几十个终端。WebGL 上下文是设备级的稀缺资源——浏览器通常只给
 * 十几个，超了之后最早的那个会被静默丢掉，表现是某个终端突然黑屏。所以名额要
 * 我们自己发：一个模块级登记处，谁在渲染由它说了算。
 *
 * 三条不能破的规矩：
 *  - 回收**只释放渲染资源**（WebGL addon、每帧写入），不动 `Terminal` 实例，
 *    更不动 PTY。丢名额不等于丢内容。
 *  - 焦点实例永远有名额，哪怕因此超出上限一个：用户正在打字的那个终端不能黑。
 *  - 淘汰按最近活跃（LRU），并且平局有确定的顺序，否则测试和界面都会抖。
 *
 * 策略是纯函数 `selectGranted`，登记处只负责「变了就通知」。
 */

/** 设计 §7.1 给的初值。 */
export const DEFAULT_RENDER_BUDGET = 4;

/**
 * 可设范围。下限 1：0 会让每一个终端都退到批量渲染，等于把功能关掉；
 * 上限 24：再多就越过浏览器自己的 WebGL 上下文上限，白白触发静默回收。
 */
export const RENDER_BUDGET_RANGE = [1, 24] as const;

/** 设置页给出的档位。 */
export const RENDER_BUDGET_CHOICES = [2, 4, 8, 16] as const;

/** 焦点实例的优先级：见 `selectGranted`，这一档不受上限约束。 */
export const RENDER_PRIORITY_FOCUSED = 2;
/** 可见但没有焦点。 */
export const RENDER_PRIORITY_VISIBLE = 1;

export interface RenderClaim {
  /** 登记处内部的唯一键（同一个节点重挂两次会有两条，见下）。 */
  id: string;
  priority: number;
  /** 单调递增的活跃序号，越大越新。 */
  seq: number;
}

/**
 * 谁拿到名额。
 *
 * 1. `priority >= RENDER_PRIORITY_FOCUSED` 的全部直接给——**即使超出上限**。
 * 2. 剩下的按「优先级高的在前，同优先级里 `seq` 大的（更近活跃的）在前，
 *    再平局按 id 升序」排队，填满 `limit - 焦点数` 个剩余名额（不小于 0）。
 *
 * 返回值按输入顺序无关的集合给出，调用方只关心「在不在里面」。
 */
export function selectGranted(
  claims: readonly RenderClaim[],
  limit: number,
): Set<string> {
  const granted = new Set<string>();
  const rest: RenderClaim[] = [];
  for (const claim of claims) {
    if (claim.priority >= RENDER_PRIORITY_FOCUSED) granted.add(claim.id);
    else rest.push(claim);
  }
  const remaining = Math.max(0, Math.trunc(limit) - granted.size);
  if (remaining === 0) return granted;
  rest.sort(
    (a, b) =>
      b.priority - a.priority || b.seq - a.seq || (a.id < b.id ? -1 : 1),
  );
  for (const claim of rest.slice(0, remaining)) granted.add(claim.id);
  return granted;
}

export function clampRenderBudget(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_RENDER_BUDGET;
  return Math.min(
    RENDER_BUDGET_RANGE[1],
    Math.max(RENDER_BUDGET_RANGE[0], Math.round(limit)),
  );
}

/* -------------------------------- 登记处 ---------------------------------- */

interface Entry extends RenderClaim {
  granted: boolean;
  onChange: (granted: boolean) => void;
}

let limit = DEFAULT_RENDER_BUDGET;
let sequence = 0;
const entries = new Map<string, Entry>();

export function getRenderBudget(): number {
  return limit;
}

/** 改上限并立刻重算一遍。设置页改档位时用。 */
export function setRenderBudget(next: number): void {
  const clamped = clampRenderBudget(next);
  if (clamped === limit) return;
  limit = clamped;
  reevaluate();
}

/**
 * 申请一个名额，返回释放函数。
 *
 * 没有「改优先级」的接口：优先级变了就释放旧的再申请一次（React 里就是让
 * effect 依赖 `priority`）。重新申请自然拿到更大的 `seq`，这正是我们要的
 * 「最近活跃」语义——被点开、被聚焦的终端应该排到队伍最前面。
 *
 * 键里带一个自增号：StrictMode 的双次 effect、热重载的重挂都可能让同一个
 * `nodeId` 同时有两条登记，用节点 id 直接当键会让后来者把前一条覆盖掉，
 * 前一条的 `onChange` 从此再也收不到通知。
 */
export function claimRenderSlot(
  id: string,
  priority: number,
  onChange: (granted: boolean) => void,
): () => void {
  sequence += 1;
  const key = `${id}#${sequence}`;
  entries.set(key, {
    id: key,
    priority,
    seq: sequence,
    granted: false,
    onChange,
  });
  reevaluate();
  return () => {
    if (!entries.delete(key)) return;
    reevaluate();
  };
}

/** 测试用：清空登记并恢复默认上限。 */
export function resetRenderBudget(): void {
  entries.clear();
  sequence = 0;
  limit = DEFAULT_RENDER_BUDGET;
}

/**
 * 重算并只通知**变了**的那些。
 *
 * 先把新状态全部写回去再回调：回调里可能同步地再申请或释放一次（比如
 * 丢名额后立刻降级重挂），此时登记表必须已经是自洽的。
 */
function reevaluate(): void {
  const granted = selectGranted([...entries.values()], limit);
  const changed: Entry[] = [];
  for (const entry of entries.values()) {
    const next = granted.has(entry.id);
    if (next === entry.granted) continue;
    entry.granted = next;
    changed.push(entry);
  }
  for (const entry of changed) entry.onChange(entry.granted);
}
