import { attempt } from "./control/send";
import { sendLimits } from "./send-limits";
import { expireQueue, pendingFor } from "./send-queue";
import { type CollabContext, nowSeconds } from "./service";

/**
 * 出队：目标进入 `idle` 的那一刻，把排在它前面的第一条投进去。
 *
 * **不轮询队列。** 触发是 `agent.status` 的发布点——同一条让节点头的状态点变
 * 绿的事件（§4.6 的出队那一行）。收件箱也是这个规矩：这个 core 里没有为了等
 * 一件可能不会发生的事而常驻的循环。
 *
 * 唯一的定时器是每 60 秒一次的过期清扫，它做的是相反的事：让一条**永远等不到**
 * idle 的排队项有一个明确的死亡时刻，而不是在表里躺到下一次重启。
 *
 * 一次只出一条。串行门在 `send-queue.claim` 那条 SQL 里，这里只是不主动去挤：
 * 投完一条之后目标立刻变 `busy`（它开了一轮），下一条自然等下一次 idle。多条
 * 排队项不该在一次空闲窗口里连着粘贴进去——那就是自动化 §5 早就写明的「多条
 * 计划不交错粘贴」。
 */

/** 过期清扫的间隔。与出队无关：出队是事件驱动的。 */
export const SWEEP_INTERVAL_MS = 60_000;

export class SendPump {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();

  /**
   * 上下文现取。`setTerminalBridge` 之后协作上下文整个是一个新对象，取一次存
   * 下来就会一直对着那个没有终端桥的旧的（`schedule/dispatch.ts` 的同一条）。
   */
  constructor(
    private readonly context: () => CollabContext | undefined,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /**
   * 一条 `agent.status` 到了。
   *
   * 两件事：发起者那一侧记一笔（它报了非 `working` 就是它那一轮结束了，扇出
   * 计数清零，§7），目标那一侧看看要不要出队。同一条事件同时是这两件事的触发
   * 点，因为「谁的一轮结束了」和「谁空出来了」问的是同一行。
   */
  noteStatus(nodeId: string, state: string | undefined): void {
    if (nodeId === "") return;
    sendLimits().noteSourceState(nodeId, state);
    void this.drain(nodeId);
  }

  /**
   * 把这个目标队伍里最前面那条投出去，如果它现在真的空闲的话。
   *
   * 状态判断不在这里：`attempt` 会重跑整条门链，而在这里先猜一次只会得到第二
   * 个答案。这里只保证同一个目标不会有两次并发的出队。
   */
  async drain(targetNodeId: string): Promise<void> {
    if (this.running.has(targetNodeId)) return;
    const context = this.context();
    if (context === undefined) return;
    const now = nowSeconds(context);
    const queued = pendingFor(context.database, targetNodeId, now);
    const next = queued.find((item) => item.state === "queued");
    if (next === undefined) return;
    this.running.add(targetNodeId);
    try {
      // 排队项不带参数：`--no-queue` 是一次性的，一条已经排进去的投递按定义
      // 就是愿意等的那种。`--interrupt` 同理——打断是投的那一刻的决定，不是
      // 五分钟后替调用者再做一次。
      await attempt(context, next, { queue: true });
    } catch (error) {
      // 出队时被门链拒绝不是这个泵的失败：那一条已经在 `attempt` 里被落了
      // 状态与理由，调用者会在 `outbox` 里看见。
      this.onError(error);
    } finally {
      this.running.delete(targetNodeId);
    }
  }

  /** 过期清扫。返回这一遍标掉了几条。 */
  sweep(): number {
    const context = this.context();
    if (context === undefined) return 0;
    try {
      return expireQueue(context.database, nowSeconds(context));
    } catch (error) {
      this.onError(error);
      return 0;
    }
  }

  /** 武装那个 `unref` 的定时器。装配一步都不等它。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
