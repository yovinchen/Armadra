/**
 * 断线重连时「不重复输入」的那份账（客户端平台设计，移动端重连）。
 *
 * 手机切到后台、锁屏、换基站，终端 socket 随时会断。断的那一刻，客户端并不知道
 * 最后几次按键有没有落到 pty 上——所以它记一份账：
 *
 *  - 每条输入带一个自增的 `inputId`，Runtime 写进 pty 之后回 `ack`；
 *  - 重连时 `hello` 里带回这个 writer 已经落地的最大 id，比它小的一律划掉；
 *  - 剩下的只重发**没超时的**。超过 {@link INPUT_TTL_MS} 的那些结果是未知的，
 *    协议设计里说得很清楚：不确定的副作用不自动重发（host-protocol-design §3.3）。
 *
 * 这份账跟着终端节点走，不跟着 socket 走——重连要换 transport，账不能跟着丢。
 */

/** 超过这个时长仍未确认的输入不再重发：结果未知，重放可能是第二次执行。 */
export const INPUT_TTL_MS = 10_000;

/** 一条还没被确认的输入。 */
export interface PendingInput {
  id: number;
  data: string;
  sentAt: number;
}

export class TerminalInputLog {
  /** 这条输入流的标签，重连时用它问 Runtime「我发到哪儿了」。 */
  readonly writerId: string;
  #next = 0;
  #pending: PendingInput[] = [];
  #clock: () => number;

  constructor(
    writerId: string = newWriterId(),
    clock: () => number = Date.now,
  ) {
    this.writerId = writerId;
    this.#clock = clock;
  }

  /** 记下一条即将发出的输入，返回它的序号。 */
  record(data: string): PendingInput {
    const entry = { id: ++this.#next, data, sentAt: this.#clock() };
    this.#pending.push(entry);
    return entry;
  }

  /** Runtime 已经落地到 `id` 为止：更早的全部划掉。 */
  acknowledge(id: number): void {
    if (!Number.isFinite(id) || id <= 0) return;
    this.#pending = this.#pending.filter((entry) => entry.id > id);
  }

  /**
   * 重连后要重发的那几条：序号在 `acknowledged` 之后、且还没超时的。
   *
   * 超时的那些同时被丢掉——它们不会在下一次重连时突然又变得可以重发。
   */
  resume(acknowledged: number): PendingInput[] {
    this.acknowledge(acknowledged);
    const now = this.#clock();
    this.#pending = this.#pending.filter(
      (entry) => now - entry.sentAt < INPUT_TTL_MS,
    );
    // 重发的是同一条输入，序号不变：Runtime 靠序号认出重复。
    return [...this.#pending];
  }

  /** 还没被确认的条数，测试与诊断用。 */
  get pending(): readonly PendingInput[] {
    return this.#pending;
  }
}

function newWriterId(): string {
  const random = globalThis.crypto;
  if (random && typeof random.randomUUID === "function")
    return random.randomUUID();
  // 只是一个标签，不是凭据：拿不到 crypto 时随便给一个也不影响正确性，
  // 最坏的结果是这个客户端重发自己那几条没被确认的输入。
  return `writer-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
