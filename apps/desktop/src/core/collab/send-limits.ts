/**
 * 防失控的那几道闸（设计 `agent-delivery.md` §7）。
 *
 * 两个 Agent 互相 `send` 是一个天然的环；没有跳数与速率，环第一次出现就是一次
 * 无人看管的 token 燃烧（§0 的 D7）。这个文件是那几个数与记着它们的那点进程内
 * 状态，纯内存、没有 I/O：
 *
 *   * **速率**按边算，因为失控的形状是一条边被反复走，不是一个节点很忙；
 *   * **跳数与环**按来源链算，链跟着消息走（信封的 `via:` 行、队列的 `trail`
 *     列），所以它不需要一张图，只需要记得「最近投进这个节点的那条消息是从哪
 *     串节点来的」；
 *   * **单回合目标数**按发起者的一轮算。一轮的边界用它自己的状态上报划：它报
 *     了一条非 `working` 就是这一轮结束了。没有状态适配的发起者不设这道闸——
 *     不知道一轮从哪开始，就不该假装知道它有多长。
 *
 * 状态都不落盘。重启之后速率窗口重新开始、来源链清空，最坏是多放行一条；把它
 * 们写进库会让每一次投递多两次写，换来的只是一个环在重启之后仍被记得——而一个
 * 能活过重启的环，第二跳一样会被拦下。
 */

/** 同一 `source → target` 对两次投递至少间隔这么久。 */
export const EDGE_MIN_INTERVAL_MS = 10_000;

/** 发起者一轮里最多投这么多个不同目标。 */
export const MAX_TARGETS_PER_TURN = 4;

/** 来源链超过这么长就是失控，拒 `LOOP_DETECTED`。 */
export const MAX_HOPS = 3;

/** 一条来源链被记得多久；与队列 TTL 同值。 */
export const TRAIL_TTL_MS = 300_000;

export interface RateVerdict {
  readonly allowed: boolean;
  /** 还要等多久。`allowed` 时是 0。 */
  readonly retryAfterMs: number;
}

/**
 * 一个 core 里的一份。实例化而不是模块级变量，好让用例把时间变成一个值，也
 * 好让两个 fixture 不互相污染。
 */
export class SendLimits {
  /** `source>target` → 上一次真的投出去的时刻。 */
  private readonly edges = new Map<string, number>();
  /** 发起者 → 这一轮已经投过的目标。 */
  private readonly turns = new Map<string, Set<string>>();
  /** 节点 → 最近一条投进它的消息的来源链，以及记下的时刻。 */
  private readonly trails = new Map<
    string,
    { readonly trail: readonly string[]; readonly at: number }
  >();

  /**
   * 这条边现在能不能再走一次。**只问，不记**：一次被后面的闸拦下的投递不该占掉
   * 这条边的速率窗口。
   */
  rate(source: string, target: string, nowMs: number): RateVerdict {
    const last = this.edges.get(edgeKey(source, target));
    if (last === undefined) return { allowed: true, retryAfterMs: 0 };
    const waited = nowMs - last;
    return waited >= EDGE_MIN_INTERVAL_MS
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: EDGE_MIN_INTERVAL_MS - waited };
  }

  /**
   * 这一轮还能不能再多一个目标。已经投过的那个目标不算新的——「最多四个不同
   * 目标」说的是扇出，不是次数（次数由速率管）。
   */
  fanout(source: string, target: string): boolean {
    const seen = this.turns.get(source);
    if (seen === undefined) return true;
    if (seen.has(target)) return true;
    return seen.size < MAX_TARGETS_PER_TURN;
  }

  /** 真的投出去了：速率窗口与扇出集合在这一刻才动。 */
  noteDelivered(source: string, target: string, nowMs: number): void {
    this.edges.set(edgeKey(source, target), nowMs);
    const seen = this.turns.get(source) ?? new Set<string>();
    seen.add(target);
    this.turns.set(source, seen);
  }

  /**
   * 发起者报了一条状态。非 `working` 就是它那一轮结束了，扇出集合清空。
   *
   * 一个从没报过状态的发起者永远走不到这里，所以它的 `turns` 永远是空的，
   * {@link fanout} 对它恒真——这正是「不知道一轮多长就不设这道闸」。
   */
  noteSourceState(nodeId: string, state: string | undefined): void {
    if (state === "working") return;
    this.turns.delete(nodeId);
  }

  /**
   * 记下「最近投进这个节点的消息是从哪串节点来的」。下一跳的来源链由它接上。
   */
  noteTrail(nodeId: string, trail: readonly string[], nowMs: number): void {
    this.trails.set(nodeId, { trail: [...trail], at: nowMs });
  }

  /** 这个节点现在往外投，来源链应该是什么。最近的一跳在前。 */
  trailFor(source: string, nowMs: number): readonly string[] {
    const inbound = this.trails.get(source);
    if (inbound === undefined || nowMs - inbound.at > TRAIL_TTL_MS) {
      return [source];
    }
    return [source, ...inbound.trail];
  }

  /** 用例用的：把一切忘掉。 */
  reset(): void {
    this.edges.clear();
    this.turns.clear();
    this.trails.clear();
  }
}

function edgeKey(source: string, target: string): string {
  return `${source}>${target}`;
}

/**
 * 一个 core 一份。协作上下文在 `setTerminalBridge` 之后会被整个替换掉（那是
 * 一个新对象），而速率窗口不该因此清零——所以它挂在模块上而不是挂在上下文里。
 */
let shared = new SendLimits();

export function sendLimits(): SendLimits {
  return shared;
}

/** 用例之间换一份干净的。 */
export function resetSendLimits(): void {
  shared = new SendLimits();
}
