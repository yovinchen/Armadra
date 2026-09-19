import { type Server, type Socket, createServer } from "node:net";
import { HandshakeVerifier } from "../core/terminal/session-host/auth";
import {
  type ClientMessage,
  type CreateSpec,
  type Frame,
  type HostErrorCode,
  type HostMessage,
  type HostSize,
  FrameDecoder,
  FrameError,
  HANDSHAKE_TIMEOUT_MS,
  MAX_PAYLOAD,
  PROTOCOL_MAJOR,
  clampSize,
  encodeFrame,
  jsonFrame,
} from "../core/terminal/session-host/protocol";
import {
  type ConsoleSession as Console,
  type PtySpawner,
  CloseTimeout,
  ConsoleSession,
  openConsole,
} from "./pty";
import { QueryResponder, ReplayBuffer } from "./replay";
import {
  type ConnectionId,
  SessionError,
  SessionTable,
  isOver,
} from "./sessions";

/**
 * The server: one named pipe, many connections, every session this user owns.
 *
 * Shape, and why — a port of `crates/session-host/src/host/`:
 *
 *   * **One pipe, many connections.** A slow subscriber must not delay a
 *     control request on another connection. The name is derived
 *     (`protocol.ts`), and who may speak on it is decided by the HMAC
 *     handshake in `core/terminal/session-host/auth.ts` rather than by a
 *     DACL — the deviation is documented there in full.
 *   * **Every accepted connection is authenticated.** The name is
 *     predictable, so being connected proves nothing; a connection that does
 *     not present a valid proof is closed before it can ask for anything.
 *   * **A session with no subscribers is the normal case.** Output is drained
 *     and buffered regardless. Nothing about this process' idea of "idle"
 *     involves whether a UI exists — only whether sessions do.
 *   * **Exit is conservative.** The host leaves when it owns no live session
 *     and has owned none for the idle period. While one session lives it
 *     stays, forever if need be.
 */

/** How long the host stays alive after its last session ended. */
export const DEFAULT_IDLE_EXIT_MS = 30 * 60 * 1000;

/** How often the idle check runs. */
const TICK_MS = 5_000;

/**
 * Bytes one connection may fall behind by before it is treated as slow. The
 * Rust host counted frames in a bounded channel; a socket's own
 * `writableLength` is the same quantity in the unit Node actually exposes.
 */
const CONNECTION_HIGH_WATER = 4 * 1024 * 1024;

/**
 * Output is chunked to comfortably fit a frame; the remaining headroom
 * absorbs the header without another length check on the hot path.
 */
const OUTPUT_CHUNK = Math.floor(MAX_PAYLOAD / 4);

/** One session's runtime state. */
interface Live {
  readonly console: Console;
  readonly replay: ReplayBuffer;
  readonly responder: QueryResponder;
}

interface Connection {
  readonly id: ConnectionId;
  readonly socket: Socket;
  readonly decoder: FrameDecoder;
  greeted: boolean;
  /** Whether this connection is currently the reason a session is paused. */
  behind: boolean;
  handshakeTimer: NodeJS.Timeout | undefined;
}

export interface SessionHostOptions {
  readonly dataDir: string;
  /** The pipe (or, in the tests, the Unix socket) this host listens on. */
  readonly endpoint: string;
  /** The shared secret every `hello` must prove knowledge of. */
  readonly key: Buffer;
  readonly version: string;
  readonly idleExitMs?: number;
  readonly tickMs?: number;
  /** Injected by the tests; production opens a real ConPTY. */
  readonly spawn?: PtySpawner;
  readonly log?: (line: string) => void;
}

/** `listen` failed because another host of this user already owns the pipe. */
export class AlreadyServing extends Error {
  constructor(readonly endpoint: string) {
    super(`another session host already owns ${endpoint}`);
    this.name = "AlreadyServing";
  }
}

export class SessionHost {
  private readonly table = new SessionTable();
  private readonly live = new Map<string, Live>();
  private readonly connections = new Map<ConnectionId, Connection>();
  private readonly verifier: HandshakeVerifier;
  private readonly spawn: PtySpawner;
  private readonly idleExitMs: number;
  private readonly tickMs: number;
  private readonly log: (line: string) => void;
  private readonly instanceId: string;
  private server: Server | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private nextConnection: ConnectionId = 1;
  private idleSince: number | undefined = Date.now();
  private stopping: Promise<void> | undefined;
  private readonly leaving: (() => void)[] = [];

  constructor(private readonly options: SessionHostOptions) {
    this.verifier = new HandshakeVerifier(options.key, options.endpoint);
    this.spawn = options.spawn ?? openConsole;
    this.idleExitMs = options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.log = options.log ?? (() => {});
    // Cheap and sufficient: it only has to differ between runs of this
    // executable, so a core can tell "the host restarted" from "the host has
    // no sessions".
    this.instanceId = `${process.pid}-${Date.now()}`;
  }

  /** Resolves when the host has decided to leave. */
  onLeaving(listener: () => void): void {
    this.leaving.push(listener);
  }

  /**
   * Opens the pipe.
   *
   * `EADDRINUSE` is the concurrency gate, not a failure: losing the race for
   * the pipe is the normal outcome of two cores starting at once, and the
   * other host serves both.
   */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer({ pauseOnConnect: false }, (socket) =>
        this.accept(socket),
      );
      server.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "EADDRINUSE"
            ? new AlreadyServing(this.options.endpoint)
            : error,
        );
      });
      server.listen(this.options.endpoint, () => {
        this.server = server;
        this.log(`session host listening on ${this.options.endpoint}`);
        this.ticker = setInterval(() => void this.tick(), this.tickMs);
        this.ticker.unref?.();
        resolve();
      });
    });
  }

  /**
   * Stops serving and releases every console, with proof.
   *
   * This is the stand-in for the Job Object's `KILL_ON_JOB_CLOSE`: Node has
   * no Job Object, so the containment has to be an explicit sweep on the way
   * out. It covers every orderly exit; it does not cover a `SIGKILL`, and
   * nothing here can.
   */
  async close(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const connection of [...this.connections.values()]) {
      this.tell(connection.id, {
        type: "bye",
        reason: "the session host is shutting down",
        drain: false,
      });
      connection.socket.destroy();
    }
    this.connections.clear();
    const keys = [...this.live.keys()];
    await Promise.all(keys.map((key) => this.release(key)));
    this.live.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** For the tests and the status routes: what this host currently holds. */
  get sessionCount(): number {
    return this.table.size;
  }

  /* -------------------------------- sessions ------------------------------ */

  /**
   * Ends one console and proves it was released.
   *
   * Never throws: this runs on shutdown and on `destroy`, and a console that
   * refuses to confirm its own close must not stop the other nine from being
   * asked. The refusal is returned instead, and the caller decides what to
   * say about it.
   */
  private async release(key: string): Promise<CloseTimeout | undefined> {
    const live = this.live.get(key);
    if (live === undefined) return undefined;
    try {
      await live.console.close();
      return undefined;
    } catch (error) {
      if (error instanceof CloseTimeout) {
        this.log(`${error.message}`);
        return error;
      }
      this.log(
        `会话 ${key} 关闭失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** Turns a process that ended into an `exit` for whoever is watching. */
  private noteExit(
    key: string,
    generation: number,
    code: number | undefined,
  ): void {
    if (!this.table.markExited(key, generation, code)) return;
    this.tellSubscribers(key, {
      type: "exit",
      sessionKey: key,
      generation,
      exitCode: code ?? null,
    });
    if (this.table.allOver && this.idleSince === undefined) {
      this.idleSince = Date.now();
    }
  }

  /**
   * Leaves once no session has existed for the idle period. A single live
   * session keeps this process alive indefinitely, which is the promise the
   * whole design rests on.
   */
  private async tick(): Promise<void> {
    const over = this.table.allOver;
    if (over && this.idleSince === undefined) this.idleSince = Date.now();
    if (!over) this.idleSince = undefined;
    if (this.table.drained) {
      this.log("drained; leaving");
      for (const listener of this.leaving.splice(0)) listener();
      return;
    }
    const since = this.idleSince;
    if (since !== undefined && Date.now() - since >= this.idleExitMs) {
      this.log(`idle for ${this.idleExitMs}ms; leaving`);
      for (const listener of this.leaving.splice(0)) listener();
    }
  }

  /* ------------------------------ connections ----------------------------- */

  private accept(socket: Socket): void {
    const id = this.nextConnection;
    this.nextConnection += 1;
    socket.setNoDelay?.(true);
    const connection: Connection = {
      id,
      socket,
      decoder: new FrameDecoder(),
      greeted: false,
      behind: false,
      handshakeTimer: undefined,
    };
    this.connections.set(id, connection);
    // A connection that holds the pipe open without ever saying hello is a
    // resource somebody else needs.
    connection.handshakeTimer = setTimeout(() => {
      if (!connection.greeted) this.dropConnection(id);
    }, HANDSHAKE_TIMEOUT_MS);
    connection.handshakeTimer.unref?.();
    socket.on("data", (chunk: Buffer) => this.read(connection, chunk));
    socket.on("drain", () => this.releasePressure(id));
    socket.on("error", () => this.dropConnection(id));
    socket.on("close", () => this.dropConnection(id));
  }

  private read(connection: Connection, chunk: Buffer): void {
    connection.decoder.push(chunk);
    for (;;) {
      let frame: Frame | undefined;
      try {
        frame = connection.decoder.next();
      } catch (error) {
        // Framing is gone; there is nothing to resynchronise to.
        this.log(
          `closing an unreadable connection: ${
            error instanceof FrameError ? error.message : String(error)
          }`,
        );
        this.dropConnection(connection.id);
        return;
      }
      if (frame === undefined) return;
      if (frame.kind !== "json") continue;
      let message: ClientMessage;
      try {
        message = JSON.parse(frame.payload.toString("utf8")) as ClientMessage;
      } catch {
        continue;
      }
      if (!this.greet(connection, message)) return;
    }
  }

  /**
   * Runs the handshake, or dispatches once it is done.
   *
   * Returns `false` when the connection has been closed and the caller must
   * stop feeding it frames.
   */
  private greet(connection: Connection, message: ClientMessage): boolean {
    if (connection.greeted) {
      void this.handle(connection.id, message);
      return true;
    }
    // Anything before hello is refused rather than served.
    if (message.type !== "hello") {
      this.refuse(connection, "unauthorized", "hello first");
      return false;
    }
    if (message.protocol !== PROTOCOL_MAJOR) {
      this.refuse(
        connection,
        "unsupportedProtocol",
        `this host speaks protocol ${PROTOCOL_MAJOR}`,
      );
      return false;
    }
    const verdict = this.verifier.verify(
      (message as { auth?: unknown }).auth,
      Date.now(),
    );
    if (!verdict.ok) {
      // The refusal names the reason to this host's log and *not* to the
      // caller: a peer that cannot prove it holds the key learns only that it
      // was refused, never which part of its attempt was closest.
      this.log(
        `refusing connection ${connection.id}: handshake ${verdict.reason}`,
      );
      this.refuse(connection, "unauthorized", "handshake refused");
      return false;
    }
    connection.greeted = true;
    if (connection.handshakeTimer !== undefined) {
      clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = undefined;
    }
    this.log(
      `client greeted on connection ${connection.id}: ${message.client}`,
    );
    this.tell(connection.id, {
      type: "welcome",
      protocol: PROTOCOL_MAJOR,
      host: this.options.version,
      pid: process.pid,
      instanceId: this.instanceId,
      sessions: this.table.summaries(),
    });
    return true;
  }

  /**
   * Turns a client away, having told it why.
   *
   * The refusal is written and the socket is **ended** rather than destroyed:
   * `destroy` drops whatever is still in the write buffer, so a connection
   * closed the instant after the error frame was queued would be refused
   * silently — the client would time out on `welcome` and report a host that
   * never answered instead of one that said no.
   */
  private refuse(
    connection: Connection,
    code: HostErrorCode,
    message: string,
  ): void {
    connection.socket.write(jsonFrame({ type: "error", id: 0, code, message }));
    this.forget(connection.id);
    connection.socket.end();
  }

  /**
   * A connection is gone: unsubscribe it everywhere and release any pause it
   * was holding. Unconditional, because a frontend that crashed while paused
   * must not freeze the CLI.
   */
  private dropConnection(id: ConnectionId): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.forget(id);
    connection.socket.destroy();
  }

  /** The bookkeeping half of {@link dropConnection}, without the socket. */
  private forget(id: ConnectionId): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    if (connection.handshakeTimer !== undefined) {
      clearTimeout(connection.handshakeTimer);
    }
    for (const key of this.table.disconnect(id)) {
      this.live.get(key)?.console.setPaused(false);
    }
  }

  /** The reader may resume for anything this connection had paused. */
  private releasePressure(id: ConnectionId): void {
    const connection = this.connections.get(id);
    if (connection === undefined || !connection.behind) return;
    connection.behind = false;
    for (const entry of this.table.entries()) {
      if (!entry.paused) continue;
      if (this.table.setFlow(entry.sessionKey, id, false)) {
        this.live.get(entry.sessionKey)?.console.setPaused(false);
      }
    }
  }

  /* --------------------------------- sending ------------------------------ */

  private send(id: ConnectionId, bytes: Buffer): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    connection.socket.write(bytes);
    if (connection.socket.writableLength <= CONNECTION_HIGH_WATER) return;
    // A subscriber that cannot keep up pauses the reader rather than being
    // dropped: back pressure reaches the CLI the same way it would through a
    // real terminal, and the pause is released when the connection catches up
    // (the socket's `drain`) or goes away.
    connection.behind = true;
  }

  private tell(id: ConnectionId, message: HostMessage): void {
    this.send(id, jsonFrame(message));
  }

  private tellSubscribers(key: string, message: HostMessage): void {
    for (const connection of this.table.get(key)?.subscribers() ?? []) {
      this.tell(connection, message);
    }
  }

  private fail(
    id: ConnectionId,
    requestId: number,
    code: HostErrorCode,
    message: string,
  ): void {
    this.tell(id, { type: "error", id: requestId, code, message });
  }

  private ok(
    id: ConnectionId,
    requestId: number,
    extra: Omit<Extract<HostMessage, { type: "ok" }>, "type" | "id"> = {},
  ): void {
    this.tell(id, { type: "ok", id: requestId, ...extra });
  }

  /* -------------------------------- requests ------------------------------ */

  private async handle(
    id: ConnectionId,
    message: ClientMessage,
  ): Promise<void> {
    switch (message.type) {
      case "hello":
        return;
      case "create":
        this.create(id, message);
        return;
      case "attach":
        this.attach(
          id,
          message.id,
          message.sessionKey,
          message.generation,
          message.size,
        );
        return;
      case "detach": {
        this.table.detach(message.sessionKey, id);
        this.live.get(message.sessionKey)?.console.setPaused(false);
        this.ok(id, message.id);
        return;
      }
      case "write": {
        const bytes = Buffer.from(message.data, "base64");
        // `Buffer.from` is lenient where the Rust decoder was strict, so the
        // round trip is what decides: anything that does not re-encode to the
        // same string was not base64.
        if (
          bytes.toString("base64").replace(/=+$/, "") !==
          message.data.replace(/=+$/, "")
        ) {
          this.fail(id, message.id, "badRequest", "write data is not base64");
          return;
        }
        this.act(id, message.id, message.sessionKey, (live) =>
          live.console.write(bytes),
        );
        return;
      }
      case "resize": {
        const size = clampSize({ cols: message.cols, rows: message.rows });
        const entry = this.table.get(message.sessionKey);
        if (entry !== undefined) entry.size = size;
        this.act(id, message.id, message.sessionKey, (live) =>
          live.console.resize(size.cols, size.rows),
        );
        return;
      }
      case "list":
        this.ok(id, message.id, { sessions: this.table.summaries() });
        return;
      case "interrupt":
        // Windows has no SIGINT to send. `0x03` through the console input is
        // what a real Ctrl+C is, and it is the one path that works for a Win32
        // CLI, a Node CLI and a WSL shell alike.
        this.act(id, message.id, message.sessionKey, (live) =>
          live.console.write(Buffer.from([0x03])),
        );
        return;
      case "kill":
        this.act(id, message.id, message.sessionKey, (live) =>
          live.console.kill(),
        );
        return;
      case "destroy":
        await this.destroy(id, message.id, message.sessionKey);
        return;
      case "flow": {
        if (this.table.setFlow(message.sessionKey, id, message.paused)) {
          this.live.get(message.sessionKey)?.console.setPaused(message.paused);
        }
        this.ok(id, message.id);
        return;
      }
    }
  }

  /**
   * Runs `action` against a live session, answering `ok` or the reason it
   * could not. Everything that needs a live session goes through here so the
   * check is applied once rather than at every call site.
   */
  private act(
    id: ConnectionId,
    requestId: number,
    key: string,
    action: (live: Live) => void,
  ): void {
    const entry = this.table.get(key);
    if (entry === undefined) {
      this.fail(id, requestId, "notFound", `no session for ${key}`);
      return;
    }
    if (isOver(entry.state)) {
      this.fail(id, requestId, "notFound", `${key} has ended`);
      return;
    }
    const live = this.live.get(key);
    if (live === undefined) {
      this.fail(id, requestId, "internal", "session has no console");
      return;
    }
    action(live);
    this.ok(id, requestId, { session: entry.summary() });
  }

  private create(id: ConnectionId, spec: CreateSpec & { id: number }): void {
    // Reserve the row first, so two creates racing for one key cannot both
    // start a console.
    try {
      this.table.create(
        spec.sessionKey,
        spec.generation,
        spec.workspaceId,
        spec.cwd,
        spec.size,
      );
    } catch (error) {
      if (error instanceof SessionError) {
        this.fail(id, spec.id, error.code, error.message);
        return;
      }
      throw error;
    }
    const size = clampSize(spec.size);
    const generation = spec.generation;
    const key = spec.sessionKey;
    const replay = new ReplayBuffer();
    const responder = new QueryResponder();
    let console: Console;
    try {
      console = new ConsoleSession(
        {
          sessionKey: key,
          cwd: spec.cwd,
          program: spec.command ?? spec.shell,
          args: spec.args,
          env: Object.fromEntries(
            spec.env.map(([name, value]) => [name, value]),
          ),
          cols: size.cols,
          rows: size.rows,
          onData: (chunk) => this.pump(key, generation, chunk),
          onExit: (code) => this.noteExit(key, generation, code),
        },
        this.spawn,
      );
    } catch (error) {
      // The reservation must not survive a failed spawn, or the key is
      // permanently unusable.
      this.table.remove(key);
      this.fail(
        id,
        spec.id,
        "badRequest",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const entry = this.table.get(key);
    if (entry !== undefined) entry.pid = console.pid;
    this.live.set(key, { console, replay, responder });
    this.idleSince = undefined;
    this.ok(id, spec.id, { session: entry?.summary() });
  }

  private attach(
    id: ConnectionId,
    requestId: number,
    key: string,
    generation: number,
    size: HostSize,
  ): void {
    const current = this.table.get(key)?.generation;
    let entry;
    try {
      entry = this.table.attach(key, generation, id, size);
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      if (error.code === "stale" && current !== undefined) {
        this.tell(id, { type: "stale", sessionKey: key, generation, current });
      }
      this.fail(id, requestId, error.code, error.message);
      return;
    }
    const summary = entry.summary();
    const live = this.live.get(key);
    // The replay goes out in the same turn that registered the subscriber, so
    // there is no window in which output is produced but this connection is
    // neither replayed nor subscribed — that window is exactly how a re-attach
    // loses a line.
    const snapshot = live?.replay.snapshot() ?? Buffer.alloc(0);
    live?.console.resize(summary.size.cols, summary.size.rows);
    for (let offset = 0; offset < snapshot.byteLength; offset += OUTPUT_CHUNK) {
      this.send(
        id,
        encodeFrame({
          kind: "snapshot",
          generation,
          payload: Buffer.from(
            snapshot.subarray(offset, offset + OUTPUT_CHUNK),
          ),
        }),
      );
    }
    this.send(
      id,
      encodeFrame({
        kind: "snapshotEnd",
        generation,
        payload: Buffer.alloc(0),
      }),
    );
    if (live?.replay.truncated === true) {
      this.tell(id, {
        type: "warning",
        sessionKey: key,
        message: "older output was dropped from the replay buffer",
      });
    }
    this.ok(id, requestId, { session: summary });
  }

  /**
   * Ends a session for good.
   *
   * A close that could not be proven is reported as an error even though the
   * row is gone: the client must not keep a key that still answers, and this
   * host must not claim a HPCON was released when it did not see it happen.
   */
  private async destroy(
    id: ConnectionId,
    requestId: number,
    key: string,
  ): Promise<void> {
    const refusal = await this.release(key);
    this.live.delete(key);
    this.table.remove(key);
    if (this.table.allOver && this.idleSince === undefined) {
      this.idleSince = Date.now();
    }
    if (refusal !== undefined) {
      this.fail(id, requestId, "internal", refusal.message);
      return;
    }
    this.ok(id, requestId);
  }

  /**
   * Consumes one session's console output for the life of that session.
   *
   * Runs whether or not anybody is attached, which is the rule ConPTY makes
   * non-negotiable: an undrained console blocks the CLI and then deadlocks its
   * own close.
   */
  private pump(key: string, generation: number, chunk: Buffer): void {
    const live = this.live.get(key);
    if (live === undefined) return;
    // Answer the terminal's own questions before anything else: a console that
    // asked where the cursor is waits for this, and there may be no UI to
    // answer for it.
    const reply = live.responder.observe(chunk);
    if (reply.byteLength > 0) live.console.write(reply);
    live.replay.push(chunk);

    const entry = this.table.get(key);
    if (entry === undefined || entry.generation !== generation) return;
    const subscribers = entry.subscribers();
    if (subscribers.length === 0) return;
    const frames: Buffer[] = [];
    for (let offset = 0; offset < chunk.byteLength; offset += OUTPUT_CHUNK) {
      frames.push(
        encodeFrame({
          kind: "output",
          generation,
          sequence: entry.takeSequence(),
          payload: Buffer.from(chunk.subarray(offset, offset + OUTPUT_CHUNK)),
        }),
      );
    }
    for (const id of subscribers) {
      for (const frame of frames) this.send(id, frame);
      const connection = this.connections.get(id);
      if (connection?.behind !== true) continue;
      this.tell(id, {
        type: "warning",
        sessionKey: key,
        message: "output is being throttled to let this client catch up",
      });
      if (this.table.setFlow(key, id, true)) live.console.setPaused(true);
    }
  }
}
