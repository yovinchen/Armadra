/**
 * 主机与会话资源，以及订阅制的采样循环。移植自
 * `apps/runtime/src/resources/mod.rs`。
 *
 * ## 采样是订阅，不是定时器
 *
 * 没人在看就什么都不测。面板拿一个带 TTL 的订阅并在开着的时候续；采样任务只在至少
 * 有一个活订阅时存在，最后一个过期时自己停。所以一个关上的面板什么都不花——不走一
 * 次进程表、不读一次磁盘、不唤醒一次。
 *
 * 这一版多一道门：**即使订阅还在，没有人连着那个工作空间的事件流时也不发布**。
 * `resource.sample` 只走事件 socket，一个没有订阅者的 socket 意味着这一帧发出去
 * 也没人收。`eventStream()?.subscriberCount` 是那个问题的答案（R1b）。
 *
 * ## 未知是一个值
 *
 * 每一项都可能是 `null`。这个平台答不上来的指标在线上是 `null`、在面板上是一个
 * 破折号——**永远不是 `0`**，那会被读成「空闲」。
 */

import type { DatabaseSync } from "node:sqlite";
import { cpus } from "node:os";
import { randomUUID as uuid } from "node:crypto";

import type { EventBus } from "../bus";
import { eventStream } from "../events";
import type { SettingsStore } from "../settings/store";
import {
  components,
  type PlatformComponent,
  type TrackedProcess,
} from "./platform";
import { memoryPressure, powerSource, swapUsage } from "./platform-probe";
import {
  Sampler,
  childrenByParent,
  cpuPercent,
  hostResources,
  isGone,
  round,
  sessionResources,
  type HostResources,
  type SessionResources,
} from "./sample";
import {
  aliveBackendReferences,
  listOrphans,
  panePids,
  sessionTargets,
  type OrphanSession,
} from "./sessions";

/**
 * 一个订阅在多少倍采样间隔之后过期，下限 {@link MIN_SUBSCRIPTION_TTL_MS}。每个间隔
 * 续一次的面板因此有两次错过续订的余量。
 */
export const TTL_INTERVALS = 3;
export const MIN_SUBSCRIPTION_TTL_MS = 10_000;
export const MAX_SUBSCRIPTIONS = 32;

/**
 * 订阅者能要求的最慢节奏。滚出屏幕的节点徽标要 30 s；这是那个的上限，所以客户端
 * 没法停一个一小时采一次的订阅然后把结果当成当前的。
 */
export const MAX_REQUESTED_INTERVAL_MS = 60_000;

const DEFAULT_INTERVAL_MS = 2_000;

/** 一次资源采样，`GET …/resources` 与 `resource.sample` 事件用的是同一份。 */
export interface ResourceSnapshot {
  readonly workspaceId: string;
  readonly host: HostResources;
  readonly sessions: readonly SessionResources[];
  /** Armadra 自己的进程，和用户的会话分开列。 */
  readonly components: readonly PlatformComponent[];
  readonly orphans: readonly OrphanSession[];
  readonly power: PowerState;
  /** 循环现在实际跑的节奏：所有活订阅里最快的那个。 */
  readonly intervalMs: number;
  readonly sampledAt: string;
}

/**
 * 快照里的电源那一段。
 *
 * 租约的增删（`/api/power/leases*`）不归这个域——这里只报**策略**和抑制机制能不能
 * 用，因为面板在同一屏上显示它们。`leases` 永远是空数组而不是缺席：一个缺席的字段
 * 会让前端的 schema 判成不匹配而整帧丢掉。
 */
export interface PowerState {
  readonly policy: string;
  readonly holding: boolean;
  readonly mechanism: string | null;
  readonly inhibitor: {
    readonly platform: string;
    readonly kind: string | null;
    readonly available: boolean;
    readonly detail: string | null;
  };
  readonly leases: readonly never[];
}

export interface Subscription {
  readonly subscriptionId: string;
  readonly workspaceId: string;
  /**
   * 这个订阅自己的节奏，也是它该按着续的那个。它不一定是样本到达的频率：另一个
   * 订阅者可能在要更快的，而那些所有人都看得到。
   */
  readonly intervalMs: number;
  /** 考虑所有活订阅之后，采样循环实际在跑的节奏。 */
  readonly effectiveIntervalMs: number;
  readonly expiresAt: string;
}

export interface SubscribeRequest {
  /**
   * 续这个订阅而不是拿一个新的。一个已经过期的 id 不是错误：会发一个新订阅，客户端
   * 从响应里得知新的 id。
   */
  readonly subscriptionId?: string;
  /** 这个订阅者多久要一个样本。夹在 `[resources.intervalMs, 60s]`。 */
  readonly intervalMs?: number;
}

interface Watcher {
  readonly workspaceId: string;
  readonly intervalMs: number;
  expiresAtMs: number;
}

export interface ResourceServiceOptions {
  readonly database: DatabaseSync;
  readonly settings: SettingsStore | undefined;
  readonly bus: EventBus;
  readonly dataDir: string;
  readonly now?: () => number;
  /** 哪些工作空间现在有人在看事件流；默认问 R1b 的事件流。 */
  readonly audience?: (workspaceId: string) => number;
  /** 注入的进程表读取，测试用。 */
  readonly sampler?: Sampler;
  /** 语言域记下来的服务器进程。 */
  readonly languageProcesses?: () => readonly TrackedProcess[];
}

export class ResourceService {
  private readonly watchers = new Map<string, Watcher>();
  private readonly sampler: Sampler;
  private readonly now: () => number;
  private readonly audience: (workspaceId: string) => number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ResourceServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sampler = options.sampler ?? new Sampler(this.now);
    this.audience =
      options.audience ??
      ((workspaceId) => eventStream()?.subscriberCount(workspaceId) ?? 0);
  }

  /** 配置好的节奏：任何订阅者能要求的最快值。 */
  private configuredInterval(): number {
    const value = this.options.settings?.get("resources.intervalMs");
    return typeof value === "number" && value > 0 ? value : DEFAULT_INTERVAL_MS;
  }

  /**
   * 一个订阅者被授予什么。要求更慢的被满足；要求比设置更快的不被满足，因为设置就是
   * 预算。
   */
  private grantedInterval(requested: number | undefined): number {
    const configured = this.configuredInterval();
    if (requested === undefined) return configured;
    const ceiling = Math.max(MAX_REQUESTED_INTERVAL_MS, configured);
    return Math.min(Math.max(requested, configured), ceiling);
  }

  /** 循环跑的节奏：所有活订阅里最快的那个。 */
  effectiveInterval(): number {
    this.prune();
    let fastest: number | undefined;
    for (const watcher of this.watchers.values()) {
      if (fastest === undefined || watcher.intervalMs < fastest) {
        fastest = watcher.intervalMs;
      }
    }
    return fastest ?? this.configuredInterval();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, watcher] of this.watchers) {
      if (watcher.expiresAtMs <= now) this.watchers.delete(id);
    }
  }

  /** 拿或者续一个订阅，并在采样循环没在跑时把它起起来。 */
  subscribe(workspaceId: string, request: SubscribeRequest): Subscription {
    const intervalMs = this.grantedInterval(request.intervalMs);
    const ttl = Math.max(intervalMs * TTL_INTERVALS, MIN_SUBSCRIPTION_TTL_MS);
    const expiresAtMs = this.now() + ttl;
    this.prune();
    let id = request.subscriptionId;
    if (id === undefined || !this.watchers.has(id)) {
      id =
        this.watchers.size >= MAX_SUBSCRIPTIONS
          ? // 每个位子都活着；复用最接近过期的那个，而不是无界地长。客户端从
            // 响应里得知它实际拿到的 id。
            ([...this.watchers.entries()].sort(
              (left, right) => left[1].expiresAtMs - right[1].expiresAtMs,
            )[0]?.[0] ?? uuid())
          : uuid();
    }
    this.watchers.set(id, { workspaceId, intervalMs, expiresAtMs });
    this.ensurePump();
    return {
      subscriptionId: id,
      workspaceId,
      intervalMs,
      effectiveIntervalMs: this.effectiveInterval(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /** 丢掉一个订阅。未知 id 被忽略：一个面板关两次不是错误。 */
  unsubscribe(subscriptionId: string): void {
    this.watchers.delete(subscriptionId);
  }

  /** 现在至少有一个活订阅的工作空间。 */
  private subscribedWorkspaces(): string[] {
    this.prune();
    const workspaces = new Set<string>();
    for (const watcher of this.watchers.values()) {
      workspaces.add(watcher.workspaceId);
    }
    return [...workspaces].sort();
  }

  /** 一个工作空间的一次采样。 */
  snapshot(workspaceId: string): ResourceSnapshot {
    const refresh = this.sampler.refresh();
    const pids = panePids(this.options.dataDir);
    const targets = sessionTargets(this.options.database, workspaceId, pids);
    const children = childrenByParent(refresh.table);
    const sessions = targets
      .map((target) =>
        sessionResources(
          target,
          refresh,
          refresh.previousTable,
          refresh.elapsedMs,
          children,
        ),
      )
      .filter((session) => !isGone(session));
    const orphans = listOrphans(
      this.options.database,
      workspaceId,
      aliveBackendReferences(pids),
    );
    const sampledAt = new Date(refresh.atMs).toISOString();
    const cores = cpus().length;
    return {
      workspaceId,
      host: hostResources({
        dataDir: this.options.dataDir,
        cpuCores: cores,
        pressure: memoryPressure(),
        power: powerSource(),
        swap: swapUsage(),
        cpuPercent: hostCpuPercent(refresh, cores),
        sampledAt,
      }),
      sessions,
      components: components({
        table: refresh.table,
        previousTable: refresh.previousTable,
        elapsedMs: refresh.elapsedMs,
        selfPid: process.pid,
        language: this.options.languageProcesses?.() ?? [],
        // 浏览器节点的页面是桌面窗口的客人，所以它的渲染进程属于壳的进程树，
        // 在那里被计入。永远是空而不是被删掉，因为「只有 pid 加启动时间才是身份」
        // 那条规矩值得留着可寻址。
        browsers: [],
      }),
      orphans,
      power: this.powerState(),
      intervalMs: this.effectiveInterval(),
      sampledAt,
    };
  }

  private powerState(): PowerState {
    const policy = this.options.settings?.get("power.policy");
    const available =
      process.platform === "darwin" || process.platform === "linux";
    return {
      policy: typeof policy === "string" ? policy : "manual",
      holding: false,
      mechanism: null,
      inhibitor: {
        platform:
          process.platform === "darwin"
            ? "macos"
            : process.platform === "win32"
              ? "windows"
              : process.platform === "linux"
                ? "linux"
                : "unknown",
        kind: available
          ? process.platform === "darwin"
            ? "caffeinate"
            : "systemd-inhibit"
          : null,
        available,
        detail: available ? null : "no inhibit mechanism on this platform",
      },
      leases: [],
    };
  }

  /**
   * 起采样循环，除非已经有一个在跑。
   *
   * 循环在最后一个订阅过期时自己返回，所以没有人开着面板时什么都不被拖着活。
   */
  private ensurePump(): void {
    if (this.timer !== undefined) return;
    const tick = (): void => {
      const workspaces = this.subscribedWorkspaces();
      if (workspaces.length === 0) {
        this.stop();
        return;
      }
      for (const workspaceId of workspaces) {
        // 即使订阅还在，没有人连着这个工作空间的事件流时这一帧也发不到任何人手里。
        // 不采样，而不是采完再丢掉——采样本身才是那笔开销。
        if (this.audience(workspaceId) === 0) continue;
        try {
          this.options.bus.emit("workspace.event", {
            workspaceId,
            event: {
              type: "resource.sample",
              snapshot: this.snapshot(workspaceId),
            } as never,
          });
        } catch {
          // 一次采样失败不该停掉循环：下一拍再试。
        }
      }
      this.schedule(tick);
    };
    this.schedule(tick);
  }

  private schedule(tick: () => void): void {
    this.timer = setTimeout(tick, this.effectiveInterval());
    // 采样循环不该把进程拖着不退。
    this.timer.unref?.();
  }

  /** 停掉循环。装配方在 core 关闭时调它；循环自己在最后一个订阅过期时也调。 */
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 这一轮有没有一个采样循环在跑，给测试和诊断看。 */
  sampling(): boolean {
    return this.timer !== undefined;
  }
}

/**
 * 全机 CPU：所有进程的 CPU 差之和除以核数。
 *
 * 没有基线时是 `null`——第一次采样没有可减的东西，报 0 会画出一台空闲的机器。
 */
function hostCpuPercent(
  refresh: {
    table: Map<number, import("./sample").ProcessRow>;
    previousTable: Map<number, import("./sample").ProcessRow> | undefined;
    elapsedMs: number;
  },
  cores: number,
): number | null {
  if (refresh.previousTable === undefined || cores <= 0) return null;
  let total = 0;
  let known = false;
  for (const row of refresh.table.values()) {
    const percent = cpuPercent(row, refresh.previousTable, refresh.elapsedMs);
    if (percent !== null) {
      total += percent;
      known = true;
    }
  }
  return known ? round(Math.min(total / cores, 100)) : null;
}
