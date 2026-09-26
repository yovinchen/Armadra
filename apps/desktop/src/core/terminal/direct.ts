import { StringDecoder } from "node:string_decoder";

import {
  type Attachment,
  type BackendCapabilities,
  type BackendKind,
  type BackendNotice,
  type BackendRef,
  DORMANT_FLUSH_INTERVAL_MS,
  type ForegroundInfo,
  OUTPUT_FLUSH_BYTES,
  OUTPUT_FLUSH_INTERVAL_MS,
  PASTE_END,
  PASTE_START,
  REPLAY_CHUNKS,
  type SessionKey,
  type TerminalBackend,
  type TerminalHandle,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  conflict,
  executable,
  notFound,
  sanitizePaste,
  tailLines,
  trimCaptured,
} from "./backend";
import { asRecord, childEnvironment } from "./environment";
import { childCommands, processTable, terminateTree } from "./process";
import { type Pty, openPty, releasePty } from "./pty";
import { ReplayScreen } from "./replay-screen";

/**
 * The fallback backend: one PTY per session, held by this process.
 *
 * A direct session **dies with the core**, and every behaviour here follows
 * from that one fact:
 *
 *   * `capture` reads a screen this backend keeps itself, fed with every
 *     byte the PTY writes, because there is no terminal to re-read;
 *   * `attach` owes the socket a `snapshot` frame, because nothing redraws;
 *   * `scroll` does nothing: xterm owns that scrollback on the page side;
 *   * `detachAll` **kills**, because "release without ending the session" is
 *     not a thing a process-owned PTY can do.
 *
 * It is what runs when tmux is missing, too old, or turned off — and on
 * Windows when the session host cannot be reached.
 *
 * ## Why the batching is here and not only at the socket
 *
 * `socket.ts` coalesces on its own 16 ms budget, so a second batcher looks
 * redundant. It is not: a session nobody is attached to has no socket at all,
 * and its output still has to be kept for the next attach. Batching here is
 * what makes the replay ring hold ~128 *screenfuls* instead of ~128 8 KiB PTY
 * reads, and it is the only place `setDormant` has anything to slow down.
 */

/** How long `terminate` waits for a killed child before it stops looking. */
const EXIT_POLL_MS = 25;
const EXIT_TIMEOUT_MS = 3_000;

interface DirectListener {
  readonly id: number;
  onData: ((chunk: Buffer) => void) | undefined;
  onExit: ((exitCode: number | undefined) => void) | undefined;
  /** Bytes that arrived before the socket subscribed are not dropped. */
  readonly buffered: Buffer[];
  subscribed: boolean;
}

interface DirectSession {
  readonly key: SessionKey;
  readonly generation: number;
  pty: Pty | undefined;
  readonly pid: number | undefined;
  readonly listeners: Map<number, DirectListener>;
  /** The last {@link REPLAY_CHUNKS} flushed batches, oldest first. */
  readonly replay: Buffer[];
  /** Accumulating batch, flushed on `cadence` or {@link OUTPUT_FLUSH_BYTES}. */
  pending: Buffer[];
  pendingBytes: number;
  timer: NodeJS.Timeout | undefined;
  cadence: number;
  exited: boolean;
  exitCode: number | undefined;
  /**
   * Everything the PTY has written, laid out on a screen of its current size
   * (`replay-screen.ts`) — what `capture` reads. Fed from the first byte, not
   * rebuilt from the replay ring: a CLI that draws its prompt once and then
   * only redraws a spinner pushes the prompt out of the ring within seconds.
   */
  readonly screen: ReplayScreen;
  readonly decoder: StringDecoder;
}

export class DirectBackend implements TerminalBackend {
  readonly kind: BackendKind = "direct";
  private readonly sessions = new Map<SessionKey, DirectSession>();
  private readonly listenerSinks: ((notice: BackendNotice) => void)[] = [];
  private nextListenerId = 1;

  getCapabilities(): BackendCapabilities {
    return {
      kind: "direct",
      persistent: false,
      // Nothing redraws a PTY this process owns, so the socket is owed the
      // replay buffer as one `snapshot` frame.
      redrawsOnAttach: false,
      usable: true,
    };
  }

  notices(listener: (notice: BackendNotice) => void): void {
    this.listenerSinks.push(listener);
  }

  /* --------------------------------- create ------------------------------- */

  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    const env = asRecord(childEnvironment());
    // The caller's variables last, so an explicit `LANG` or `ARMADRA_*` wins
    // over the built block rather than being shadowed by it.
    for (const [name, value] of spec.env) env[name] = value;

    const pty = openPty({
      file: executable(spec),
      args: spec.args,
      cwd: spec.cwd,
      env,
      cols: spec.size.cols,
      rows: spec.size.rows,
    });

    const session: DirectSession = {
      key: spec.sessionKey,
      generation: spec.generation,
      pty,
      pid: pty.pid,
      listeners: new Map(),
      replay: [],
      pending: [],
      pendingBytes: 0,
      timer: undefined,
      screen: new ReplayScreen(spec.size.cols, spec.size.rows),
      decoder: new StringDecoder("utf8"),
      cadence: OUTPUT_FLUSH_INTERVAL_MS,
      exited: false,
      exitCode: undefined,
    };
    this.sessions.set(spec.sessionKey, session);

    pty.onData((data) => {
      this.absorb(session, Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    pty.onExit((event) => {
      // Whatever the process wrote just before it died is still in the batch.
      this.flush(session);
      session.exited = true;
      session.exitCode = event.exitCode;
      session.pty = undefined;
      for (const listener of session.listeners.values()) {
        listener.onExit?.(event.exitCode);
      }
      this.announce({
        type: "exited",
        key: session.key,
        generation: session.generation,
        exitCode: event.exitCode,
      });
    });

    return {
      sessionKey: spec.sessionKey,
      generation: spec.generation,
      // No external handle: there is no server holding this session, so there
      // is nothing an orphan sweep could ever address it by.
      pid: pty.pid,
    };
  }

  /* --------------------------------- output ------------------------------- */

  private absorb(session: DirectSession, chunk: Buffer): void {
    session.pending.push(chunk);
    session.pendingBytes += chunk.byteLength;
    if (session.pendingBytes >= OUTPUT_FLUSH_BYTES) {
      this.flush(session);
      return;
    }
    if (session.timer !== undefined) return;
    session.timer = setTimeout(() => {
      this.flush(session);
    }, session.cadence);
    session.timer.unref?.();
  }

  private flush(session: DirectSession): void {
    if (session.timer !== undefined) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (session.pending.length === 0) return;
    const batch =
      session.pending.length === 1
        ? (session.pending[0] as Buffer)
        : Buffer.concat(session.pending);
    session.pending = [];
    session.pendingBytes = 0;
    session.replay.push(batch);
    while (session.replay.length > REPLAY_CHUNKS) session.replay.shift();
    session.screen.write(session.decoder.write(batch));
    for (const listener of session.listeners.values()) {
      if (!listener.subscribed) {
        listener.buffered.push(batch);
        continue;
      }
      listener.onData?.(batch);
    }
  }

  private announce(notice: BackendNotice): void {
    for (const sink of this.listenerSinks) sink(notice);
  }

  /** The replay buffer as one string — the `snapshot` frame of §15.5. */
  snapshot(key: SessionKey): string | undefined {
    const session = this.sessions.get(key);
    if (session === undefined) return undefined;
    const text = Buffer.concat([...session.replay, ...session.pending])
      .toString("utf8")
      .replace(/\u{FFFD}+$/u, "");
    return text === "" ? undefined : text;
  }

  /* --------------------------------- attach ------------------------------- */

  async attach(
    key: SessionKey,
    generation: number,
    size: TerminalSize,
  ): Promise<Attachment> {
    const session = this.require(key);
    if (session.generation !== generation) {
      throw conflict(
        `Terminal generation ${generation} is stale; the session is at ${session.generation}`,
      );
    }
    // A session that already ended still attaches: the socket needs somewhere
    // to deliver the final `status` from, and the snapshot is still worth
    // showing. Resizing a dead PTY is not, so that is skipped.
    if (!session.exited) await this.resize(key, size);

    const id = this.nextListenerId;
    this.nextListenerId += 1;
    const listener: DirectListener = {
      id,
      onData: undefined,
      onExit: undefined,
      buffered: [],
      subscribed: false,
    };
    session.listeners.set(id, listener);

    return {
      attachmentId: id,
      generation: session.generation,
      onData: (sink) => {
        listener.onData = sink;
        if (listener.subscribed) return;
        listener.subscribed = true;
        for (const chunk of listener.buffered.splice(0)) sink(chunk);
      },
      onExit: (sink) => {
        listener.onExit = sink;
        // The process may have ended between `attach` and this subscription.
        if (session.exited) sink(session.exitCode);
      },
    };
  }

  async detach(key: SessionKey, attachmentId: number): Promise<void> {
    this.sessions.get(key)?.listeners.delete(attachmentId);
  }

  /* ---------------------------------- input ------------------------------- */

  async input(key: SessionKey, bytes: Buffer): Promise<void> {
    const session = this.live(key);
    session.pty?.write(bytes.toString("utf8"));
  }

  /**
   * No paste buffer to load: the bracketed-paste sequence goes straight into
   * the PTY, and the Enter that may follow travels in the **same write** so
   * nothing can interleave between the closing bracket and the newline.
   */
  async paste(
    key: SessionKey,
    text: string,
    pressEnter: boolean,
  ): Promise<void> {
    const payload = `${PASTE_START}${sanitizePaste(text)}${PASTE_END}${pressEnter ? "\r" : ""}`;
    await this.input(key, Buffer.from(payload, "utf8"));
  }

  async resize(key: SessionKey, size: TerminalSize): Promise<void> {
    const session = this.live(key);
    try {
      session.screen.resize(size.cols, size.rows);
      session.pty?.resize(
        Math.max(2, Math.trunc(size.cols)),
        Math.max(2, Math.trunc(size.rows)),
      );
    } catch {
      // A PTY that died between the lookup and the call.
    }
  }

  /**
   * No real screen to re-read, so the plain capture reads the one this backend
   * keeps ({@link DirectSession.screen}): a full-screen CLI draws with cursor
   * moves, not lines, and stripping the escapes off the replay leaves either
   * one run-on line or a tail of redraw fragments. The escaped form is the
   * replay itself.
   */
  async capture(
    key: SessionKey,
    lines: number,
    withEscapes: boolean,
  ): Promise<string> {
    // A session that has produced nothing captures as the empty string; one
    // that does not exist is a 404, and the two must not look alike.
    const session = this.require(key);
    // What arrived since the last batch is part of the screen too.
    this.flush(session);
    const text = withEscapes
      ? (this.snapshot(key) ?? "").replaceAll("\r", "")
      : session.screen.text();
    return tailLines(trimCaptured(text), lines);
  }

  /**
   * 0x03 travels through the line discipline, which turns it into SIGINT for
   * the foreground process group — the same path as a real Ctrl+C. Signalling
   * the pid directly would hit the shell instead of whatever it is running.
   */
  async signal(key: SessionKey, _signal: "interrupt"): Promise<void> {
    await this.input(key, Buffer.from([0x03]));
  }

  async getForeground(key: SessionKey): Promise<ForegroundInfo> {
    const session = this.require(key);
    if (session.pid === undefined) return { children: [] };
    const table = processTable();
    const argv = table.get(session.pid)?.argv;
    return {
      pid: session.pid,
      ...(argv === undefined ? {} : { command: argv }),
      children: childCommands(session.pid, table),
    };
  }

  /* -------------------------------- lifecycle ----------------------------- */

  async terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    if (mode === "interrupt") {
      await this.signal(key, "interrupt");
      return;
    }
    const session = this.require(key);
    if (session.pid !== undefined) await terminateTree(session.pid);
    releasePty(session.pty);
    session.pty = undefined;
    if (mode === "session") this.sessions.delete(key);
  }

  async list(): Promise<BackendRef[]> {
    const refs: BackendRef[] = [];
    for (const [key, session] of this.sessions) {
      if (session.exited) continue;
      refs.push({ name: key, attached: session.listeners.size > 0 });
    }
    return refs;
  }

  /**
   * A direct session has no handle anything outside this process could hold,
   * so there is no such thing as an orphan of this backend and nothing to
   * destroy by reference. Answering rather than throwing keeps the orphan
   * sweep's one loop written once for every backend.
   */
  async destroyByReference(_reference: string): Promise<void> {}

  /** xterm owns this scrollback; there is no second history to move. */
  async scroll(_key: SessionKey, _lines: number): Promise<void> {}

  /**
   * The process and its replay buffer stay exactly as they are; only the
   * delivery cadence changes. Waking is therefore free and can never be
   * mistaken for a create.
   */
  async setDormant(key: SessionKey, dormant: boolean): Promise<void> {
    const session = this.require(key);
    session.cadence = dormant
      ? DORMANT_FLUSH_INTERVAL_MS
      : OUTPUT_FLUSH_INTERVAL_MS;
  }

  /**
   * Core shutdown. Direct sessions cannot survive it, so "release" means
   * "kill" — the one place where this backend's `detachAll` differs from
   * every other one's, and the reason tmux is the primary backend.
   */
  async detachAll(): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      try {
        await this.terminate(key, "session");
      } catch {
        // Already gone; shutdown must not stall on one dead session.
      }
    }
  }

  /**
   * Explicit desktop Quit, unlike a core restart: every owned session is
   * stopped and the exit is **observed**, not assumed. Returns the keys it
   * could not prove had ended, so the caller can report an incomplete quit
   * instead of a silent one.
   */
  async shutdownOwnedChecked(): Promise<string[]> {
    const failures: string[] = [];
    for (const [key, session] of [...this.sessions]) {
      if (session.exited) {
        this.sessions.delete(key);
        continue;
      }
      try {
        if (session.pid !== undefined) await terminateTree(session.pid);
        releasePty(session.pty, "SIGKILL");
        const deadline = Date.now() + EXIT_TIMEOUT_MS;
        while (!session.exited && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
        }
        if (!session.exited) {
          failures.push(`owned terminal ${key} did not exit`);
          continue;
        }
      } catch (error) {
        failures.push(
          `could not terminate ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      this.sessions.delete(key);
    }
    return failures;
  }

  /* --------------------------------- helpers ------------------------------- */

  private require(key: SessionKey): DirectSession {
    const session = this.sessions.get(key);
    if (session === undefined) {
      throw notFound("Terminal session is not running");
    }
    return session;
  }

  private live(key: SessionKey): DirectSession {
    const session = this.require(key);
    if (session.exited) throw conflict("Terminal session has exited");
    return session;
  }
}
