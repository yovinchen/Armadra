/**
 * 远端执行主机的资源：每台主机一轮读取的缓存。
 *
 * 采样（`service.ts` 的 `snapshot`）是同步的一拍，而问远端要走一次 Worker
 * 往返。所以这里是一份按主机的缓存：采样时读缓存里上一轮的数字，同时登记「下一轮
 * 要读谁」，没有在飞的读取且上一轮已经够旧时就发起下一轮。于是：
 *
 *  * 一台主机一拍最多一个请求——设计里的「远端合并为一轮读取、无逐 PID SSH」；
 *  * 面板刚打开的第一拍远端行是 `null`（原因 `remote`），下一拍才有数；CPU 还要
 *    再等一拍，因为 Worker 那边同样要两次样本才能求差；
 *  * 读不到（主机断开、Worker 太旧、对不上连接）就一直是 `null`，从不拿控制机的
 *    数字或上上轮的旧数冒充——超过 {@link STALE_MS} 的缓存不再交出去。
 *
 * 会话和远端进程树之间靠 SSH 连接的本地端口对上，见 `sockets.ts`。
 */

import type { RemoteResourceRead } from "../remote/resources-worker";
import { executeLanguage, executeRemote } from "../remote/execute";
import type { PlatformComponent } from "./platform";
import type { HostResources, RemoteTreeMetrics } from "./sample";
import { executableName, readProcessTable } from "./sample";
import { connectionsOf } from "./sockets";

/** 两轮读取之间至少隔这么久；采样节奏更快也不多问。 */
export const MIN_READ_INTERVAL_MS = 1_000;
/** 缓存超过这么久就当没有：宁可显示破折号，也不显示一个过去的数。 */
export const STALE_MS = 30_000;
/** 多久没被问起的会话与主机不再读。 */
const FORGET_MS = 60_000;

interface Wanted {
  localPid: number | null;
  at: number;
}

interface HostCache {
  readonly wanted: Map<string, Wanted>;
  wantedAt: number;
  read: RemoteResourceRead | undefined;
  readAt: number;
  inFlight: Promise<void> | undefined;
  /** `ssh` 客户端的 `(pid, 启动时间)` → 它连出去用的本地端口。 */
  readonly ports: Map<string, number | null>;
}

/** 本机 `ssh` 客户端连的是远端的哪个端口；取不到就不筛。 */
export type HostPort = (hostId: string) => number | undefined;

/**
 * 这台主机的语言连接是不是连着。资源读取只问连着的那一条：为了一行资源数字
 * 去建一条 ssh 连接、再起一个 Worker，比那几个数字贵得多。
 */
export type LanguageLive = (hostId: string) => boolean;

export class RemoteResources {
  private readonly hosts = new Map<string, HostCache>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private hostPort: HostPort = () => undefined,
    private languageLive: LanguageLive = () => false,
  ) {}

  /** 远端域装配时告诉这里怎么判断一台主机的语言连接连着没有。 */
  setLanguageLive(lookup: LanguageLive): void {
    this.languageLive = lookup;
  }

  /**
   * 这台主机上编辑器起的语言服务器，上一轮在那边按树量出来的行。读不到、太旧
   * 或语言连接没连着就是空的。
   */
  components(hostId: string): PlatformComponent[] {
    const cache = this.hosts.get(hostId);
    if (cache?.read === undefined) return [];
    if (this.now() - cache.readAt > STALE_MS) return [];
    return (cache.read.components ?? []).map((component) => ({
      ...component,
      location: "remote",
      executionHostId: hostId,
    }));
  }

  /** 远端域装配时告诉这里每台主机的 SSH 端口。 */
  setHostPort(lookup: HostPort): void {
    this.hostPort = lookup;
  }

  private cache(hostId: string): HostCache {
    let cache = this.hosts.get(hostId);
    if (cache === undefined) {
      cache = {
        wanted: new Map(),
        wantedAt: 0,
        read: undefined,
        readAt: 0,
        inFlight: undefined,
        ports: new Map(),
      };
      this.hosts.set(hostId, cache);
    }
    return cache;
  }

  /**
   * 这个会话上一轮在远端读到的数字，并登记它进下一轮。`localPid` 是本机那个
   * tmux 窗格的领头进程，`ssh` 客户端是它或它的后代。
   */
  session(
    hostId: string,
    sessionId: string,
    localPid: number | null,
  ): RemoteTreeMetrics | undefined {
    const cache = this.cache(hostId);
    const now = this.now();
    cache.wanted.set(sessionId, { localPid, at: now });
    cache.wantedAt = now;
    this.kick(hostId, cache);
    if (cache.read === undefined || now - cache.readAt > STALE_MS) {
      return undefined;
    }
    const found = cache.read.sessions.find(
      (entry) => entry.sessionId === sessionId,
    );
    if (found === undefined) return undefined;
    const { sessionId: _id, ...metrics } = found;
    return metrics;
  }

  /** 这台主机的总览；登记它进下一轮。读不到或太旧是 `undefined`。 */
  host(hostId: string): HostResources | undefined {
    const cache = this.cache(hostId);
    const now = this.now();
    cache.wantedAt = now;
    this.kick(hostId, cache);
    if (cache.read === undefined || now - cache.readAt > STALE_MS) {
      return undefined;
    }
    return {
      ...cache.read.host,
      hostId,
      location: "remote",
    };
  }

  /** 等在飞的那一轮结束。给测试用：采样本身从不等它。 */
  async settled(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((cache) => cache.inFlight));
  }

  private kick(hostId: string, cache: HostCache): void {
    if (cache.inFlight !== undefined) return;
    if (this.now() - cache.readAt < MIN_READ_INTERVAL_MS) return;
    cache.inFlight = this.readHost(hostId, cache).finally(() => {
      cache.inFlight = undefined;
    });
  }

  private async readHost(hostId: string, cache: HostCache): Promise<void> {
    const now = this.now();
    for (const [sessionId, wanted] of cache.wanted) {
      if (now - wanted.at > FORGET_MS) cache.wanted.delete(sessionId);
    }
    if (now - cache.wantedAt > FORGET_MS) {
      this.hosts.delete(hostId);
      return;
    }
    const sessions = this.clientPorts(hostId, cache);
    let languageProcesses: unknown[] = [];
    if (this.languageLive(hostId)) {
      try {
        languageProcesses = (await executeLanguage(
          hostId,
          "language.processes",
          "/",
          {},
          true,
        )) as unknown[];
      } catch {
        // 语言连接这时断了：这一轮没有语言服务器的行。
      }
    }
    try {
      const read = (await executeRemote(hostId, "resources.read", "/", {
        sessions,
        ...(Array.isArray(languageProcesses) && languageProcesses.length > 0
          ? { languageProcesses }
          : {}),
      })) as RemoteResourceRead;
      cache.read = read;
    } catch {
      // 读不到就是读不到：清掉上一轮，面板显示破折号，而不是一个越来越旧的数。
      cache.read = undefined;
    }
    cache.readAt = this.now();
  }

  /**
   * 每个会话的 `ssh` 客户端用哪个本地端口连到这台主机。
   *
   * 窗格的领头进程可能就是 `ssh`，也可能是一层 shell；在它的后代里找名字叫 `ssh`
   * 的那个。它连出去的已建立连接里，只认对端端口等于这台主机 SSH 端口的那一条
   * （设置里没写端口就只要求唯一）；找不到或不止一条就是不知道。结果按 `(pid, 启动时间)` 记住，连接存续期间不必
   * 每轮都问一次 `lsof`。
   */
  private clientPorts(
    hostId: string,
    cache: HostCache,
  ): { sessionId: string; clientPort: number | null }[] {
    const wanted = [...cache.wanted.entries()];
    if (wanted.length === 0) return [];
    let table: ReturnType<typeof readProcessTable>;
    try {
      table = readProcessTable();
    } catch {
      return wanted.map(([sessionId]) => ({ sessionId, clientPort: null }));
    }
    const children = new Map<number, number[]>();
    for (const row of table.values()) {
      const list = children.get(row.parent) ?? [];
      list.push(row.pid);
      children.set(row.parent, list);
    }
    const sshOf = (root: number | null): number | undefined => {
      if (root === null) return undefined;
      const queue = [root];
      const seen = new Set<number>();
      while (queue.length > 0) {
        const pid = queue.shift() as number;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const row = table.get(pid);
        if (row === undefined) continue;
        if (executableName(row.name).toLowerCase() === "ssh") return pid;
        queue.push(...(children.get(pid) ?? []));
      }
      return undefined;
    };
    const identity = (pid: number): string =>
      `${pid}:${table.get(pid)?.startTimeUnixMs ?? "?"}`;
    const clients = new Map<string, number | undefined>();
    for (const [sessionId, entry] of wanted) {
      clients.set(sessionId, sshOf(entry.localPid));
    }
    const unknown = [...clients.values()].filter(
      (pid): pid is number =>
        pid !== undefined && !cache.ports.has(identity(pid)),
    );
    if (unknown.length > 0) {
      const connections = connectionsOf(unknown);
      // 设置里没写端口时（走 `~/.ssh/config` 的 Port）不按端口筛，只要求唯一。
      const port = this.hostPort(hostId);
      for (const pid of unknown) {
        if (connections === undefined) continue;
        const mine = connections.filter(
          (connection) =>
            connection.pid === pid &&
            (port === undefined || connection.remotePort === port),
        );
        cache.ports.set(
          identity(pid),
          mine.length === 1
            ? (mine[0] as { localPort: number }).localPort
            : null,
        );
      }
    }
    // 只留还活着的客户端的记录。
    const alive = new Set(
      [...clients.values()]
        .filter((pid): pid is number => pid !== undefined)
        .map(identity),
    );
    for (const key of [...cache.ports.keys()]) {
      if (!alive.has(key)) cache.ports.delete(key);
    }
    return wanted.map(([sessionId]) => {
      const pid = clients.get(sessionId);
      return {
        sessionId,
        clientPort:
          pid === undefined ? null : (cache.ports.get(identity(pid)) ?? null),
      };
    });
  }
}

/** core 里唯一的一份。 */
export const remoteResources = new RemoteResources();
