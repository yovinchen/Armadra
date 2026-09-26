import { createHash } from "node:crypto";
import { DomainError, badRequest } from "../workspaces/support";

/**
 * 画布的在线设备（Presence）与编辑租约（H04 的前置，契约 §9）。
 *
 * 两件事都**只在内存里**：心跳、最后在线时间、谁持有写租约。core 重启之后
 * 没有人在看任何画布，这正是内存里那张空表的意思——把它存进库，重启后读回来
 * 的只会是一批已经不在的设备。
 *
 * 规则写在这里而不是页面里，因为「同一块画布同时只有一个写者」只有 core
 * 说了才算数：
 *
 *  - **谁在看**：每个客户端（一个页面标签、一个窗口）按 `clientId` 心跳。
 *    {@link PRESENCE_TTL_MS} 内没有心跳就算断开，从表里摘掉。
 *  - **谁在写**：同一块画布至多一个租约持有者。租约空着时，**唯一**在看的
 *    客户端的第一次心跳就拿到它——单设备、单窗口的人永远不会看到任何提示；
 *    有别人在看时，要么这次心跳带着「刚操作过」，要么一次带 `clientId` 的
 *    保存，谁先到归谁。
 *  - **释放**：持有者断开（心跳过期或显式离开）立刻释放；持有者空闲超过
 *    {@link LEASE_IDLE_MS} 且有别人在看时也释放——没人争的时候不释放，否则
 *    一个人去倒杯水回来就得重新拿一次。
 *  - **接管**：显式的 `takeover` 无条件转给请求者；确认是页面的事（二次
 *    确认对话框），core 只负责让它一步到位。
 *
 * **同一台设备**：每个客户端带着它来自哪台设备（服务器壳上是会话绑着的
 * 身份域设备，桌面壳上一律是「本机」）。同一台设备的两个窗口仍是两个客户端、
 * 仍然只有一个能写，但页面据此说「本机另一个窗口正在编辑」，接管时也不必再问
 * 一次——那是同一个人。设备名同样优先取身份域的，客户端报上来的只作兜底。
 *
 * **授权变化**：撤销共享、改成只读、停用账号之后，{@link CanvasPresence.recheck}
 * 按每个客户端记下的复判函数重新判一遍：看不见了就摘掉，不能写了就交出租约，
 * 变了就广播——而不是等它 30 秒没心跳自己过期。
 *
 * 与 revision CAS 的关系：租约先判，CAS 后判。租约拦下的是「别人正在写」，
 * CAS 拦下的仍然是「你手里那份旧了」——前者 423，后者照旧 409，页面对两者
 * 的反应完全不同（前者转只读，后者变基重放）。
 */

/** 页面的心跳间隔。core 不靠它，只是和 TTL 写在一处好对照。 */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** 三次心跳没到就算断开：一次丢包不该让人变成离线。 */
export const PRESENCE_TTL_MS = 30_000;
/** 持有者多久没操作算空闲；只在有别人在看时才据此释放。 */
export const LEASE_IDLE_MS = 3 * 60_000;
/** 过期扫描的节奏。比 TTL 细，断开的设备最多晚这么久从别人那里消失。 */
export const PRESENCE_SWEEP_MS = 5_000;

/** 租约被别人拿着时写入的拒绝码（契约 §9.3）。 */
export const LEASE_HELD = "canvas_lease_held";

const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_DEVICE_NAME = 64;

export interface PresenceClientView {
  readonly clientId: string;
  readonly deviceName: string;
  /**
   * 设备的不透明标识：两个客户端这一项相同就是同一台设备上的两个窗口。
   * 是身份域设备标识的摘要而不是标识本身；空串表示说不出来自哪台设备。
   */
  readonly deviceKey: string;
  readonly lastSeenAt: string;
}

export interface LeaseView {
  readonly clientId: string;
  readonly deviceName: string;
  readonly deviceKey: string;
  readonly acquiredAt: string;
}

/** 复判的结果：还能写、只能看、看不见了。 */
export type PresenceAccess = "write" | "read" | "none";

/**
 * 一个客户端背后的设备与人，由路由从请求身份里取出来交给在线表。
 *
 * 在线表不认识身份域：它只记下「来自哪台设备、叫什么、授权变了之后怎么再问
 * 一次」，判定本身留在路由里。
 */
export interface PresenceSource {
  /** 身份域的设备标识；桌面壳是 {@link LOCAL_DEVICE}，说不出来是空串。 */
  readonly deviceId: string;
  /** 身份域登记的设备名；空串时用客户端上报的。 */
  readonly deviceName: string;
  /** 授权变化之后复判；不给就不复判（桌面壳只有本机 owner）。 */
  readonly recheck?: (workspaceId: string) => PresenceAccess;
}

/** 桌面壳没有会话设备：它服务的每个窗口都在这台机器上。 */
export const LOCAL_DEVICE = "local";

/** 心跳的回答，也是 `canvas.presence` 事件除 `type` 以外的全部字段。 */
export interface PresenceSnapshot {
  readonly boardId: string;
  readonly clients: readonly PresenceClientView[];
  readonly lease: LeaseView | null;
}

export interface HeartbeatInput {
  readonly clientId: string;
  readonly deviceName: string;
  /** 自上次心跳以来这个客户端有没有被人操作过（指针、键盘）。 */
  readonly active: boolean;
  /**
   * 发心跳的人能不能写这块画布。缺省为能：桌面壳里只有本机 owner。服务器壳上
   * 只读共享的成员为假——他照样登记在线，但租约永远不会落到他手里，否则一个
   * 查看者独自开着画布，真正能写的人来了反而只读。
   */
  readonly writer?: boolean;
  readonly source?: PresenceSource;
}

interface Client {
  clientId: string;
  /** 客户端自己报的设备名；显示时身份域的优先（{@link displayName}）。 */
  deviceName: string;
  source: PresenceSource | undefined;
  lastSeenAt: number;
  lastActiveAt: number;
  /** 见 {@link HeartbeatInput.writer}；租约只在能写的人之间分。 */
  writer: boolean;
}

interface Lease {
  clientId: string;
  acquiredAt: number;
}

interface BoardEntry {
  workspaceId: string;
  clients: Map<string, Client>;
  lease: Lease | null;
}

export interface CanvasPresenceOptions {
  /** 状态变了（有人来、有人走、租约换手）时调用；普通的续期心跳不调。 */
  readonly publish: (workspaceId: string, snapshot: PresenceSnapshot) => void;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly idleMs?: number;
}

export class CanvasPresence {
  private readonly boards = new Map<string, BoardEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly idleMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: CanvasPresenceOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PRESENCE_TTL_MS;
    this.idleMs = options.idleMs ?? LEASE_IDLE_MS;
  }

  /** 武装过期扫描。`unref`：没人在看画布时它不该拖住进程退出。 */
  start(everyMs = PRESENCE_SWEEP_MS): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.sweep(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 一次心跳：登记或续期，必要时顺手把空着的租约给它。 */
  heartbeat(
    workspaceId: string,
    boardId: string,
    input: HeartbeatInput,
  ): PresenceSnapshot {
    const entry = this.entry(workspaceId, boardId);
    let changed = this.expire(entry);
    const at = this.now();
    const writer = input.writer !== false;
    const existing = entry.clients.get(input.clientId);
    if (existing === undefined) {
      entry.clients.set(input.clientId, {
        clientId: input.clientId,
        deviceName: input.deviceName,
        source: input.source,
        lastSeenAt: at,
        lastActiveAt: at,
        writer,
      });
      changed = true;
    } else {
      existing.lastSeenAt = at;
      // 授权随时会变（改角色、撤销共享），每次心跳按这一次的判定记。
      existing.writer = writer;
      if (input.active) existing.lastActiveAt = at;
      const before = displayName(existing);
      if (input.deviceName !== "") existing.deviceName = input.deviceName;
      // 复判函数带着这次请求的会话；换成最新的，免得它拿一把过期的钥匙去问。
      if (input.source !== undefined) existing.source = input.source;
      if (displayName(existing) !== before) changed = true;
    }
    // 不能写的人手里不该有租约：改成只读之后的第一拍就交出去。
    if (!writer && entry.lease?.clientId === input.clientId) {
      entry.lease = null;
      changed = true;
    }
    // 先放空闲的，再分：一个动了手的人不该等下一次心跳才接到别人放下的租约。
    if (this.releaseIdle(entry)) changed = true;
    if (entry.lease === null && writer) {
      // 只有它一个在看，或者它刚被人操作过：拿走空着的租约。两个都在看、
      // 谁都没动的时候不分——否则后到的那个会凭一次心跳把「正在编辑」的
      // 标签从先到的那个人头上摘走。
      if (entry.clients.size === 1 || input.active) {
        entry.lease = { clientId: input.clientId, acquiredAt: at };
        changed = true;
      }
    }
    if (changed) this.publish(boardId, entry);
    return this.view(boardId, entry);
  }

  /** 显式离开（切走画布、关掉页面）。持有者走了租约随之释放。 */
  leave(
    workspaceId: string,
    boardId: string,
    clientId: string,
  ): PresenceSnapshot {
    const entry = this.boards.get(boardId);
    if (entry === undefined || entry.workspaceId !== workspaceId) {
      return { boardId, clients: [], lease: null };
    }
    let changed = this.expire(entry);
    if (entry.clients.delete(clientId)) changed = true;
    if (entry.lease?.clientId === clientId) {
      entry.lease = null;
      changed = true;
    }
    if (this.handToSole(entry)) changed = true;
    if (changed) this.publish(boardId, entry);
    const snapshot = this.view(boardId, entry);
    if (entry.clients.size === 0) this.boards.delete(boardId);
    return snapshot;
  }

  /**
   * 拿租约。空着或本来就是自己的直接给；别人拿着时只有 `takeover` 才转手，
   * 否则 423。
   */
  acquire(
    workspaceId: string,
    boardId: string,
    input: {
      clientId: string;
      deviceName: string;
      takeover: boolean;
      source?: PresenceSource;
    },
  ): PresenceSnapshot {
    const entry = this.entry(workspaceId, boardId);
    this.expire(entry);
    const at = this.now();
    const client = this.touch(
      entry,
      input.clientId,
      input.deviceName,
      at,
      input.source,
    );
    client.lastActiveAt = at;
    const holder = entry.lease?.clientId;
    if (holder !== undefined && holder !== input.clientId && !input.takeover) {
      throw leaseHeld(this.deviceOf(entry, holder));
    }
    if (holder !== input.clientId) {
      entry.lease = { clientId: input.clientId, acquiredAt: at };
    }
    this.publish(boardId, entry);
    return this.view(boardId, entry);
  }

  /**
   * 保存之前的那一道门。
   *
   * 别人持有租约时拒绝，不论这次写带没带 `clientId`。租约空着时，带
   * `clientId` 的写顺手拿到它（第一次心跳还没回来就改了东西的那个人不该被
   * 拒）；不带的——没有身份的旧写者——放行但不拿租约，它说不出自己是谁，
   * 也就没法被别人看见「正在编辑」。
   */
  authorizeWrite(
    workspaceId: string,
    boardId: string,
    clientId: string | undefined,
    source?: PresenceSource,
  ): void {
    const entry = this.boards.get(boardId);
    if (entry === undefined || entry.workspaceId !== workspaceId) {
      if (clientId === undefined) return;
      const fresh = this.entry(workspaceId, boardId);
      const at = this.now();
      this.touch(fresh, clientId, "", at, source);
      fresh.lease = { clientId, acquiredAt: at };
      this.publish(boardId, fresh);
      return;
    }
    let changed = this.expire(entry);
    const holder = entry.lease?.clientId;
    if (holder !== undefined && holder !== clientId) {
      if (changed) this.publish(boardId, entry);
      throw leaseHeld(this.deviceOf(entry, holder));
    }
    if (clientId !== undefined) {
      const at = this.now();
      const client = this.touch(entry, clientId, "", at, source);
      client.lastActiveAt = at;
      if (entry.lease === null) {
        entry.lease = { clientId, acquiredAt: at };
        changed = true;
      }
    }
    if (changed) this.publish(boardId, entry);
  }

  snapshot(boardId: string): PresenceSnapshot {
    const entry = this.boards.get(boardId);
    if (entry === undefined) return { boardId, clients: [], lease: null };
    return this.view(boardId, entry);
  }

  /**
   * 授权变了：按每个客户端记下的复判函数重新判一遍。
   *
   * 看不见这块画布了（撤销共享、停用账号、登出）的摘掉，只剩读权限的交出
   * 租约；变了的画布各发一帧 `canvas.presence`。被撤销的那一方拿着的租约由此
   * 立即释放，留下的人不必等 30 秒的心跳过期，也不必点「接管」。
   */
  recheck(): void {
    for (const [boardId, entry] of this.boards) {
      let changed = false;
      for (const [id, client] of entry.clients) {
        const access = client.source?.recheck?.(entry.workspaceId);
        if (access === undefined) continue;
        if (access === "none") {
          entry.clients.delete(id);
          if (entry.lease?.clientId === id) entry.lease = null;
          changed = true;
          continue;
        }
        const writer = access === "write";
        if (client.writer !== writer) client.writer = writer;
        if (!writer && entry.lease?.clientId === id) {
          entry.lease = null;
          changed = true;
        }
      }
      if (this.handToSole(entry)) changed = true;
      if (changed) this.publish(boardId, entry);
      if (entry.clients.size === 0) this.boards.delete(boardId);
    }
  }

  /** 摘掉断开的客户端、释放空闲的租约；变了的画布各发一帧。 */
  sweep(): void {
    for (const [boardId, entry] of this.boards) {
      let changed = this.expire(entry);
      if (this.releaseIdle(entry)) changed = true;
      if (changed) this.publish(boardId, entry);
      if (entry.clients.size === 0) this.boards.delete(boardId);
    }
  }

  /* -------------------------------- 内部 --------------------------------- */

  private entry(workspaceId: string, boardId: string): BoardEntry {
    const found = this.boards.get(boardId);
    if (found !== undefined && found.workspaceId === workspaceId) return found;
    const created: BoardEntry = {
      workspaceId,
      clients: new Map(),
      lease: null,
    };
    this.boards.set(boardId, created);
    return created;
  }

  private touch(
    entry: BoardEntry,
    clientId: string,
    deviceName: string,
    at: number,
    source: PresenceSource | undefined,
  ): Client {
    // 走到这里的是写入与拿租约，两者的路由都要求写权限。
    const existing = entry.clients.get(clientId);
    if (existing !== undefined) {
      existing.lastSeenAt = at;
      existing.writer = true;
      if (deviceName !== "") existing.deviceName = deviceName;
      if (source !== undefined) existing.source = source;
      return existing;
    }
    const created: Client = {
      clientId,
      deviceName,
      source,
      lastSeenAt: at,
      lastActiveAt: at,
      writer: true,
    };
    entry.clients.set(clientId, created);
    return created;
  }

  /** 过期的客户端摘掉；持有者在其中时租约一起释放。 */
  private expire(entry: BoardEntry): boolean {
    const cutoff = this.now() - this.ttlMs;
    let changed = false;
    for (const [id, client] of entry.clients) {
      if (client.lastSeenAt >= cutoff) continue;
      entry.clients.delete(id);
      changed = true;
      if (entry.lease?.clientId === id) entry.lease = null;
    }
    if (entry.lease !== null && !entry.clients.has(entry.lease.clientId)) {
      entry.lease = null;
      changed = true;
    }
    if (this.handToSole(entry)) changed = true;
    return changed;
  }

  /** 持有者空闲、而且有别人在看：放手，让下一个动手的人拿。 */
  private releaseIdle(entry: BoardEntry): boolean {
    if (entry.lease === null || entry.clients.size < 2) return false;
    const holder = entry.clients.get(entry.lease.clientId);
    if (holder === undefined) return false;
    if (this.now() - holder.lastActiveAt < this.idleMs) return false;
    entry.lease = null;
    return true;
  }

  /** 只剩一个人在看而租约空着：直接给它，别让它等下一次心跳才能编辑。 */
  private handToSole(entry: BoardEntry): boolean {
    if (entry.lease !== null || entry.clients.size !== 1) return false;
    const [only] = entry.clients.values();
    if (only === undefined || !only.writer) return false;
    entry.lease = { clientId: only.clientId, acquiredAt: this.now() };
    return true;
  }

  private deviceOf(entry: BoardEntry, clientId: string): string {
    const client = entry.clients.get(clientId);
    return client === undefined ? "" : displayName(client);
  }

  private view(boardId: string, entry: BoardEntry): PresenceSnapshot {
    const clients = [...entry.clients.values()]
      .sort((a, b) => a.clientId.localeCompare(b.clientId))
      .map((client) => ({
        clientId: client.clientId,
        deviceName: displayName(client),
        deviceKey: deviceKey(client.source?.deviceId ?? ""),
        lastSeenAt: stamp(client.lastSeenAt),
      }));
    const holder =
      entry.lease === null ? undefined : entry.clients.get(entry.lease.clientId);
    const lease =
      entry.lease === null
        ? null
        : {
            clientId: entry.lease.clientId,
            deviceName: this.deviceOf(entry, entry.lease.clientId),
            deviceKey: deviceKey(holder?.source?.deviceId ?? ""),
            acquiredAt: stamp(entry.lease.acquiredAt),
          };
    return { boardId, clients, lease };
  }

  private publish(boardId: string, entry: BoardEntry): void {
    this.options.publish(entry.workspaceId, this.view(boardId, entry));
  }
}

/** 显示用的设备名：身份域登记的优先，客户端报的兜底。 */
function displayName(client: Client): string {
  const registered = client.source?.deviceName ?? "";
  return registered !== "" ? parseDeviceName(registered) : client.deviceName;
}

/**
 * 设备标识的摘要。页面只需要比较「是不是同一台」，不需要、也不该拿到身份域
 * 的设备标识本身——它出现在撤销设备的接口上。
 */
export function deviceKey(deviceId: string): string {
  if (deviceId === "") return "";
  return createHash("sha256")
    .update(`armadra-presence-device:${deviceId}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * 时间戳照 ISO 8601 写，但**不**走 `rfc3339()`：那个函数为了让修订号单调会
 * 改写过去的时刻，而这里要的是那一刻本身。
 */
function stamp(at: number): string {
  return new Date(at).toISOString();
}

/** 423：租约在别人手里。`message` 带上那台设备的名字，方便排查。 */
export function leaseHeld(deviceName: string): DomainError {
  return new DomainError(
    423,
    LEASE_HELD,
    deviceName === ""
      ? "Another client holds the edit lease for this board"
      : `Another client (${deviceName}) holds the edit lease for this board`,
  );
}

/** `clientId`：页面自己生成的随机串，一个标签页一个。 */
export function parseClientId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_ID.test(value)) {
    throw badRequest("clientId is invalid");
  }
  return value;
}

/** 设备名只用于显示：去掉首尾空白、控制字符，截到 64 个字符。 */
export function parseDeviceName(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw badRequest("deviceName must be a string");
  // eslint-disable-next-line no-control-regex
  return [...value.replace(/[\u0000-\u001f\u007f]/g, "").trim()]
    .slice(0, MAX_DEVICE_NAME)
    .join("");
}
