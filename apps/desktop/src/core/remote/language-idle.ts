/**
 * 语言连接的空闲关闭。
 *
 * 每台执行主机的语言服务走第二条 ssh 连接（`worker --stdio --language-link`，
 * 取舍见状态文档 §44）。编辑器关掉远端文件之后，那边的服务器按原有空闲策略停，
 * 连接本身却一直留着：一条闲置的 ssh、一个闲着的 Worker 进程。这里定时看一眼：
 *
 *  * 连接活着、Worker 答「没有开着的会话」、这段时间里也没有任何语言请求，
 *    持续够久（缺省 10 分钟）就关掉它——Worker 随 stdin 关闭退出，它起的服务器
 *    一并停；
 *  * 不重连：下一次编辑器开会话，`RemoteWorker` 按需再握一次手（与第一次一样）。
 *
 * 问「有几个会话」直接发给那条连接，不算一次语言请求，否则它自己就让连接永远
 * 不空闲。问不到（连接这时断了、Worker 太旧不认这个动作）就不动它。
 */

/** 没有会话、没有请求多久之后关。 */
export const LANGUAGE_IDLE_MS = 10 * 60_000;
/** 多久看一次。 */
export const LANGUAGE_IDLE_CHECK_MS = 60_000;

export interface LanguageIdleOptions {
  /** 语言连接活着的那些主机。 */
  readonly live: () => readonly string[];
  /** 问那条连接还开着几个会话；不经记账的请求口。 */
  readonly sessions: (hostId: string) => Promise<number>;
  /** 关掉那条连接。 */
  readonly close: (hostId: string) => void;
  readonly idleMs?: number;
  readonly now?: () => number;
}

export class LanguageIdle {
  private readonly lastUsed = new Map<string, number>();
  private readonly idleSince = new Map<string, number>();
  private checking: Promise<void> | undefined;

  constructor(private readonly options: LanguageIdleOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** 一次语言请求：这台主机不算空闲。 */
  touch(hostId: string): void {
    this.lastUsed.set(hostId, this.now());
    this.idleSince.delete(hostId);
  }

  /** 看一轮；上一轮还没结束就不叠。 */
  async check(): Promise<void> {
    this.checking ??= this.round().finally(() => {
      this.checking = undefined;
    });
    await this.checking;
  }

  private async round(): Promise<void> {
    const idleMs = this.options.idleMs ?? LANGUAGE_IDLE_MS;
    const live = new Set(this.options.live());
    for (const hostId of [...this.idleSince.keys()]) {
      if (!live.has(hostId)) this.idleSince.delete(hostId);
    }
    for (const hostId of live) {
      let sessions: number;
      try {
        sessions = await this.options.sessions(hostId);
      } catch {
        continue;
      }
      const now = this.now();
      if (sessions > 0) {
        this.idleSince.delete(hostId);
        continue;
      }
      // 空闲从「没有会话」与「最后一次请求」里较晚的那个算起。
      const since = Math.max(
        this.idleSince.get(hostId) ?? now,
        this.lastUsed.get(hostId) ?? 0,
      );
      this.idleSince.set(hostId, since);
      if (now - since >= idleMs) {
        this.idleSince.delete(hostId);
        this.lastUsed.delete(hostId);
        this.options.close(hostId);
      }
    }
  }
}
