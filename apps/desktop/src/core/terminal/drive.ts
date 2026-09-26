import type { DatabaseSync } from "node:sqlite";
import {
  type Actor,
  DriveLease,
  type Grant,
  type IdleWindows,
  LEASE_HELD_BY_HUMAN,
  type Lease,
  type LeaseHolder,
  actorId,
  freeLease,
  leaseRefusalText,
  sameHolding,
} from "../drive/lease";
import { audit } from "../identity/audit";

/**
 * 终端节点的驱动租约：现在谁在驱动这块屏幕。
 *
 * 浏览器节点早就回答了这个问题，终端节点没有（设计 `agent-delivery.md` §1.5
 * 的那张对照表）。这里把答案补上，用的是**同一台**状态机（`core/drive/lease.ts`）
 * 与同样的四个错误码——同一件事在两个域不该有两个名字。
 *
 * 不共用实例，也不共用常数（§6.2）：
 *
 *   * 浏览器一次动作按秒算，终端一轮按分钟算，所以 Agent 的空闲窗口是 120 秒
 *     而不是 30 秒——一轮结束之前不该被另一个 Agent 插进来；
 *   * 一个节点可以既有终端又连着浏览器，共用实例意味着「我接管这个浏览器」
 *     顺手撤销了「那个 Agent 驱动自己终端的权利」，而人点接管时说的只是前者；
 *   * 撤销的粒度不同：浏览器撤的是一行 `browser_sessions`，终端撤的是一个 PTY
 *     会话，它有自己的 `generation`，退出即消失。
 *
 * 租约本身只在内存里（§4.4）。落盘的只有代次，写在 `terminal_sessions` 的
 * `drive_generation` 列（迁移 0022）：重启之后没有人持有，但代次从存下来的数
 * 继续，旧客户端手里的号不会绕回来变成当前的。
 */

/** 人停手这么久之后，普通抢占的租约自然过期，队列恢复出队（§6.1）。 */
export const TERMINAL_HUMAN_IDLE_SECONDS = 10;
/**
 * Agent 投完一条之后租约保留这么久。比浏览器的 30 秒长得多：终端的一轮按分钟
 * 算，一轮结束之前不该被另一个 Agent 插进来。
 */
export const TERMINAL_AGENT_IDLE_SECONDS = 120;

/** 这一域在拒绝文案里的名字。 */
export const TERMINAL_SUBJECT = "terminal";

const TERMINAL_IDLE: IdleWindows = {
  humanIdleSeconds: TERMINAL_HUMAN_IDLE_SECONDS,
  agentIdleSeconds: TERMINAL_AGENT_IDLE_SECONDS,
};

/** 租约扫一遍的间隔。「停手十秒自动恢复」的分辨率就是这个数。 */
export const DRIVE_SWEEP_INTERVAL_MS = 1_000;

/** 一个会话被驱动时，事件要带上的那点身份。 */
export interface DriveSessionRef {
  readonly workspaceId: string;
  readonly nodeId: string | null;
}

export interface TerminalDriveOptions {
  readonly database: DatabaseSync;
  /** 注入的，好让用例把时间变成一个值。 */
  readonly now?: () => Date;
  /** 租约真的变了才调用一次；没变不叫。 */
  readonly onChange?: (
    session: DriveSessionRef & { readonly sessionId: string },
    lease: Lease,
  ) => void;
}

/**
 * 每个会话一把租约。
 *
 * 会话没被记过的，一律当作「没有人持有」：这个进程没见过其创建的会话（重启后
 * 恢复的那些）不该因此被锁上，理由与 `DriveBook.permits` 的同一条一样。
 */
export class TerminalDriveBook {
  private readonly leases = new Map<string, DriveLease>();
  private readonly sessions = new Map<string, DriveSessionRef>();
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private readonly onChange: TerminalDriveOptions["onChange"];

  constructor(options: TerminalDriveOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.onChange = options.onChange;
  }

  /** 记下一个会话；代次从它那一行记得的数继续。 */
  remember(sessionId: string, session: DriveSessionRef): void {
    this.sessions.set(sessionId, session);
    if (!this.leases.has(sessionId)) {
      this.leases.set(
        sessionId,
        new DriveLease(this.storedGeneration(sessionId), TERMINAL_IDLE),
      );
    }
  }

  /**
   * 忘掉一个会话。
   *
   * 回收与退出都走这里：租约的对象是一个 PTY 会话，那个进程没了，谁在驱动它
   * 这个问题就不存在了。代次已经落在库里，下一次从那个数继续。
   */
  forget(sessionId: string): void {
    this.leases.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  /** 当前快照；没记过的会话答一个空闲的。 */
  lease(sessionId: string): Lease {
    const machine = this.leases.get(sessionId);
    if (machine === undefined) {
      return freeLease(this.storedGeneration(sessionId));
    }
    machine.expire(this.now());
    return machine.snapshot();
  }

  /** 当前代次。`terminal:drive` 的乐观并发用它。 */
  generation(sessionId: string): number {
    const machine = this.leases.get(sessionId);
    return machine === undefined
      ? this.storedGeneration(sessionId)
      : machine.generation();
  }

  /**
   * 一次输入形状的动作在问能不能继续。
   *
   * 人敲键就是抢占：`request` 对 `human` 在 Agent 持有时直接换手（`queue` 与
   * `LEASE_HELD_BY_AGENT` 只会答给 Agent），所以这条路上「人优先」不是一段
   * 额外的判断，是状态机本来就有的那一行。
   */
  request(sessionId: string, actor: Actor, expected?: number): Grant {
    const machine = this.leases.get(sessionId);
    if (machine === undefined) return { kind: "granted" };
    return this.changing(sessionId, machine, () =>
      machine.request(actor, this.now(), expected),
    );
  }

  /**
   * 人按「接管」。Agent 一律被拒（`LEASE_REVOKED`）直到交还，不自动恢复。
   *
   * 审计写在这里而不是写在附着时：附着只是看，接管是「有人开始替另一个人
   * 按键」，那一刻才值得记（§6.3）。
   */
  takeover(
    sessionId: string,
    actor: Actor,
    principalId = "",
  ): LeaseHolder | undefined {
    const machine = this.leases.get(sessionId);
    if (machine === undefined) return undefined;
    const session = this.sessions.get(sessionId);
    const revoked = this.changing(sessionId, machine, () =>
      machine.takeover(actor, this.now()),
    );
    audit({
      action: "terminal.takeover",
      target: sessionId,
      principalId,
      ...(session === undefined ? {} : { workspaceId: session.workspaceId }),
      detail: {
        by: actorId(actor),
        revoked: revoked === undefined ? "" : revoked.id,
        revokedKind: revoked === undefined ? "" : revoked.kind,
      },
    });
    return revoked;
  }

  /** 交还，或者 Agent 放掉自己的。只有持有者可以。 */
  release(sessionId: string, actor: Actor): void {
    const machine = this.leases.get(sessionId);
    if (machine === undefined) return;
    this.changing(sessionId, machine, () => {
      machine.release(actor, TERMINAL_SUBJECT);
    });
  }

  /**
   * 扫一遍，放掉空闲窗口已经过去的租约。
   *
   * 「停手十秒自动恢复」需要有人来看一眼：没有这一遍，租约要等下一次有人写入
   * 才会过期，而徽标要在没有任何输入的情况下自己翻回去。接管没有窗口，扫不到
   * 它——那正是显式接管与抢占的区别。
   */
  expire(): number {
    const now = this.now();
    let released = 0;
    for (const [sessionId, machine] of this.leases) {
      const before = machine.snapshot();
      if (!machine.expire(now)) continue;
      released += 1;
      this.announce(sessionId, before, machine.snapshot());
    }
    return released;
  }

  /** 拒绝带的那句话，终端措辞。 */
  refusal(code: string): string {
    return leaseRefusalText(code, TERMINAL_SUBJECT);
  }

  /**
   * 排队也是一种「现在不行」。终端不像浏览器那样等五秒再拒——等待的代价在
   * 终端这边是一条排队记录（§4.5），所以这里只把它翻译成一个码，由调用方决定
   * 排队还是回绝。
   */
  code(grant: Grant): string | undefined {
    if (grant.kind === "granted") return undefined;
    return grant.kind === "queue" ? LEASE_HELD_BY_HUMAN : grant.code;
  }

  /** 跑一段可能改变租约的操作，改了就落代次并广播。 */
  private changing<T>(
    sessionId: string,
    machine: DriveLease,
    operation: () => T,
  ): T {
    const before = machine.snapshot();
    const answer = operation();
    this.announce(sessionId, before, machine.snapshot());
    return answer;
  }

  /**
   * 只在「谁在驱动」真的变了时落代次并广播（§58）。
   *
   * 以前按 `sameLease` 判，持有者续期推后的 `expiresAt` 也算一次变化：
   * 人在终端里每敲一个键就向每个客户端广播一帧 `terminal.lease`，每台设备上的
   * 徽标跟着重渲。续期本身照旧每次都做（`DriveLease.request`），所以「停手
   * 十秒自动恢复」「Agent 一轮 120 秒」都与之前一样精确；变的只是不为到期时刻
   * 发帧；core 里要精确的到期时刻读 `lease()` 的当前快照。
   */
  private announce(sessionId: string, before: Lease, after: Lease): void {
    if (sameHolding(before, after)) return;
    if (before.generation !== after.generation) {
      this.storeGeneration(sessionId, after.generation);
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.onChange?.({ ...session, sessionId }, after);
  }

  private storedGeneration(sessionId: string): number {
    try {
      const row = this.database
        .prepare("SELECT drive_generation FROM terminal_sessions WHERE id = ?")
        .get(sessionId) as { drive_generation?: number } | undefined;
      return Math.max(0, Number(row?.drive_generation ?? 0));
    } catch {
      // 库里还没有这一列（一个更老的 core 开着同一个文件）不该让一次按键失败。
      return 0;
    }
  }

  private storeGeneration(sessionId: string, generation: number): void {
    try {
      this.database
        .prepare(
          "UPDATE terminal_sessions SET drive_generation = ? WHERE id = ?",
        )
        .run(generation, sessionId);
    } catch {
      // 同上：代次落不进去，下一次从 0 继续，最坏是一个旧客户端多被拒一次。
    }
  }
}
