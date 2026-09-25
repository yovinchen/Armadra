/**
 * 一个 Worker 会话（一条 `worker --stdio` 连接）自己的状态。
 *
 * 大部分操作是无状态的：读一个文件、跑一条 `git`。剩下几样必须活得比一次请求
 * 久——Git 长操作的队列与进度、文件监听、资源采样的 CPU 基线、语言服务器——它们
 * 挂在这里，随连接生、随连接死：stdin 关闭时 {@link WorkerSession.dispose} 把它们
 * 一一收掉，不留一个孤儿 watcher 或语言服务器进程。
 *
 * 推给控制端的帧也从这里发：`requestId` 为空的答复帧就是「不是被请求的那一帧」
 * （{@link ./frames}），控制端按 `type` 分发。
 */

/** Worker 主动推给控制端的一帧的内容。 */
export interface RemotePush {
  readonly type: string;
  readonly [field: string]: unknown;
}

export class WorkerSession {
  private readonly cleanups: (() => Promise<void> | void)[] = [];
  private readonly slots = new Map<string, unknown>();
  private disposed = false;

  constructor(private readonly push: (event: RemotePush) => void) {}

  /** 推一帧；会话已经结束就丢掉——控制端那头已经没有人在读。 */
  publish(event: RemotePush): void {
    if (this.disposed) return;
    this.push(event);
  }

  /**
   * 这个会话里唯一的一份 `key`：第一次用时由 `make` 造出来，并登记它的收尾。
   * 返回同一个对象，所以两个请求看到的是同一个队列、同一个采样器。
   */
  slot<T>(
    key: string,
    make: () => T,
    dispose?: (value: T) => Promise<void> | void,
  ): T {
    if (this.slots.has(key)) return this.slots.get(key) as T;
    const value = make();
    this.slots.set(key, value);
    if (dispose !== undefined) this.cleanups.push(() => dispose(value));
    return value;
  }

  get closed(): boolean {
    return this.disposed;
  }

  /** 连接结束：倒序收尾，一个失败不挡住其余的。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (failure) {
        process.stderr.write(
          `armadra worker: cleanup failed: ${
            failure instanceof Error ? failure.message : String(failure)
          }\n`,
        );
      }
    }
    this.slots.clear();
  }
}
