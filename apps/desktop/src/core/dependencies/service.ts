import type { DatabaseSync } from "node:sqlite";
import { getAgentStatus } from "../agent/status";
import type { EventBus, WorkspaceEvent } from "../bus";
import { loadNode } from "../collab/nodes";
import type { CollabContext } from "../collab/service";
import { evaluate } from "./evaluate";
import { type LaunchOutcome, launchNode } from "./launch";
import {
  type DependencyRow,
  type DependencyState,
  allWaiting,
  dependenciesOf,
  dependencyById,
  forgetLaunch,
  launchFor,
  markLaunched,
  markObservedBusy,
  noteLaunchAttempt,
  pendingLaunches,
  rebaseline,
  resolveDependency,
  waitingOn,
} from "./store";

/**
 * 依赖编排服务（设计 §6、§9 的 Dependency 一行）。
 *
 * 它是**启动的权威**，页面不再是：条件满足的那一刻由这里起下游，页面开没开
 * 都一样。驱动它的是三样东西，全都来自 core 自己：
 *
 *   * `agent.status`——上游报了一次状态，问问等着它的那些边；
 *   * `terminal.exit`——上游的终端没了，这一轮不会再有结束；
 *   * 一个周期扫描——过期、上游或下游被删、重启之后的恢复、上一次没启动成的
 *     重试。扫描用的判定与事件完全相同（`evaluate.ts`），所以漏掉的事件最多
 *     晚一拍被补上，不会被判成另一个结果。
 *
 * 启动只在「这个下游的每一条边都是 `satisfied` 或 `cancelled`」时发生。
 * `failed` / `missing` / `expired` 停在那里等人：取消那条边就是「不等它了」，
 * 之后其余的边都满足了才启动。
 */

/** 扫描间隔。过期与重试的分辨率就是它。 */
export const DEPENDENCY_SWEEP_MS = 30_000;
/** 启动失败最多试几次，之后启动记成 `failed`，交给人。 */
export const MAX_LAUNCH_ATTEMPTS = 5;

/** 边上可以被人取消的那些状态。 */
const CANCELLABLE: readonly DependencyState[] = [
  "waiting",
  "failed",
  "missing",
  "expired",
];

/** 不再挡着下游的那些状态。 */
const CLEARED: readonly DependencyState[] = ["satisfied", "cancelled"];

export interface DependencyServiceOptions {
  readonly database: DatabaseSync;
  /** 协作上下文，每次现取：终端桥在装配的后半段才交回来，之后还会换。 */
  readonly collab: () => CollabContext | undefined;
  readonly bus?: EventBus | undefined;
  /** 毫秒。 */
  readonly clock?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** 为 `false` 时不武装周期扫描（用例手动调 {@link DependencyService.sweep}）。 */
  readonly sweepEveryMs?: number | false;
}

export class DependencyService {
  private readonly database: DatabaseSync;
  private readonly collab: () => CollabContext | undefined;
  private readonly clock: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly log: (
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** 正在启动的下游。同一个节点不会被两条路径同时启动。 */
  private readonly inFlight = new Map<
    string,
    Promise<LaunchOutcome | undefined>
  >();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly options: DependencyServiceOptions) {
    this.database = options.database;
    this.collab = options.collab;
    this.clock = options.clock ?? (() => Date.now());
    this.delay =
      options.delay ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => {});
  }

  /** 订阅事件、武装扫描，并立刻扫一遍——那一遍就是重启之后的恢复。 */
  start(): void {
    const bus = this.options.bus;
    if (bus !== undefined) {
      this.unsubscribe = bus.on("workspace.event", ({ event }) => {
        this.handleEvent(event);
      });
    }
    const every = this.options.sweepEveryMs ?? DEPENDENCY_SWEEP_MS;
    if (every !== false) {
      this.timer = setInterval(() => {
        void this.sweep().catch((error: unknown) => {
          this.log("依赖扫描失败", { error: describe(error) });
        });
      }, every);
      this.timer.unref?.();
    }
    void this.sweep().catch((error: unknown) => {
      this.log("依赖恢复失败", { error: describe(error) });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.unsubscribe?.();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private nowSeconds(): number {
    return Math.floor(this.clock() / 1000);
  }

  /* --------------------------------- 事件 --------------------------------- */

  handleEvent(event: WorkspaceEvent): void {
    if (this.stopped) return;
    if (event.type === "agent.status") {
      const nodeId = (event.status as { nodeId?: unknown }).nodeId;
      if (typeof nodeId === "string") this.upstreamReported(nodeId);
      return;
    }
    if (event.type === "terminal.exit") {
      if (typeof event.nodeId === "string") this.upstreamExited(event.nodeId);
      return;
    }
    if (event.type === "board.changed") {
      // 节点被删只会以一次保存的形式出现。重判一遍还在等的边比逐条比对便宜，
      // 也不会有第二套「谁算被删了」的判断。只启动这一遍真的改动过的下游：
      // 页面拖一下节点就是一次保存，上一次没启动成的下游不该因此被连着重试。
      for (const nodeId of this.reconcile()) void this.maybeLaunch(nodeId);
    }
  }

  /** 上游报了一次状态。 */
  upstreamReported(upstreamNodeId: string): void {
    const touched = new Set<string>();
    for (const dependency of waitingOn(this.database, upstreamNodeId)) {
      if (this.judge(dependency)) touched.add(dependency.downstreamNodeId);
    }
    for (const nodeId of touched) void this.maybeLaunch(nodeId);
  }

  /**
   * 上游的终端退出了：还在等它的边不会再等到结束。
   *
   * 退出之前那一次 done 已经被 {@link upstreamReported} 判过了，所以这里只动
   * 还在 `waiting` 的边——正常收尾的上游不会因为随后关掉终端而把下游拖成失败。
   */
  upstreamExited(upstreamNodeId: string): void {
    const now = this.nowSeconds();
    for (const dependency of waitingOn(this.database, upstreamNodeId)) {
      // 先按最后一次状态判一次：done 与退出几乎同时到的时候，顺序不该决定结果。
      if (this.judge(dependency)) {
        void this.maybeLaunch(dependency.downstreamNodeId);
        continue;
      }
      resolveDependency(
        this.database,
        dependency.id,
        "failed",
        "upstreamExited",
        now,
      );
    }
  }

  /**
   * 判一条边，并把裁决写进表。改成了终态就答 `true`（下游该重新看一眼）。
   */
  private judge(dependency: DependencyRow): boolean {
    const now = this.nowSeconds();
    if (dependency.expiresAt <= now) {
      return resolveDependency(
        this.database,
        dependency.id,
        "expired",
        "ttl",
        now,
      );
    }
    const node = loadNode(this.database, dependency.upstreamNodeId);
    const status = getAgentStatus(this.database, dependency.upstreamNodeId);
    const verdict = evaluate(dependency, {
      exists: node !== undefined,
      ...(status === undefined ? {} : { status }),
    });
    switch (verdict.kind) {
      case "wait":
        return false;
      case "busy":
        markObservedBusy(this.database, dependency.id, now);
        return false;
      case "rebaseline":
        rebaseline(
          this.database,
          dependency.id,
          verdict.state,
          verdict.eventAt,
          verdict.reason,
          now,
        );
        return false;
      case "satisfied":
        return resolveDependency(
          this.database,
          dependency.id,
          "satisfied",
          null,
          now,
        );
      case "failed":
        return resolveDependency(
          this.database,
          dependency.id,
          "failed",
          verdict.reason,
          now,
        );
      case "missing":
        return resolveDependency(
          this.database,
          dependency.id,
          "missing",
          "upstreamDeleted",
          now,
        );
    }
  }

  /* --------------------------------- 扫描 --------------------------------- */

  /**
   * 一遍完整的对账：每条还在等的边重判一次，每个还没启动的下游看一眼。
   *
   * 重启之后第一遍就是恢复：core 不在的时候报上来的状态已经在
   * `agent_status` 里，按同一个判定补判；上一次启动到一半就被杀掉的下游在这
   * 里重试，`launchNode` 先看前台是不是已经在跑这个 Agent，不会敲第二遍。
   */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    this.reconcile();
    const launches = pendingLaunches(this.database);
    await Promise.all(
      launches.map(async (launch) => {
        if (loadNode(this.database, launch.nodeId) === undefined) {
          forgetLaunch(this.database, launch.nodeId);
          return;
        }
        await this.maybeLaunch(launch.nodeId);
      }),
    );
  }

  /**
   * 每条还在等的边重判一次；下游已经被删掉的，连启动带边一起清掉。答被改成
   * 终态的那些边的下游。
   */
  private reconcile(): Set<string> {
    const touched = new Set<string>();
    if (this.stopped) return touched;
    for (const dependency of allWaiting(this.database)) {
      if (loadNode(this.database, dependency.downstreamNodeId) === undefined) {
        forgetLaunch(this.database, dependency.downstreamNodeId);
        continue;
      }
      if (this.judge(dependency)) touched.add(dependency.downstreamNodeId);
    }
    return touched;
  }

  /* --------------------------------- 启动 --------------------------------- */

  /** 这个下游的每一条边都不再挡着它了，就启动。 */
  maybeLaunch(nodeId: string): Promise<LaunchOutcome | undefined> {
    const running = this.inFlight.get(nodeId);
    if (running !== undefined) return running;
    const launch = launchFor(this.database, nodeId);
    if (launch === undefined || launch.state !== "waiting") {
      return Promise.resolve(undefined);
    }
    const dependencies = dependenciesOf(this.database, nodeId);
    if (!dependencies.every((edge) => CLEARED.includes(edge.state))) {
      return Promise.resolve(undefined);
    }
    const collab = this.collab();
    if (collab === undefined) return Promise.resolve(undefined);
    const attempt = launchNode(
      { collab, clock: this.clock, delay: this.delay, log: this.log },
      launch,
    )
      .then((outcome) => {
        this.settle(nodeId, outcome);
        return outcome;
      })
      .catch((error: unknown) => {
        this.log("依赖满足后启动失败", { nodeId, error: describe(error) });
        this.settle(nodeId, { kind: "retry", reason: "internalError" });
        return undefined;
      })
      .finally(() => {
        this.inFlight.delete(nodeId);
      });
    this.inFlight.set(nodeId, attempt);
    return attempt;
  }

  private settle(nodeId: string, outcome: LaunchOutcome): void {
    const now = this.nowSeconds();
    switch (outcome.kind) {
      case "launched":
        markLaunched(
          this.database,
          nodeId,
          outcome.sessionId,
          outcome.taskQueueId,
          now,
        );
        this.log("依赖满足，已启动下游节点", { nodeId });
        return;
      case "gone":
        forgetLaunch(this.database, nodeId);
        return;
      case "failed":
        noteLaunchAttempt(this.database, nodeId, outcome.reason, true, now);
        return;
      case "retry": {
        const launch = launchFor(this.database, nodeId);
        const exhausted =
          launch !== undefined && launch.attempts + 1 >= MAX_LAUNCH_ATTEMPTS;
        noteLaunchAttempt(
          this.database,
          nodeId,
          outcome.reason,
          exhausted,
          now,
        );
        return;
      }
    }
  }

  /* --------------------------------- 取消 --------------------------------- */

  /**
   * 人不等这条边了（设计 §6：「提供移除依赖或取消操作」）。
   *
   * 取消之后下游重新看一眼：其余的边都已经满足，它就在这里启动——取消最后一
   * 条挡路的边，等于「别等了，现在就开始」。
   */
  cancel(workspaceId: string, dependencyId: string): DependencyRow | undefined {
    const dependency = dependencyById(this.database, dependencyId);
    if (dependency === undefined || dependency.workspaceId !== workspaceId) {
      return undefined;
    }
    resolveDependency(
      this.database,
      dependency.id,
      "cancelled",
      "cancelledByUser",
      this.nowSeconds(),
      CANCELLABLE,
    );
    void this.maybeLaunch(dependency.downstreamNodeId);
    return dependencyById(this.database, dependencyId);
  }

  /** 新建了一组依赖：`current` 且上游早已完成的，现在就该启动。 */
  created(downstreamNodeId: string): Promise<LaunchOutcome | undefined> {
    return this.maybeLaunch(downstreamNodeId);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
