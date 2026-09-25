/**
 * Agent 工作时自动持有的防休眠租约（终端宿主设计 §9，T02）。
 *
 * 租约簿（`power.ts`）与 `/api/power*` 早就在，用它的只有资源面板上那个手动开
 * 关；这一层是设计里「Agent working、活跃自动化运行……按用户偏好申请」那半句的
 * 调用方。它不决定机器能不能被拖着不睡——那是 `power.policy` 的事，策略不放行的
 * 来源照样被记下、照样 `active: false`——它只决定**要不要申请**：
 *
 *   * 有节点报 `working` 时持有一把 `session` 租约；全部空闲、完成、出错、在
 *     等人或退出之后释放。在等人（`blocked` / `waiting`）不算：设计要求长时间
 *     停在一个问题上默认释放，而这里的宽限就是零——人不在的时候，一个等人回答
 *     的 Agent 没有理由让机器整夜醒着。
 *   * 有自动化运行占着目标门（已认领、等目标、在投、已投未结）时持有一把
 *     `automation` 租约。「等明天的计划」不算运行：还没到时隙的计划不占门。
 *   * `power.keepAwakeWhileWorking` 关掉时两把都放。
 *
 * 租约有 TTL 且只由这里续期：这一层停了，没人续的租约到期自己消失；而一个再也
 * 不报状态的节点（CLI 被杀、hook 丢了）在 {@link WORKING_STALE_MS} 之后不再算
 * 在干活，所以失联的上报不会永久留下防休眠。
 */

import {
  LeaseNotFound,
  type PowerLeaseSource,
  type PowerService,
} from "./power";

/** 每把租约的 TTL；续期节奏是它的一半以内。 */
export const KEEP_AWAKE_TTL_SECONDS = 120;
/** 没有事件时也要跑的那一拍：续期、查自动化、清掉失联的上报。 */
export const KEEP_AWAKE_TICK_MS = 30_000;
/**
 * 一个 `working` 多久没有新上报就不再算数。
 *
 * 干活的 CLI 每调一次工具都会再报一次 `working`，半小时一条都没有，更像是上报
 * 的那一头没了，而不是一次真的这么长的思考。
 */
export const WORKING_STALE_MS = 30 * 60_000;

export interface KeepAwakeOptions {
  readonly power: PowerService;
  /** `power.keepAwakeWhileWorking`，读的是当下那一个。 */
  readonly enabled: () => boolean;
  /** 此刻有没有自动化运行在进行。 */
  readonly automationActive: () => boolean;
  readonly now?: () => number;
}

const REASONS: Readonly<Record<"session" | "automation", string>> = {
  session: "agent-working",
  automation: "automation-run",
};

export class KeepAwake {
  /** 报过 `working` 的节点 → 最后一次报的时刻。 */
  private readonly working = new Map<string, number>();
  private readonly held = new Map<"session" | "automation", string>();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: KeepAwakeOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 一条 `agent.status`。 */
  noteStatus(nodeId: string, state: string | undefined): void {
    if (nodeId === "") return;
    if (state === "working") this.working.set(nodeId, this.now());
    else this.working.delete(nodeId);
    this.reconcile();
  }

  /** 节点的终端退出了：上面的 Agent 不会再报任何东西。 */
  noteExit(nodeId: string): void {
    if (!this.working.delete(nodeId)) return;
    this.reconcile();
  }

  /** 让两把租约与「现在该不该醒着」一致。 */
  reconcile(): void {
    const nowMs = this.now();
    for (const [nodeId, at] of this.working) {
      if (nowMs - at >= WORKING_STALE_MS) this.working.delete(nodeId);
    }
    const enabled = this.options.enabled();
    this.hold("session", enabled && this.working.size > 0);
    this.hold("automation", enabled && this.automationActive());
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.reconcile(), KEEP_AWAKE_TICK_MS);
    this.timer.unref?.();
  }

  /** core 退出：自己申请的都放掉。 */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const source of [...this.held.keys()]) this.hold(source, false);
    this.working.clear();
  }

  private automationActive(): boolean {
    try {
      return this.options.automationActive();
    } catch {
      // 调度域读不到（没装配、库在迁移）就当没有：多醒着比少醒着代价大。
      return false;
    }
  }

  private hold(source: "session" | "automation", wanted: boolean): void {
    const id = this.held.get(source);
    if (!wanted) {
      if (id === undefined) return;
      this.held.delete(source);
      this.options.power.release(id);
      return;
    }
    if (id !== undefined) {
      try {
        this.options.power.renew(id, KEEP_AWAKE_TTL_SECONDS);
        return;
      } catch (error) {
        // 过期了，或者有人在面板上手动放掉了：还需要就重新申请一把。
        if (!(error instanceof LeaseNotFound)) throw error;
      }
    }
    const lease = this.options.power.acquire({
      source: source satisfies PowerLeaseSource,
      reason: REASONS[source],
      ttlSeconds: KEEP_AWAKE_TTL_SECONDS,
    });
    this.held.set(source, lease.id);
  }
}
