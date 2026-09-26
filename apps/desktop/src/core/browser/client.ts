import { WebSocket } from "ws";
import { Refusal } from "../collab/refusals";
import type { BackendStatus, DriveBackend, EventSink } from "./backend";

/**
 * The core's end of `browser:drive`.
 *
 * Ported from the pre-merge implementation. One loopback
 * WebSocket, dialled by this process, to the Electron shell that started it.
 * The address and a one-time token arrive in this process's environment and
 * nowhere else: not a file, not a well-known port, not a constant. A core
 * nobody's shell started therefore has no channel at all, which is the right
 * answer — it has no claim on somebody else's window either.
 *
 * Authorization does not live here. The three rules and the lease are decided
 * before a request reaches this file; what travels is an already-authorized
 * **verb**, never a CDP method name.
 */

/** Where the shell is listening. Written into this process's spawn environment. */
export const ADDRESS_ENV = "ARMADRA_SHELL_DRIVE_WS";
/** The one-time token for that channel, from the same place. */
export const TOKEN_ENV = "ARMADRA_SHELL_DRIVE_TOKEN";

/**
 * The code a verb gets when there is no shell to drive through. It is a code
 * and not prose because a caller branches on it: "no window is open" is a
 * different thing from "you may not drive that node".
 */
export const UNAVAILABLE = "browser_unavailable";

/** 通道接通（含重连）时交给事件接收处的那一帧的 `event`。 */
export const CHANNEL_READY = "channelReady";

/**
 * Longest one verb may wait for the shell. Slightly longer than the shell's
 * own per-verb bound, so a timeout is normally reported by the side that knows
 * which page stopped answering.
 */
const CALL_TIMEOUT_MS = 50_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;

export type { EventSink };

export function unavailable(): Refusal {
  return Refusal.conflict(
    `${UNAVAILABLE}: 这个窗口里没有可驱动的浏览器节点（桌面壳未连接）。`,
  );
}

interface Pending {
  settle: (answer: Record<string, unknown>) => void;
  fail: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DriveClientOptions {
  readonly address: string;
  readonly token: string;
  /** Injected in tests; the real one is `ws`. */
  readonly connect?: (address: string) => WebSocketLike;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * The narrow slice of a WebSocket this client uses.
 *
 * A structural type rather than `ws.WebSocket` so a test can drive the channel
 * without a socket: the interesting behaviour here is the reconnect, the
 * pending table and what a dropped channel does to calls in flight, and none
 * of that is about frames on a wire.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: "open", handler: () => void): void;
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export class DriveClient implements DriveBackend {
  readonly kind = "shell" as const;
  private readonly address: string;
  private readonly token: string;
  private readonly dial: (address: string) => WebSocketLike;
  private readonly log: (
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
  private readonly pending = new Map<string, Pending>();
  private socket: WebSocketLike | undefined;
  private ready = false;
  private nextId = 1;
  private backoff = RECONNECT_MIN_MS;
  private reconnect: NodeJS.Timeout | undefined;
  private stopped = false;
  private events: EventSink = () => {};

  constructor(options: DriveClientOptions) {
    this.address = options.address;
    this.token = options.token;
    this.dial =
      options.connect ??
      ((address) => new WebSocket(address) as unknown as WebSocketLike);
    this.log = options.log ?? (() => {});
  }

  /**
   * Reads the environment. `undefined` when this core was not started by a
   * shell, which is the ordinary case for `vitest` and for a developer running
   * the core by hand.
   */
  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    options: Partial<DriveClientOptions> = {},
  ): DriveClient | undefined {
    const address = env[ADDRESS_ENV];
    const token = env[TOKEN_ENV];
    if (
      address === undefined ||
      address === "" ||
      token === undefined ||
      token === ""
    ) {
      return undefined;
    }
    return new DriveClient({ ...options, address, token });
  }

  isConnected(): boolean {
    return this.ready;
  }

  status(): BackendStatus {
    return {
      kind: "shell",
      available: this.ready,
      ...(this.ready ? {} : { reason: UNAVAILABLE }),
      detail: { address: this.address },
    };
  }

  /**
   * Dials, and keeps dialling. The loop lives as long as the process: a shell
   * that restarts its window, or a socket that died under a laptop lid, must
   * not leave browser nodes permanently unavailable.
   */
  connect(events: EventSink): void {
    this.events = events;
    this.stopped = false;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    let socket: WebSocketLike;
    try {
      socket = this.dial(this.address);
    } catch (error) {
      this.log("browser drive channel could not dial", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      // The hello must be first on the wire; the shell drops a socket that
      // sends anything else before it.
      socket.send(JSON.stringify({ type: "hello", token: this.token }));
    });
    socket.on("message", (data) => {
      this.receive(String(data));
    });
    socket.on("error", (error) => {
      this.log("browser drive channel dropped", { error: error.message });
    });
    socket.on("close", () => {
      if (this.socket === socket) this.disconnect();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect !== undefined) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.open();
    }, delay);
    // A reconnect timer must not be the reason a core refuses to exit.
    this.reconnect.unref?.();
  }

  private receive(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const envelope = value as Record<string, unknown>;
    switch (envelope.type) {
      case "ready":
        this.ready = true;
        this.backoff = RECONNECT_MIN_MS;
        this.log("browser drive channel ready");
        // 不属于任何节点：告诉装配处壳刚接上（或重连上），壳那边的状态是
        // 空的，要整份重推的东西（被动旁听的节点表）现在推。
        this.events({ type: "event", event: CHANNEL_READY });
        return;
      case "event":
        this.events(envelope);
        return;
      default:
        this.settle(envelope);
    }
  }

  /**
   * Hands one answer to whoever is waiting for it. An answer for a request
   * nobody is waiting on is dropped: it is a reply to a call that already
   * timed out, and there is nothing useful to do with it.
   */
  private settle(answer: Record<string, unknown>): void {
    const id = answer.id;
    if (typeof id !== "string") return;
    const waiter = this.pending.get(id);
    if (waiter === undefined) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.settle(answer);
  }

  private disconnect(): void {
    this.ready = false;
    this.socket = undefined;
    // Everything in flight is now unanswerable. Failing each waiter with
    // `browser_unavailable` is a named absence rather than a hang.
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiting) {
      clearTimeout(waiter.timer);
      waiter.fail(unavailable());
    }
  }

  /** Sends one already-authorized verb and waits for its answer. */
  async drive(nodeId: string, verb: string, args: unknown): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined || !this.ready) throw unavailable();
    const id = `r${this.nextId}`;
    this.nextId += 1;
    const answer = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            Refusal.conflict(
              "browser_timeout: that page did not answer in time",
            ),
          );
        }, CALL_TIMEOUT_MS);
        timer.unref?.();
        this.pending.set(id, { settle: resolve, fail: reject, timer });
        try {
          socket.send(JSON.stringify({ id, nodeId, verb, args }));
        } catch {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(unavailable());
        }
      },
    );
    return interpret(answer);
  }

  /**
   * Tells the shell something without waiting: a lease ended, and every
   * debugger attached to that node must go.
   */
  notify(nodeId: string, event: string, detail: unknown): void {
    const socket = this.socket;
    if (socket === undefined || !this.ready) return;
    try {
      socket.send(
        JSON.stringify({
          id: "",
          type: "notice",
          notice: event,
          nodeId,
          detail,
        }),
      );
    } catch {
      // A notice is fire-and-forget by design: a revocation that can be
      // delayed by a busy socket is a revocation that has not happened, and
      // the shell drops every attachment when the channel itself closes.
    }
  }

  close(): void {
    this.stopped = true;
    if (this.reconnect !== undefined) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    const socket = this.socket;
    this.disconnect();
    socket?.close();
  }
}

/**
 * Turns one `{ id, ok, result | error }` answer into a result.
 *
 * A refusal keeps its code at the front of the message, the same shape the
 * lease refusals use, because the reader is a model printing its own stdout
 * and the code is the part it can act on.
 */
export function interpret(answer: Record<string, unknown>): unknown {
  if (answer.ok === true) return answer.result ?? null;
  const error =
    typeof answer.error === "object" && answer.error !== null
      ? (answer.error as Record<string, unknown>)
      : {};
  const code = typeof error.code === "string" ? error.code : "browser_failed";
  const message =
    typeof error.message === "string"
      ? error.message
      : "that browser node could not do it";
  const line = `${code}: ${message}`;
  switch (code) {
    case "browser_bad_argument":
    case "browser_unknown_verb":
      throw Refusal.badRequest(line);
    case "browser_not_found":
    case "browser_not_drivable":
      throw Refusal.notFound(line);
    case "browser_refused":
      throw Refusal.forbidden(line);
    default:
      throw Refusal.conflict(line);
  }
}
