import { baseAgent, startsSilently } from "../agent/registry";
import { getAgentStatus } from "../agent/status";
import { stateSourceIsReported } from "../agent/target-state";
import { attempt } from "./control/send";
import { loadNode } from "./nodes";
import { sendLimits } from "./send-limits";
import { expireQueue, pendingFor, targetsWithPending } from "./send-queue";
import { type CollabContext, nowSeconds } from "./service";
import { wakeInbox } from "./wake";

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
 * 那把定时器上挂着这条规矩的唯一例外（§4.3）：有一类 CLI 启动完成一条事件都不
 * 发（注册表的 `startsSilently`，今天只有 Codex），它的第一条 `idle` 按定义不
 * 会来，只听事件就是在等一件不会发生的事。所以清扫时顺带对**那一类目标**各试
 * 一次出队——收窄到「队里有东西 + 标了旗 + 从未上报过」，其余目标一个都不问。
 *
 * 一次只出一条。串行门在 `send-queue.claim` 那条 SQL 里，这里只是不主动去挤：
 * 投完一条之后目标立刻变 `busy`（它开了一轮），下一条自然等下一次 idle。多条
 * 排队项不该在一次空闲窗口里连着粘贴进去——那就是自动化 §5 早就写明的「多条
 * 计划不交错粘贴」。
 */

/** 过期清扫的间隔。与出队无关：出队是事件驱动的。 */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * 「启动不上报」目标的快探间隔。只在队里真有这类目标时才转，一轮探完没有
 * 候选就停：静默启动的判据要求会话满 4 秒、安静 3 秒，等 60 秒的清扫来放行
 * 是让人干瞪眼的那种慢。
 */
export const SILENT_PROBE_INTERVAL_MS = 2_000;

export class SendPump {
  private timer: NodeJS.Timeout | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
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
   * 目标的驱动租约放开了。
   *
   * 与 {@link noteStatus} 分开的原因只有一个：人抢占之后停手十秒，租约自己过期
   * 而**目标那一侧什么都不会报**——它本来就空闲着，没有新的一轮，也就没有新的
   * `agent.status`。只听状态事件的话，「停手十秒后自动投进去」会等一个永远不来
   * 的事件。
   */
  noteFree(nodeId: string): void {
    if (nodeId === "") return;
    void this.drain(nodeId);
  }

  /**
   * 有人往这个目标的队里放了一条（`send` 排队、`open-agent --task`、`post`
   * 的唤醒）。先照常试一次出队；若目标是「启动不上报」的那一类，再把快探
   * 转起来——它的第一条空闲不会以事件的形式到来。
   */
  noteQueued(nodeId: string): void {
    if (nodeId === "") return;
    void this.drain(nodeId);
    const context = this.context();
    if (context !== undefined && this.silentStarter(context, nodeId)) {
      this.armProbe();
    }
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
    // 唤醒在出队**之前**（§5 第 1 条）：它塞的是同一条队列里的一条普通排队
    // 项，所以「有没有未读」这个问题和「队伍里有没有人」是同一次回答。
    try {
      wakeInbox(context, targetNodeId);
    } catch (error) {
      this.onError(error);
    }
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
    // 清扫的同时捎带一次首投探测：这把定时器已经在转了，而那类目标需要的正好
    // 是「隔一会儿再看一眼」。不等它的结果——清扫的返回值说的是过期，不是投递。
    void this.probeSilentStarters();
    try {
      return expireQueue(context.database, nowSeconds(context));
    } catch (error) {
      this.onError(error);
      return 0;
    }
  }

  /**
   * 「启动时不上报」的那些目标，各试一次出队。返回试了几个。
   *
   * 这是这条路唯一的触发源，理由是它**没有别的触发源可用**：泵听的是
   * `agent.status`，而 Codex 这类 CLI 在人提交第一条输入之前一条状态都不发
   * （§4.3）。只听事件的话，`open-agent --task` 的第一条任务会一直排到 TTL 过
   * 期——用户实测到的正是这个。
   *
   * 三条一起收窄，轮询没有扩大到所有目标：队里真有东西、目标是这类 CLI、而且
   * 它**从未上报过**。报过一条的节点此后由事件驱动，与从前一模一样。
   */
  async probeSilentStarters(): Promise<number> {
    const context = this.context();
    if (context === undefined) return 0;
    let targets: string[];
    try {
      targets = targetsWithPending(
        context.database,
        nowSeconds(context),
      ).filter((nodeId) => this.silentStarter(context, nodeId));
    } catch (error) {
      this.onError(error);
      return 0;
    }
    // 还有候选就再探一轮；没有了就让它停，下一次入队再转起来。
    if (targets.length > 0) this.armProbe();
    for (const nodeId of targets) {
      await this.drain(nodeId);
    }
    return targets.length;
  }

  private armProbe(): void {
    if (this.probeTimer !== undefined) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      void this.probeSilentStarters();
    }, SILENT_PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
  }

  /** 这个目标是不是「标了旗、且从未上报过」。 */
  private silentStarter(context: CollabContext, nodeId: string): boolean {
    const node = loadNode(context.database, nodeId);
    if (node?.agentId == null) return false;
    if (!startsSilently(baseAgent(context.settings, node.agentId)))
      return false;
    const status = getAgentStatus(context.database, nodeId);
    return !stateSourceIsReported(status?.stateSource);
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
    if (this.probeTimer !== undefined) {
      clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
