/**
 * 组件测试用的假 WebSocket（语言服务设计 §5 批次 C：`transport.test.ts` 用
 * 假 WebSocket，`client.test.ts` 用脚本化的假 server）。
 *
 * 只实现真 socket 里这几段代码用得到的部分：`readyState`、四个回调、
 * `send`、`close`。它不是一个 WebSocket 实现，也不打算是——测试要的是
 * 「什么时候发出去、发了什么」，不是握手。
 */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** 这个 socket 上发出去的每一条文本帧，按顺序。 */
  readonly sent: string[] = [];
  readyState = FakeSocket.CONNECTING;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  /* ------------------------------ 测试驱动 ------------------------------- */

  /** 握手完成。 */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** 服务端发来一条 JSON-RPC 消息。 */
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** 连接断了（不是我们关的）。 */
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** 已经发出去的帧里，`method` 是这个的那些。 */
  sentMethod(method: string): Record<string, unknown>[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.method === method);
  }
}

const sockets: FakeSocket[] = [];

/** 这一轮测试里建过的所有 socket，按建立顺序。 */
export function openedSockets(): FakeSocket[] {
  return sockets;
}

export function lastSocket(): FakeSocket | undefined {
  return sockets[sockets.length - 1];
}

export function resetSockets(): void {
  sockets.length = 0;
}

/** 传给 `createSessionTransport` / `acquireLanguageClient` 的工厂。 */
export const fakeSocketFactory = (url: string): WebSocket =>
  new FakeSocket(url) as unknown as WebSocket;
