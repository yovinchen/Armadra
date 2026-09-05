import {
  create,
  fromBinary,
  toBinary,
  EventCursorStatus,
  EventDomain,
  EventPriority,
  EventStreamFrameSchema,
  SubscribeEventsRequestSchema,
  type EventEnvelope,
  type EventPage,
} from "@armadra/protocol";

export type { EventEnvelope, EventPage } from "@armadra/protocol";
export {
  EventCursorStatus,
  EventDomain,
  EventPriority,
} from "@armadra/protocol";

/**
 * The Host's business event stream, as a client (host business migration §2.3).
 *
 * The stream exists so a browser stops asking. It states the sequence it last
 * applied; the Host catches it up and then pushes. Everything hard about that
 * is on this side, and it comes down to four rules:
 *
 *  1. **The cursor only moves forward, and only on a page that was received.**
 *     A page that arrives is applied and the cursor advances to `nextCursor` —
 *     including a page whose events were all for another workspace, because
 *     that stretch of history has genuinely been seen. Rewinding on reconnect
 *     would replay changes already applied.
 *  2. **A cursor the Host cannot serve is not a hiccup.** `snapshotRequired`
 *     means re-seed from a snapshot; `cursorAhead` means this client holds
 *     sequences this Host never issued, and following it any further would
 *     silently discard applied work. The first is recoverable, the second
 *     stops the subscription.
 *  3. **Silence is not health.** The Host heartbeats; a client that has heard
 *     nothing at all for longer than that reconnects rather than sitting on a
 *     socket an intermediary quietly dropped.
 *  4. **Reconnecting backs off.** 1s doubling to 10s, reset by a delivered
 *     page — not by a socket that merely opened, which a proxy will happily do
 *     for a Host that is not there.
 */

/** How a subscription ended, in terms the caller can act on. */
export type HostEventStreamStatus =
  /** Never started, or explicitly stopped. */
  | "idle"
  /** A socket is open and the subscription is live. */
  | "streaming"
  /** Between attempts. The caller should keep its fallback running. */
  | "reconnecting"
  /** The cursor fell below the retained floor; re-seed and resume. */
  | "snapshotRequired"
  /** This client is ahead of the Host. Following further would lose work. */
  | "diverged"
  /** The Host refused the subscription; retrying changes nothing. */
  | "denied";

export interface HostEventStreamOptions {
  /** The Host's HTTPS origin. The stream is opened on its `wss:` twin. */
  baseUrl: string;
  /** Workspaces to follow. Every one must be readable by this session. */
  workspaceIds: string[];
  /** The sequence this client has already applied. 0 replays all retained. */
  afterSequence?: bigint;
  /** Narrow to specific domains. Empty means "whatever this session may read". */
  domains?: EventDomain[];
  /** Only events at or above this priority, for a dedicated urgent stream. */
  minPriority?: EventPriority;
  /** Soft page ceiling. The Host clamps it to its own frame budget. */
  pageBytes?: number;
  /**
   * Applied in order, as one group per page. A page is acknowledged only after
   * this returns, so a handler that throws leaves the cursor where it was and
   * the events are re-delivered on the next connection.
   */
  onEvents: (events: EventEnvelope[], page: EventPage) => void;
  /** Every status transition, so a UI can say which source it is reading. */
  onStatus?: (status: HostEventStreamStatus) => void;
  /** Injected for tests and for environments with no global WebSocket. */
  socket?: (url: string) => WebSocketLike;
  /** Injected for tests; defaults to the platform timers. */
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** The part of the WebSocket API this client uses. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;
/** A client that has heard nothing for this long stops trusting the socket. */
export const SILENCE_TIMEOUT_MS = 60_000;

export function nextReconnectDelay(previous: number | null): number {
  if (previous === null || previous <= 0) return RECONNECT_MIN_MS;
  return Math.min(previous * 2, RECONNECT_MAX_MS);
}

export class HostEventStreamError extends Error {
  readonly name = "HostEventStreamError";
  constructor(readonly reason: "invalid" | "unsupported") {
    super(`Host event stream cannot start (${reason}).`);
  }
}

const scopedId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_WORKSPACES = 32;

/** The stream's path on the Host. It is not an /rpc method: nothing is asked. */
export const EVENT_STREAM_PATH = "/ws/armadra.v1.EventStream";

/**
 * Builds the stream URL from the Host's HTTPS origin. Only `https:` upgrades to
 * a stream: an `http:` origin would carry the session cookie in the clear, and
 * a mixed-content page cannot open one anyway.
 */
export function eventStreamUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HostEventStreamError("invalid");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new HostEventStreamError("invalid");
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:" && loopback) url.protocol = "ws:";
  else throw new HostEventStreamError("invalid");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${EVENT_STREAM_PATH}`;
  return url.href;
}

export class HostEventStreamClient {
  readonly #options: HostEventStreamOptions;
  readonly #url: string;
  readonly #open: (url: string) => WebSocketLike;
  readonly #schedule: (handler: () => void, ms: number) => unknown;
  readonly #cancel: (handle: unknown) => void;

  #socket: WebSocketLike | null = null;
  #timer: unknown = null;
  #watchdog: unknown = null;
  #delay: number | null = null;
  #cursor: bigint;
  #status: HostEventStreamStatus = "idle";
  #stopped = true;

  constructor(options: HostEventStreamOptions) {
    if (
      !options ||
      typeof options.onEvents !== "function" ||
      !Array.isArray(options.workspaceIds) ||
      options.workspaceIds.length === 0 ||
      options.workspaceIds.length > MAX_WORKSPACES ||
      options.workspaceIds.some((id) => !scopedId.test(id ?? "")) ||
      new Set(options.workspaceIds).size !== options.workspaceIds.length
    )
      throw new HostEventStreamError("invalid");
    const after = options.afterSequence ?? 0n;
    if (typeof after !== "bigint" || after < 0n)
      throw new HostEventStreamError("invalid");
    this.#url = eventStreamUrl(options.baseUrl);
    const factory =
      options.socket ??
      ((url: string) => {
        const Socket = globalThis.WebSocket;
        if (!Socket) throw new HostEventStreamError("unsupported");
        return new Socket(url) as unknown as WebSocketLike;
      });
    this.#options = options;
    this.#open = factory;
    this.#schedule =
      options.setTimeout ??
      ((handler, ms) => globalThis.setTimeout(handler, ms));
    this.#cancel =
      options.clearTimeout ??
      ((handle) => globalThis.clearTimeout(handle as never));
    this.#cursor = after;
  }

  get status(): HostEventStreamStatus {
    return this.#status;
  }

  /** The sequence applied so far. Survives reconnects; only ever advances. */
  get cursor(): bigint {
    return this.#cursor;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#delay = null;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#teardown();
    this.#setStatus("idle");
  }

  /**
   * Resumes after a snapshot re-seeded the caller's state. The sequence must be
   * the one the snapshot reported it is consistent with: resuming from anything
   * earlier replays changes the snapshot already contains, and from anything
   * later skips changes it does not.
   */
  resumeFromSnapshot(sequence: bigint): void {
    if (typeof sequence !== "bigint" || sequence < 0n)
      throw new HostEventStreamError("invalid");
    this.#cursor = sequence;
    this.#stopped = false;
    this.#delay = null;
    this.#teardown();
    this.#connect();
  }

  #setStatus(status: HostEventStreamStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    try {
      this.#options.onStatus?.(status);
    } catch {
      /* A listener that mishandles a transition must not kill the stream. */
    }
  }

  #teardown(): void {
    if (this.#timer !== null) this.#cancel(this.#timer);
    this.#timer = null;
    if (this.#watchdog !== null) this.#cancel(this.#watchdog);
    this.#watchdog = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* Already closed transports are the normal case here. */
      }
    }
  }

  #connect(): void {
    if (this.#stopped) return;
    let socket: WebSocketLike;
    try {
      socket = this.#open(this.#url);
    } catch {
      this.#retry();
      return;
    }
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.#socket !== socket || this.#stopped) return;
      // The delay is not reset here: a proxy will open a socket for a Host that
      // is not answering, and resetting on `open` would turn the backoff into a
      // tight loop against exactly that.
      this.#setStatus("streaming");
      this.#send(socket, {
        payload: {
          case: "subscribe",
          value: create(SubscribeEventsRequestSchema, {
            afterSequence: this.#cursor,
            workspaceIds: this.#options.workspaceIds,
            domains: this.#options.domains ?? [],
            pageBytes: this.#options.pageBytes ?? 0,
            minPriority: this.#options.minPriority ?? EventPriority.UNSPECIFIED,
          }),
        },
      });
      this.#arm();
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket || this.#stopped) return;
      this.#arm();
      this.#receive(socket, event.data);
    };
    socket.onclose = () => {
      if (this.#socket !== socket || this.#stopped) return;
      // Tear down before scheduling: a watchdog left armed on a dead socket
      // would fire during the *next* connection and close a healthy stream.
      this.#teardown();
      this.#retry();
    };
    // A browser always follows `onerror` with `onclose`; scheduling on both
    // would queue two reconnects for one failure.
    socket.onerror = () => {};
  }

  /** Restarts the silence watchdog. Any frame counts, heartbeats included. */
  #arm(): void {
    if (this.#watchdog !== null) this.#cancel(this.#watchdog);
    this.#watchdog = this.#schedule(() => {
      this.#watchdog = null;
      if (this.#stopped) return;
      // The socket looks open but nothing is arriving. Treat it as gone: the
      // cursor is intact, so reconnecting costs one page of re-read at most.
      this.#teardown();
      this.#retry();
    }, SILENCE_TIMEOUT_MS);
  }

  #retry(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#setStatus("reconnecting");
    const delay = nextReconnectDelay(this.#delay);
    this.#delay = delay;
    this.#timer = this.#schedule(() => {
      this.#timer = null;
      this.#connect();
    }, delay);
  }

  #send(
    socket: WebSocketLike,
    frame: Parameters<typeof create<typeof EventStreamFrameSchema>>[1],
  ): void {
    try {
      socket.send(
        new Uint8Array(
          toBinary(
            EventStreamFrameSchema,
            create(EventStreamFrameSchema, frame),
          ),
        ),
      );
    } catch {
      // The socket died mid-write; `onclose` schedules the reconnect.
    }
  }

  #receive(socket: WebSocketLike, data: unknown): void {
    let wire: Uint8Array;
    if (data instanceof ArrayBuffer) wire = new Uint8Array(data);
    else if (ArrayBuffer.isView(data))
      wire = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return;
    let frame;
    try {
      frame = fromBinary(EventStreamFrameSchema, wire);
    } catch {
      // A frame this client cannot parse is not a reason to drop a stream that
      // is otherwise delivering: a newer Host may send one this build predates.
      return;
    }
    if (frame.payload.case === "error") {
      // The Host named a reason. Retrying a refusal changes nothing, so a
      // permission failure stops; anything else is transient and reconnects.
      if (frame.payload.value.code === "PERMISSION_DENIED") {
        this.#stopped = true;
        this.#teardown();
        this.#setStatus("denied");
      }
      return;
    }
    if (frame.payload.case !== "page") return;
    const page = frame.payload.value;
    if (page.status === EventCursorStatus.SNAPSHOT_REQUIRED) {
      this.#stopped = true;
      this.#teardown();
      this.#setStatus("snapshotRequired");
      return;
    }
    if (page.status === EventCursorStatus.CURSOR_AHEAD) {
      this.#stopped = true;
      this.#teardown();
      this.#setStatus("diverged");
      return;
    }
    // An unspecified or unknown status is not "probably fine": applying it and
    // advancing the cursor would step past events that were never delivered.
    if (page.status !== EventCursorStatus.OK) return;
    if (page.nextCursor < this.#cursor) return;
    let previous = this.#cursor;
    for (const event of page.events) {
      if (event.sequence <= previous || !event.entityId) return;
      previous = event.sequence;
    }
    if (page.nextCursor < previous) return;
    // Delivered before the cursor moves and before the ack: a handler that
    // throws leaves both where they were, so the page arrives again.
    this.#options.onEvents(page.events, page);
    this.#cursor = page.nextCursor;
    this.#delay = null;
    this.#send(socket, {
      payload: { case: "ack", value: { receivedThrough: this.#cursor } },
    });
  }
}
