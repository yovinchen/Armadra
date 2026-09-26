import { Refusal } from "../collab/refusals";

/**
 * 驱动租约：一块屏幕同一时刻只有一个人（或一个 Agent）在驱动。
 *
 * 这个文件里没有浏览器，也没有终端。它是从浏览器域抽出来的那台状态机本身
 * （设计 `agent-delivery.md` §6.2 D6）：四个状态、四个错误码、代次，以及
 * 「持有者续期不换代次」这条规矩。两个域共用**代码**，各自持有**实例**：
 *
 *   * 语义一样——抢占、接管、代次，一个字都不差，四个码是给模型看的，同一
 *     件事不该在浏览器叫一个名字、在终端叫另一个；
 *   * 时间尺度不一样——浏览器一次动作按秒算，终端一轮按分钟算，所以窗口由
 *     各域在构造时传进来，这个模块里**没有**默认值可以让人弄混。
 *
 * 没有页面、没有数据库、没有自己的时钟：`now` 是参数，所以它实现的那张表
 * 可以一行一行地测。
 */

/* ------------------------------- reason codes ----------------------------- */

/** 人正在驱动；Agent 等过了，放弃。 */
export const LEASE_HELD_BY_HUMAN = "LEASE_HELD_BY_HUMAN";
/**
 * 人按了「接管」。Agent 的租约没了，而且不会自己回来——得有人交还。
 */
export const LEASE_REVOKED = "LEASE_REVOKED";
/** 另一个 Agent 持有。Agent 之间不互相排队。 */
export const LEASE_HELD_BY_AGENT = "LEASE_HELD_BY_AGENT";
/**
 * 调用者手里的 `leaseGeneration` 不是当前那个，所以它对「谁在驱动」的判断
 * 已经过期。
 */
export const LEASE_GENERATION = "LEASE_GENERATION";

/** 四个码，按声明顺序。让用例断言集合，而不是信任没人改过名字。 */
export const LEASE_CODES = [
  LEASE_HELD_BY_HUMAN,
  LEASE_REVOKED,
  LEASE_HELD_BY_AGENT,
  LEASE_GENERATION,
] as const;

/**
 * 拒绝文案。`subject` 是被驱动的那样东西的英文名词（`browser` / `terminal`），
 * 由各域传进来：码是机器读的，这句话是人读的，而人读的那句话里得说清楚是
 * 哪块屏幕。
 */
export function leaseRefusalText(code: string, subject: string): string {
  switch (code) {
    case LEASE_HELD_BY_HUMAN:
      return `LEASE_HELD_BY_HUMAN: somebody is using this ${subject}; try again`;
    case LEASE_REVOKED:
      return `LEASE_REVOKED: a person took over this ${subject}`;
    case LEASE_HELD_BY_AGENT:
      return `LEASE_HELD_BY_AGENT: another agent is using this ${subject}`;
    default:
      return `LEASE_GENERATION: the ${subject} changed hands since you last looked`;
  }
}

/** 同一句话包成一个 409。 */
export function leaseRefusalFor(code: string, subject: string): Refusal {
  return Refusal.conflict(leaseRefusalText(code, subject));
}

/* --------------------------------- the lease ------------------------------ */

/**
 * 谁被允许驱动。一个会话，一个持有者。
 *
 * `humanTakeover` 不只是「一个租期更长的人」：它是人**显式**进入的状态，它
 * 撤销 Agent 的租约而不是让 Agent 等。这个区别就是两个「人」状态而不是一个
 * 的全部理由。
 */
export type LeaseState = "free" | "human" | "humanTakeover" | "agent";

export interface LeaseHolder {
  /** `human` 或 `agent`。 */
  readonly kind: "human" | "agent";
  /**
   * 人是客户端自己的不透明 id，Agent 是节点 id。永远不是一个经过认证的身份，
   * 所以它只用来把持有者彼此分开。
   */
  readonly id: string;
  readonly displayName: string;
}

export interface Lease {
  readonly state: LeaseState;
  readonly generation: number;
  /**
   * RFC 3339；状态不会自己到期时为空串：接管一直持有到人交还为止。
   */
  readonly expiresAt: string;
  readonly holder?: LeaseHolder;
}

export function freeLease(generation: number): Lease {
  return { state: "free", generation, expiresAt: "" };
}

/** 结构相等，也就是「租约变了没有」这句话的意思。 */
export function sameLease(left: Lease, right: Lease): boolean {
  return (
    left.state === right.state &&
    left.generation === right.generation &&
    left.expiresAt === right.expiresAt &&
    left.holder?.kind === right.holder?.kind &&
    left.holder?.id === right.holder?.id &&
    left.holder?.displayName === right.holder?.displayName
  );
}

/**
 * 「谁在驱动」变了没有：同 {@link sameLease}，只是不看 `expiresAt`。
 *
 * 持有者续期只把到期时刻往后推，状态、持有者与代次都不动（「持有者续期不换
 * 代次」）。对看的人来说这不是一件事：徽标画的是谁在驱动，不画倒计时。终端
 * 里人每敲一个键就续一次，按 {@link sameLease} 广播的话每一键都是一帧——
 * 所以广播按这一条判，到期时刻仍然每次都精确地续（空闲窗口的语义一分不差），
 * 只是不为它发帧。
 */
export function sameHolding(left: Lease, right: Lease): boolean {
  return (
    left.state === right.state &&
    left.generation === right.generation &&
    left.holder?.kind === right.holder?.kind &&
    left.holder?.id === right.holder?.id &&
    left.holder?.displayName === right.holder?.displayName
  );
}

/* ---------------------------------- actors -------------------------------- */

/**
 * 谁在问。人由客户端送来的不透明 id 分辨，Agent 由它所在的画布节点分辨。
 */
export type Actor =
  | {
      readonly kind: "human";
      readonly deviceId: string;
      readonly displayName: string;
    }
  | {
      readonly kind: "agent";
      readonly nodeId: string;
      readonly sessionId: string;
      readonly displayName: string;
    };

export function humanActor(deviceId: string, displayName: string): Actor {
  return { kind: "human", deviceId, displayName };
}

export function agentActor(
  nodeId: string,
  sessionId: string,
  displayName: string,
): Actor {
  return { kind: "agent", nodeId, sessionId, displayName };
}

export function actorId(actor: Actor): string {
  return actor.kind === "human" ? actor.deviceId : actor.nodeId;
}

function holderOf(actor: Actor): LeaseHolder {
  return {
    kind: actor.kind,
    id: actorId(actor),
    displayName: actor.displayName,
  };
}

/**
 * 两个空闲窗口，由各域传进来。
 *
 * 这个模块里没有它们的默认值：浏览器是 10 / 30 秒，终端是 10 / 120 秒，一个
 * 写错的默认值会安静地把另一个域的策略改掉（§11 阶段 B 的风险项）。
 */
export interface IdleWindows {
  /** 人最后一次输入之后多久租约自然失效。 */
  readonly humanIdleSeconds: number;
  /** Agent 最后一次动作之后多久租约自然失效。 */
  readonly agentIdleSeconds: number;
}

/** 状态机对一次请求的答复。 */
export type Grant =
  /** 调用者持有租约，可以动手。 */
  | { readonly kind: "granted" }
  /** 人正在输入。等他停手——等多久是各域自己的策略。 */
  | { readonly kind: "queue" }
  | { readonly kind: "refused"; readonly code: string };

export const GRANTED: Grant = { kind: "granted" };
export const QUEUE: Grant = { kind: "queue" };

function refused(code: string): Grant {
  return { kind: "refused", code };
}

/* -------------------------------- the machine ------------------------------ */

/**
 * 一个会话的租约。只在内存里：core 重启之后没有人持有，代次从库里存的那个数
 * 继续，所以旧客户端手里的号不会绕回来变成当前的。
 */
export class DriveLease {
  private state: LeaseState = "free";
  private holder: LeaseHolder | undefined;
  /**
   * Agent 自己的 CLI 会话。不放进 {@link LeaseHolder}：徽标不显示它。
   */
  private agentSession = "";
  private expiresAt: Date | undefined;
  private leaseGeneration: number;
  private readonly idle: IdleWindows;

  /** 一个空闲的租约，代次从那一行记得的数继续。 */
  constructor(storedGeneration: number, idle: IdleWindows) {
    this.leaseGeneration = storedGeneration;
    this.idle = idle;
  }

  generation(): number {
    return this.leaseGeneration;
  }

  currentState(): LeaseState {
    return this.state;
  }

  /**
   * Agent 持有时，它自己的那个 CLI 会话。
   *
   * 不是 {@link Lease} 的一部分：徽标说的是谁在驱动，而一个 Agent 的会话 id
   * 对看的人没有用处。留着它，是因为交接或重启要判断持有者是不是还是同一次
   * 运行时问的就是「那个节点的哪一次会话」。
   */
  holderSession(): string {
    return this.agentSession;
  }

  snapshot(): Lease {
    const base = {
      state: this.state,
      generation: this.leaseGeneration,
      expiresAt: this.expiresAt === undefined ? "" : rfc3339(this.expiresAt),
    };
    return this.holder === undefined ? base : { ...base, holder: this.holder };
  }

  /** 这个 actor 是不是当前的持有者。 */
  private heldBy(actor: Actor): boolean {
    if (this.holder === undefined) return false;
    return this.holder.kind === actor.kind && this.holder.id === actorId(actor);
  }

  private idleSeconds(actor: Actor): number {
    return actor.kind === "human"
      ? this.idle.humanIdleSeconds
      : this.idle.agentIdleSeconds;
  }

  /**
   * 放掉一个空闲窗口已经过去的租约。接管没有窗口：它一直持有到人交还。
   */
  expire(now: Date): boolean {
    if (this.expiresAt === undefined) return false;
    if (now.getTime() < this.expiresAt.getTime()) return false;
    this.clear();
    return true;
  }

  private clear(): void {
    this.state = "free";
    this.holder = undefined;
    this.agentSession = "";
    this.expiresAt = undefined;
    this.leaseGeneration += 1;
  }

  private hold(
    actor: Actor,
    state: LeaseState,
    now: Date,
    changed: boolean,
  ): void {
    this.state = state;
    this.holder = holderOf(actor);
    this.agentSession = actor.kind === "agent" ? actor.sessionId : "";
    this.expiresAt =
      // 接管是故意的，一直持有到交还为止。
      state === "humanTakeover"
        ? undefined
        : new Date(now.getTime() + this.idleSeconds(actor) * 1_000);
    if (changed) this.leaseGeneration += 1;
  }

  /**
   * 一次输入形状的动作在问能不能继续。
   *
   * `expected` 是调用者上次看到的代次，`undefined` 表示它不跟这个数。先应用
   * 过期，所以一个在上一个持有者停手之后才到的请求看到的是一个空闲的租约，
   * 而不是一个陈旧的。
   */
  request(actor: Actor, now: Date, expected?: number): Grant {
    this.expire(now);
    if (expected !== undefined && expected !== this.leaseGeneration) {
      return refused(LEASE_GENERATION);
    }
    if (this.state === "free") {
      this.hold(actor, actor.kind === "human" ? "human" : "agent", now, true);
      return GRANTED;
    }
    // 持有者续期：没有换手，所以不换代次。
    if (this.heldBy(actor)) {
      this.hold(actor, this.state, now, false);
      return GRANTED;
    }
    if (this.state === "agent") {
      // 人的普通输入直接抢占 Agent；Agent 的下一次动作会被告知为什么。
      if (actor.kind === "human") {
        this.hold(actor, "human", now, true);
        return GRANTED;
      }
      return refused(LEASE_HELD_BY_AGENT);
    }
    if (this.state === "human") {
      // 有人在打字。等他一下下。
      if (actor.kind === "agent") return QUEUE;
      // 第二个人：谁最后碰的谁在驱动。
      this.hold(actor, "human", now, true);
      return GRANTED;
    }
    // 接管的意义就在这里：Agent 不排在它后面，另一台设备也不能点一下就走过去。
    return refused(
      actor.kind === "agent" ? LEASE_REVOKED : LEASE_HELD_BY_HUMAN,
    );
  }

  /**
   * 人按「接管」。任何 Agent 租约都被撤销；答复说的是**真的**撤销了一个没有，
   * 这样调用者可以如实记一笔，而不是猜。
   */
  takeover(actor: Actor, now: Date): LeaseHolder | undefined {
    const revoked =
      this.state === "agent" && this.holder !== undefined
        ? this.holder
        : undefined;
    this.hold(actor, "humanTakeover", now, true);
    return revoked;
  }

  /**
   * 交还，或者 Agent 放掉自己的。只有持有者可以：放掉别人的租约不是一个客户端
   * 能提的要求，所以是拒绝，而不是安静地忽略。
   *
   * `subject` 只进文案。
   */
  release(actor: Actor, subject: string): void {
    if (!this.heldBy(actor)) {
      throw leaseRefusalFor(
        this.state === "agent"
          ? LEASE_HELD_BY_AGENT
          : this.state === "free"
            ? LEASE_GENERATION
            : LEASE_HELD_BY_HUMAN,
        subject,
      );
    }
    this.clear();
  }
}

/* -------------------------------- the client ------------------------------ */

/**
 * 一个不送 id 的客户端就是「这台机器前面的那个人」。他们彼此分不开，而这件事
 * 只有在两个人同时驱动同一个节点时才要紧。
 */
export function deviceOrLocal(deviceId: string): string {
  const trimmed = deviceId.trim();
  return trimmed === "" ? "local" : trimmed;
}

/** 客户端送来的自由文本，短到能坐进一个徽标里。 */
export function truncateName(name: string): string {
  const trimmed = name.trim();
  const characters = [...trimmed];
  return characters.length > 40 ? characters.slice(0, 40).join("") : trimmed;
}

/**
 * core 其余部分写的那种时间戳。
 *
 * 留在本地而不是从工作空间的助手里 import：租约模块在自己这一域之外没有依赖，
 * 它是整个域里唯一一段「只是 `now` 的纯函数」。
 */
export function rfc3339(at: Date): string {
  const base = at.toISOString().slice(0, 19);
  const millis = at.getUTCMilliseconds();
  const fraction = millis === 0 ? "" : `.${String(millis).padStart(3, "0")}`;
  return `${base}${fraction}+00:00`;
}
