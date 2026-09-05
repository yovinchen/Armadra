import {
  terminalServerMessageSchema,
  type TerminalClientMessage,
  type TerminalServerMessage,
  type TerminateMode,
} from "@armadra/shared";

/**
 * 终端 WebSocket 的状态机（计划书 §15.5 / §15.7）。
 *
 * 和 xterm 完全解耦，方便用假 WebSocket 单测。规则只有四条：
 *
 * 1. 连接建立后先等 `hello`；在此之前收到的 `snapshot` / `output` 先攒着，
 *    因为调用方要在 `hello` 时清屏——否则清屏会把先到的内容抹掉。
 * 2. `hello` 之前要发的 `input` / `resize` 也先攒着：会话还没 attach，
 *    这时候发 resize 只会打到空处。
 * 3. `stale` 表示我们持有的 generation 已过期：通知调用方并主动关闭，
 *    由调用方清屏后重建一个新的 transport。
 * 4. 任何解析不出来的帧一律丢弃，不让一个坏帧打断整条流。
 */

export type TerminalTransportState =
  | "connecting"
  | "attaching"
  | "live"
  | "stale"
  | "closed";

export interface TerminalHello {
  sessionId: string;
  generation: number;
  backend: "direct" | "tmux";
  rows: number;
  cols: number;
  alive: boolean;
}

export interface TerminalTransportHandlers {
  /** 第一帧。调用方应在这里清屏并记录 generation。 */
  onHello?: (hello: TerminalHello) => void;
  /** 回放快照（仅 direct 后端）。 */
  onSnapshot?: (data: string) => void;
  onOutput?: (data: string) => void;
  onStatus?: (
    status: "running" | "exited" | "failed" | "terminated",
    exitCode: number | null,
  ) => void;
  onWarning?: (message: string) => void;
  /** generation 过期：清屏后重建连接。 */
  onStale?: (generation: number) => void;
  onClose?: () => void;
  onSocketError?: () => void;
}

export interface TerminalTransport {
  readonly state: TerminalTransportState;
  readonly generation: number | null;
  input: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  terminate: (mode: TerminateMode) => void;
  send: (message: TerminalClientMessage) => void;
  close: () => void;
}

/** 只用到 WebSocket 的这几个成员，测试里给个假的即可。 */
export interface SocketLike {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, listener: (event: never) => void) => void;
  removeEventListener?: (
    type: string,
    listener: (event: never) => void,
  ) => void;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;

const defaultFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;

export function createTerminalTransport(
  url: string,
  handlers: TerminalTransportHandlers,
  factory: SocketFactory = defaultFactory,
): TerminalTransport {
  const socket = factory(url);

  let state: TerminalTransportState = "connecting";
  let generation: number | null = null;
  /** hello 之前到达的输出帧。 */
  const pendingIn: TerminalServerMessage[] = [];
  /** hello 之前要发出的客户端帧。 */
  const pendingOut: TerminalClientMessage[] = [];

  function flushOut() {
    while (pendingOut.length > 0) {
      const message = pendingOut.shift();
      if (message) rawSend(message);
    }
  }

  function rawSend(message: TerminalClientMessage) {
    if (socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function send(message: TerminalClientMessage) {
    if (state === "closed" || state === "stale") return;
    if (state !== "live") {
      // resize 只保留最后一条，input 全部保序攒着
      if (message.type === "resize") {
        const index = pendingOut.findIndex((item) => item.type === "resize");
        if (index >= 0) pendingOut.splice(index, 1);
      }
      pendingOut.push(message);
      return;
    }
    rawSend(message);
  }

  function deliver(message: TerminalServerMessage) {
    switch (message.type) {
      case "snapshot":
        handlers.onSnapshot?.(message.data);
        break;
      case "output":
        handlers.onOutput?.(message.data);
        break;
      case "status":
        handlers.onStatus?.(message.status, message.exitCode ?? null);
        break;
      case "warning":
        handlers.onWarning?.(message.message);
        break;
      default:
        break;
    }
  }

  socket.addEventListener("open", (() => {
    if (state === "connecting") state = "attaching";
  }) as never);

  socket.addEventListener("message", ((event: { data: unknown }) => {
    if (state === "closed" || state === "stale") return;
    let payload: unknown;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = terminalServerMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === "hello") {
      generation = message.generation;
      state = "live";
      handlers.onHello?.({
        sessionId: message.sessionId,
        generation: message.generation,
        backend: message.backend,
        rows: message.rows,
        cols: message.cols,
        alive: message.alive,
      });
      while (pendingIn.length > 0) {
        const buffered = pendingIn.shift();
        if (buffered) deliver(buffered);
      }
      flushOut();
      return;
    }

    if (message.type === "stale") {
      state = "stale";
      handlers.onStale?.(message.generation);
      socket.close();
      return;
    }

    if (state !== "live") {
      pendingIn.push(message);
      return;
    }
    deliver(message);
  }) as never);

  socket.addEventListener("close", (() => {
    if (state !== "stale") state = "closed";
    handlers.onClose?.();
  }) as never);

  socket.addEventListener("error", (() => {
    handlers.onSocketError?.();
  }) as never);

  return {
    get state() {
      return state;
    },
    get generation() {
      return generation;
    },
    send,
    input: (data) => send({ type: "input", data }),
    resize: (cols, rows) => send({ type: "resize", cols, rows }),
    terminate: (mode) => send({ type: "terminate", mode }),
    close: () => {
      if (state === "closed") return;
      state = "closed";
      socket.close();
    },
  };
}
