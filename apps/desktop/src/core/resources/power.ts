/**
 * 「保持唤醒」的租约簿（契约 §5.1 的 `/api/power*`，终端宿主设计 §9）。
 *
 * 一条长跑的 Agent 会话、一次夜里的定时任务、或者用户自己按下的那个开关，
 * 都可以**申请**让这台机器别睡。三件事这里说清楚：
 *
 *   * **申请一定被记录，不一定生效。** 被策略挡下的申请照样回一个租约，只是
 *     `active: false` 且 `blockedBy` 说得出是 `policy` 还是 `unavailable`。
 *     「为什么跑一半睡过去了」要有地方查，而一个 403 只会让页面上什么都不剩。
 *   * **抑制机制是一个子进程，不是一个 API。** macOS 是 `caffeinate -i`，
 *     Linux 是 `systemd-inhibit --what=idle:sleep --mode=block`，Windows 上
 *     Node 够不到 `SetThreadExecutionState`，所以如实报 `unsupported`。
 *     进程只在**有生效租约时**存在：最后一条走掉它就被杀，core 退出也一样。
 *   * **租约有 TTL。** 持有者崩溃、页面被关掉、Agent 被 `SIGKILL` 都不会让机器
 *     永远醒着——没人续的租约到期自己消失。续期只推后到期时刻，不改创建时刻。
 */

import { type ChildProcess, spawn } from "node:child_process";

import type { PowerLease, PowerState } from "./service";

/** 不指定 `ttlSeconds` 时一条租约活多久。 */
export const DEFAULT_TTL_SECONDS = 300;

/**
 * 单条租约的上限。比这更长的申请被夹到这个数而不是被拒——申请者要的是
 * 「别睡」，不是一个精确的秒数，而一个被拒的申请会让机器立刻可以睡。
 */
export const MAX_TTL_SECONDS = 3600;

/** 扫过期的节奏。够密到一条过期租约不会把机器多醒五分钟。 */
export const SWEEP_INTERVAL_MS = 5_000;

export type PowerLeaseSource = "session" | "automation" | "manual";

export interface PowerLeaseRequest {
  readonly source: PowerLeaseSource;
  readonly reason: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly ttlSeconds?: number;
}

/**
 * 策略允许哪些来源。四档是**递进**的：`never` 谁都不行，`agentSessions` 只放
 * 会话，`automation` 再加定时任务，`manual` 全放。递进而不是四个互不相交的集
 * 合，是因为一个愿意为定时任务醒着的用户，没有理由不为自己正跑着的 Agent 醒着。
 */
const ALLOWED: Readonly<Record<string, readonly PowerLeaseSource[]>> = {
  never: [],
  agentSessions: ["session"],
  automation: ["session", "automation"],
  manual: ["session", "automation", "manual"],
};

/** 这台机器用什么机制抑制休眠，以及它在不在。 */
export interface Inhibitor {
  readonly platform: string;
  readonly kind: string | null;
  readonly available: boolean;
  readonly detail: string | null;
}

export function inhibitorOf(platform: NodeJS.Platform): Inhibitor {
  if (platform === "darwin") {
    return {
      platform: "macos",
      kind: "caffeinate",
      available: true,
      detail: null,
    };
  }
  if (platform === "linux") {
    return {
      platform: "linux",
      kind: "systemd-inhibit",
      available: true,
      detail: null,
    };
  }
  return {
    platform: platform === "win32" ? "windows" : "unknown",
    kind: null,
    available: false,
    detail: "unsupported",
  };
}

/** 抑制进程的命令行，`undefined` 表示这个平台没有。 */
export function inhibitCommand(
  platform: NodeJS.Platform,
): { command: string; args: readonly string[] } | undefined {
  if (platform === "darwin") return { command: "caffeinate", args: ["-i"] };
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--why=Armadra keep awake",
        "--mode=block",
        "sleep",
        "infinity",
      ],
    };
  }
  return undefined;
}

/** 起 / 停抑制进程的那一半，测试里换成一个计数器。 */
export interface InhibitHandle {
  stop(): void;
}

export type Inhibit = () => InhibitHandle | undefined;

export interface PowerOptions {
  /** `power.policy` 设置，读的是**当下**那一个：改策略不必重启。 */
  readonly policy: () => string;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  /** 注入的抑制启动器，测试用。 */
  readonly inhibit?: Inhibit;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Row {
  readonly id: string;
  readonly source: PowerLeaseSource;
  readonly reason: string;
  readonly sessionId: string | null;
  readonly workspaceId: string | null;
  readonly createdMs: number;
  renewedMs: number;
  expiresMs: number;
}

export class LeaseNotFound extends Error {}

export class PowerService {
  private readonly rows = new Map<string, Row>();
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly inhibit: Inhibit;
  private handle: InhibitHandle | undefined;
  private timer: NodeJS.Timeout | undefined;
  private counter = 0;

  constructor(private readonly options: PowerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.platform = options.platform ?? process.platform;
    this.inhibit = options.inhibit ?? (() => spawnInhibitor(this.platform));
  }

  /** `GET /api/power`。 */
  state(): PowerState {
    this.expire();
    const leases = [...this.rows.values()]
      .sort((left, right) => left.createdMs - right.createdMs)
      .map((row) => this.render(row));
    const holding = leases.some((lease) => lease.active);
    return {
      policy: this.policy(),
      holding,
      mechanism: holding ? inhibitorOf(this.platform).kind : null,
      inhibitor: inhibitorOf(this.platform),
      leases,
    };
  }

  /** `POST /api/power/leases`。 */
  acquire(request: PowerLeaseRequest): PowerLease {
    this.expire();
    const nowMs = this.now();
    this.counter += 1;
    const id = `lease-${nowMs.toString(36)}-${this.counter.toString(36)}`;
    const row: Row = {
      id,
      source: request.source,
      reason: request.reason,
      sessionId: request.sessionId ?? null,
      workspaceId: request.workspaceId ?? null,
      createdMs: nowMs,
      renewedMs: nowMs,
      expiresMs: nowMs + ttlMs(request.ttlSeconds),
    };
    this.rows.set(id, row);
    this.settle();
    return this.render(row);
  }

  /** `POST /api/power/leases/{id}/renew`——只推后到期，不动创建时刻。 */
  renew(id: string, ttlSeconds?: number): PowerLease {
    this.expire();
    const row = this.rows.get(id);
    if (row === undefined) throw new LeaseNotFound(id);
    const nowMs = this.now();
    row.renewedMs = nowMs;
    row.expiresMs = nowMs + ttlMs(ttlSeconds);
    this.settle();
    return this.render(row);
  }

  /** `DELETE /api/power/leases/{id}`——已经不在的那条也算释放成功。 */
  release(id: string): PowerState {
    this.rows.delete(id);
    this.settle();
    return this.state();
  }

  /** core 退出：所有租约释放，抑制进程一定被杀。 */
  stop(): void {
    this.rows.clear();
    this.settle();
  }

  private policy(): string {
    const value = this.options.policy();
    return value in ALLOWED ? value : "manual";
  }

  private blockedBy(source: PowerLeaseSource): "policy" | "unavailable" | null {
    if (!inhibitorOf(this.platform).available) return "unavailable";
    return (ALLOWED[this.policy()] ?? []).includes(source) ? null : "policy";
  }

  private render(row: Row): PowerLease {
    const blockedBy = this.blockedBy(row.source);
    return {
      id: row.id,
      source: row.source,
      reason: row.reason,
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      createdAt: new Date(row.createdMs).toISOString(),
      renewedAt: new Date(row.renewedMs).toISOString(),
      expiresAt: new Date(row.expiresMs).toISOString(),
      active: blockedBy === null,
      blockedBy,
    };
  }

  /** 到期的行就地消失。读与写之前都跑一次，所以没有定时器也是对的。 */
  private expire(): void {
    const nowMs = this.now();
    let dropped = false;
    for (const [id, row] of this.rows) {
      if (row.expiresMs > nowMs) continue;
      this.rows.delete(id);
      dropped = true;
    }
    if (dropped) this.settle();
  }

  /**
   * 让抑制进程与「有没有生效租约」一致。
   *
   * 这是唯一起停子进程的地方，所以「进程数 ≤ 1」是这一个函数的性质而不是四个
   * 调用点各自的自觉。
   */
  private settle(): void {
    const wanted = [...this.rows.values()].some(
      (row) => this.blockedBy(row.source) === null,
    );
    if (wanted && this.handle === undefined) {
      this.handle = this.inhibit();
      if (this.handle !== undefined) {
        this.options.log?.("held the machine awake", {
          mechanism: inhibitorOf(this.platform).kind,
        });
      }
    }
    if (!wanted && this.handle !== undefined) {
      this.handle.stop();
      this.handle = undefined;
      this.options.log?.("released the machine");
    }
    this.sweeping(this.rows.size > 0);
  }

  private sweeping(wanted: boolean): void {
    if (wanted && this.timer === undefined) {
      this.timer = setInterval(() => this.expire(), SWEEP_INTERVAL_MS);
      // 一条还没到期的租约不该让 core 退不出去：退出时 `stop()` 会清场。
      this.timer.unref?.();
      return;
    }
    if (!wanted && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

function ttlMs(seconds: number | undefined): number {
  const wanted =
    seconds === undefined || !Number.isFinite(seconds) || seconds <= 0
      ? DEFAULT_TTL_SECONDS
      : Math.trunc(seconds);
  return Math.min(wanted, MAX_TTL_SECONDS) * 1000;
}

/**
 * 真的起一个抑制进程。
 *
 * stdio 全丢：`caffeinate` 与 `systemd-inhibit` 都不说话，而一个没人读的管道
 * 迟早把子进程堵住。`unref` 之后它不再让 core 的事件循环活着——杀它是
 * {@link PowerService.stop} 的责任，不是事件循环的。
 */
function spawnInhibitor(platform: NodeJS.Platform): InhibitHandle | undefined {
  const spec = inhibitCommand(platform);
  if (spec === undefined) return undefined;
  let child: ChildProcess;
  try {
    child = spawn(spec.command, [...spec.args], {
      stdio: "ignore",
      detached: false,
    });
  } catch {
    return undefined;
  }
  // 命令不存在（精简过的 Linux 没有 systemd）不该让一次申请变成 500：
  // 租约照记，只是这台机器上没有人真的醒着。
  child.on("error", () => undefined);
  child.unref();
  return {
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // 已经走了。
      }
    },
  };
}
