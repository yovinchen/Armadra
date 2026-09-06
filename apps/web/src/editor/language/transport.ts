import type { Transport } from "@codemirror/lsp-client";

/**
 * 会话 WebSocket 上的 `Transport`（语言服务设计 §2.4、§2.9）。
 *
 * 一条文本帧就是一条 JSON-RPC 消息，两端都不加 `Content-Length` 头——
 * 分帧是 WebSocket 自己的事。
 *
 * 三件这一层必须做、上层不该重复做的事：
 *
 *  1. **连接前的发送要留着。** `LSPClient.connect()` 一被调用就发
 *     `initialize`，而 socket 通常还在握手。丢掉它等于会话永远初始化不完，
 *     所以 `send` 在 `OPEN` 之前进队列。
 *  2. **断开是事件，不是异常。** socket 关掉时通知上层，由 `client.ts`
 *     决定退避重连；这里不自己重连，否则两处都在重连。
 *  3. **正文不打日志。** 帧里是文件正文与补全内容（§3.4）。
 */
export interface SessionTransport extends Transport {
  /** 主动关闭；不再触发 `onClose`。 */
  close(): void;
}

export interface TransportHooks {
  /** socket 打开（首次或重连后）。 */
  onOpen?: () => void;
  /** socket 关掉了，且不是我们主动关的。 */
  onClose?: () => void;
}

/** 排队上限：超过就丢最早的，避免一条断掉的连接把内存吃光。 */
const MAX_QUEUED = 256;

type SocketFactory = (url: string) => WebSocket;

/**
 * 打开一条会话 socket。
 *
 * `factory` 只为测试而存在：组件测试用一个假 WebSocket，不需要真 Runtime。
 */
export function createSessionTransport(
  url: string,
  hooks: TransportHooks = {},
  factory: SocketFactory = (target) => new WebSocket(target),
): SessionTransport {
  let handlers: ((value: string) => void)[] = [];
  let queued: string[] = [];
  let closed = false;
  let socket: WebSocket;

  try {
    socket = factory(url);
  } catch (error) {
    // 连不上和「Runtime 拒绝」在这里是同一件事：上层看到 close 就退避重试。
    queueMicrotask(() => hooks.onClose?.());
    return {
      send() {},
      subscribe() {},
      unsubscribe() {},
      close() {},
    };
  }

  socket.onopen = () => {
    for (const message of queued) socket.send(message);
    queued = [];
    hooks.onOpen?.();
  };
  socket.onmessage = (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : null;
    if (data === null) return;
    // 订阅者在回调里退订是合法的，所以遍历副本。
    for (const handler of [...handlers]) handler(data);
  };
  socket.onclose = () => {
    if (closed) return;
    closed = true;
    hooks.onClose?.();
  };
  // 浏览器在 `onerror` 之后一定会再发 `onclose`，重连只挂在 close 上。
  socket.onerror = () => {};

  return {
    send(message: string) {
      if (closed) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        return;
      }
      if (queued.length >= MAX_QUEUED) queued.shift();
      queued.push(message);
    },
    subscribe(handler: (value: string) => void) {
      handlers.push(handler);
    },
    unsubscribe(handler: (value: string) => void) {
      handlers = handlers.filter((entry) => entry !== handler);
    },
    close() {
      closed = true;
      handlers = [];
      queued = [];
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // 已经关了。
      }
    },
  };
}
