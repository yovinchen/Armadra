import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenFile, writeSecret } from "../../paths";
import {
  type AdoptableBackend,
  type Attachment,
  type BackendCapabilities,
  type BackendKind,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  type SessionKey,
  type TerminalBackend,
  type TerminalHandle,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  SESSION_PREFIX,
  conflict,
  executable,
  notFound,
  sanitizePaste,
  sessionName,
  stripEscapes,
  tailLines,
  trimCaptured,
} from "../backend";
import { asRecord, childEnvironment } from "../environment";
import { childCommands, terminateTree } from "../process";
import { type Pty, openPty, releasePty } from "../pty";
import {
  LIST_ALIVE_FORMAT,
  TmuxControl,
  coreFingerprint,
  parseAliveLine,
  enterOnly,
  pastePlan,
} from "./control";
import { detect, ensureConf } from "./config";

/**
 * The primary backend: a private tmux server (contract §15.3).
 *
 * All twelve methods plus the three later ones are real here. The tmux server
 * is a second process that owns the pane, which is what every difference from
 * {@link DirectBackend} comes from: `capture` reads a real screen rather than
 * a replay, `scroll` has a history the page cannot see, `detachAll` drops the
 * clients and keeps the sessions, and the pane survives the core.
 */

interface TmuxClient {
  readonly id: number;
  pty: Pty | undefined;
}

interface TmuxSession {
  readonly name: string;
  readonly generation: number;
  readonly clients: Map<number, TmuxClient>;
  /** Whether the pane is currently scrolled back in copy-mode (§18.5). */
  inCopyMode: boolean;
}

export interface TmuxBackendOptions {
  readonly dataDir: string;
  readonly version: string;
  readonly hookBin?: string | undefined;
}

export class TmuxBackend implements TerminalBackend, AdoptableBackend {
  readonly kind: BackendKind = "tmux";
  private readonly control: TmuxControl;
  private readonly sessions = new Map<SessionKey, TmuxSession>();
  private readonly sinks: ((notice: BackendNotice) => void)[] = [];
  private nextClientId = 1;
  private readonly options: TmuxBackendOptions;

  constructor(options: TmuxBackendOptions) {
    this.options = options;
    this.control = new TmuxControl(options.dataDir);
    ensureConf(this.control.conf);
  }

  /** The socket this backend binds. Tests assert it is under their tempdir. */
  get socket(): string {
    return this.control.socket;
  }

  getCapabilities(): BackendCapabilities {
    const detection = detect();
    return {
      kind: "tmux",
      persistent: true,
      // A tmux client redraws the pane by itself, so no `snapshot` is owed.
      redrawsOnAttach: true,
      usable: detection.usable,
      ...(detection.version === undefined
        ? {}
        : { version: detection.version }),
      ...(detection.reason === undefined ? {} : { reason: detection.reason }),
    };
  }

  /* --------------------------------- create ------------------------------- */

  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    ensureConf(this.control.conf);
    const name = sessionName(
      spec.workspaceId,
      spec.sessionKey,
      spec.generation,
    );
    // A leftover session under the same name would silently be reused.
    await this.control.tryRun(["kill-session", "-t", name]);

    const args = [
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      String(Math.max(2, spec.size.cols)),
      "-y",
      String(Math.max(2, spec.size.rows)),
      "-c",
      spec.cwd,
    ];
    for (const [key, value] of spec.env) {
      args.push("-e", `${key}=${value}`);
    }
    args.push("--", executable(spec), ...spec.args);
    await this.control.run(args);
    await this.control.stampServer(coreFingerprint(this.options.version));

    this.sessions.set(spec.sessionKey, {
      name,
      generation: spec.generation,
      clients: new Map(),
      inCopyMode: false,
    });
    const pid = await this.control.panePid(name);
    return {
      sessionKey: spec.sessionKey,
      generation: spec.generation,
      backendRef: name,
      ...(pid === undefined ? {} : { pid }),
    };
  }

  /**
   * Re-adopts a session this process did not create — after a restart, the
   * tmux server still has it but this map does not. Startup recovery (the rest
   * of R2) is the caller.
   */
  async adopt(
    key: SessionKey,
    name: string,
    generation: number,
  ): Promise<number | undefined> {
    this.sessions.set(key, {
      name,
      generation,
      clients: new Map(),
      inCopyMode: false,
    });
    return this.control.panePid(name);
  }

  /**
   * Start-up check on a server that was already running.
   *
   * A server started by another build (a development core beside the packaged
   * one, both on the same data directory) carries that process’ environment
   * and, on macOS, its sandbox — every session created under it would inherit
   * both. An empty foreign server is therefore replaced; one that still has
   * sessions is kept, because those sessions are the user’s, and the mismatch
   * is reported instead.
   */
  async adoptServer(): Promise<string | undefined> {
    const owner = await this.control.serverOwner();
    // No server, or an unstamped one from before this check existed. The next
    // `new-session` stamps it.
    if (owner === undefined) return undefined;
    const ours = coreFingerprint(this.options.version);
    if (owner === ours) return undefined;
    if ((await this.list()).length === 0) {
      await this.control.tryRun(["kill-server"]);
      return `replaced the empty tmux server of ${owner}`;
    }
    return `the tmux server was started by ${owner}; keeping its sessions`;
  }

  notices(listener: (notice: BackendNotice) => void): void {
    this.sinks.push(listener);
  }

  private announce(notice: BackendNotice): void {
    for (const sink of this.sinks) sink(notice);
  }

  /* --------------------------------- attach ------------------------------- */

  /**
   * One `tmux attach-session` client per socket, inside a pty this process
   * owns. The client redraws the pane by itself, which is why the tmux backend
   * sends no `snapshot` frame.
   */
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
    if (!(await this.control.hasSession(session.name))) {
      throw notFound("Terminal session has exited");
    }

    const pty = openPty({
      file: "tmux",
      args: [...this.control.baseArgs(), "attach-session", "-t", session.name],
      cwd: process.cwd(),
      env: this.control.environment(),
      cols: Math.max(2, size.cols),
      rows: Math.max(2, size.rows),
    });

    const id = this.nextClientId;
    this.nextClientId += 1;
    const client: TmuxClient = { id, pty };
    session.clients.set(id, client);

    const dataListeners: ((chunk: Buffer) => void)[] = [];
    const exitListeners: ((exitCode: number | undefined) => void)[] = [];
    /** Bytes that arrive before the socket has subscribed are not dropped. */
    const buffered: Buffer[] = [];
    let subscribed = false;

    pty.onData((data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      if (!subscribed) {
        buffered.push(chunk);
        return;
      }
      for (const listener of dataListeners) listener(chunk);
    });

    pty.onExit(() => {
      client.pty = undefined;
      session.clients.delete(id);
      // The client is gone. Either we detached it, or the session it was
      // showing ended — only the second case is an exit.
      void this.control.hasSession(session.name).then((alive) => {
        if (alive) return;
        this.sessions.delete(key);
        for (const listener of exitListeners) listener(undefined);
        this.announce({
          type: "exited",
          key,
          generation: session.generation,
        });
      });
    });

    // tmux puts the client pty into raw mode with TCSAFLUSH, which throws away
    // anything written before that point. Waiting for the client's first
    // redraw means the first keystroke of a caller that writes immediately
    // after attaching is not silently swallowed.
    await this.firstRedraw(buffered);

    return {
      attachmentId: id,
      generation: session.generation,
      onData: (listener) => {
        dataListeners.push(listener);
        if (subscribed) return;
        subscribed = true;
        for (const chunk of buffered.splice(0)) listener(chunk);
      },
      onExit: (listener) => exitListeners.push(listener),
    };
  }

  /** Resolves on the first byte, or after two seconds, whichever comes first. */
  private firstRedraw(buffered: Buffer[]): Promise<void> {
    if (buffered.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (buffered.length > 0 || Date.now() - started >= 2000) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
      poll.unref?.();
    });
  }

  /**
   * Ends the `tmux attach-session` process. The session keeps running: this is
   * a detach, not a kill.
   */
  async detach(key: SessionKey, attachmentId: number): Promise<void> {
    const session = this.sessions.get(key);
    const client = session?.clients.get(attachmentId);
    if (session === undefined || client === undefined) return;
    session.clients.delete(attachmentId);
    releasePty(client.pty);
    client.pty = undefined;
  }

  /* ---------------------------------- input ------------------------------- */

  /**
   * Bytes are valid UTF-8 by construction: they come out of a JSON `input`
   * frame, which is a JavaScript string. `write` hands node-pty a string and
   * node-pty encodes it back to the same bytes.
   */
  async input(key: SessionKey, bytes: Buffer): Promise<void> {
    const session = this.require(key);
    // Typing always wins over scrollback: if we scrolled the pane back, drop
    // out of copy-mode first so the bytes reach the application.
    await this.leaveCopyMode(session);
    const client = [...session.clients.values()]
      .reverse()
      .find((entry) => entry.pty !== undefined);
    if (client?.pty === undefined) {
      // Nothing is attached: hand the bytes to the pane directly.
      await this.control.sendKeysBytes(session.name, bytes);
      return;
    }
    client.pty.write(bytes.toString("utf8"));
  }

  /**
   * A tmux buffer, not keystrokes: `-p` wraps it in the bracketed-paste
   * sequence, `-d` deletes the buffer afterwards.
   */
  async paste(
    key: SessionKey,
    text: string,
    pressEnter: boolean,
  ): Promise<void> {
    const session = this.require(key);
    const payload = sanitizePaste(text);
    // Nothing to load. `load-buffer` of an empty file creates no buffer at
    // all, and the `paste-buffer -b` that follows then fails with "no buffer"
    // — a 500 for a request whose only real instruction was "press Enter".
    // The direct backend has always accepted this, so the two agree here.
    if (payload === "") {
      if (pressEnter) await this.control.run(enterOnly(session.name));
      return;
    }
    const buffer = `armadra-${randomUUID().replaceAll("-", "")}`;
    const file = join(tmpdir(), `${buffer}.txt`);
    // 0600 at open time: the text is the user's, and the temporary directory
    // is world-readable.
    writeSecret(file, payload);
    hardenFile(file);
    try {
      for (const args of pastePlan(buffer, file, session.name, pressEnter)) {
        await this.control.run(args);
      }
      // The plan's `if-shell` guard force-exits copy-mode regardless of the
      // cached flag's prior value.
      session.inCopyMode = false;
    } catch (error) {
      await this.control.tryRun(["delete-buffer", "-b", buffer]);
      throw error;
    } finally {
      rmSync(file, { force: true });
    }
  }

  /**
   * `window-size latest` makes the pane follow whichever client last moved, so
   * resizing the client ptys is all that is needed.
   */
  async resize(key: SessionKey, size: TerminalSize): Promise<void> {
    const session = this.require(key);
    const cols = Math.max(2, Math.trunc(size.cols));
    const rows = Math.max(2, Math.trunc(size.rows));
    for (const client of session.clients.values()) {
      try {
        client.pty?.resize(cols, rows);
      } catch {
        // A client that died between the lookup and the call.
      }
    }
  }

  /* -------------------------------- lifecycle ----------------------------- */

  async terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    const session = this.require(key);
    if (mode === "interrupt") {
      await this.signal(key, "interrupt");
      return;
    }
    if (mode === "process") {
      const pid = await this.control.panePid(session.name);
      if (pid !== undefined) await terminateTree(pid);
      return;
    }
    for (const client of session.clients.values()) {
      releasePty(client.pty);
      client.pty = undefined;
    }
    session.clients.clear();
    await this.control.tryRun(["kill-session", "-t", session.name]);
    this.sessions.delete(key);
  }

  async list(): Promise<BackendRef[]> {
    // "no server running on ..." is the empty case, not a failure.
    const output = await this.control.tryRun([
      "list-sessions",
      "-F",
      LIST_ALIVE_FORMAT,
    ]);
    if (output === undefined) return [];
    const refs: BackendRef[] = [];
    for (const line of output.split("\n")) {
      const parsed = parseAliveLine(line, SESSION_PREFIX);
      if (parsed !== undefined) refs.push(parsed);
    }
    return refs;
  }

  /**
   * Process shutdown: drop the clients, keep the sessions. That is the whole
   * reason tmux is the primary backend.
   */
  async detachAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const client of session.clients.values()) {
        releasePty(client.pty);
        client.pty = undefined;
      }
      session.clients.clear();
    }
  }

  /* ---------------------------------- reads -------------------------------- */

  /**
   * `capture-pane -p -J`, i.e. the real screen tmux is holding — not a replay.
   * `-J` joins wrapped lines so a paragraph a CLI printed across the width of
   * the pane comes back as one line rather than as the pane’s geometry.
   */
  async capture(
    key: SessionKey,
    lines: number,
    withEscapes: boolean,
  ): Promise<string> {
    const session = this.require(key);
    const args = ["capture-pane", "-p", "-J"];
    if (withEscapes) args.push("-e");
    args.push("-t", session.name, "-S", lines === 0 ? "-" : `-${lines}`);
    const raw = await this.control.run(args);
    const text = withEscapes ? raw : stripEscapes(raw);
    return tailLines(trimCaptured(text), lines);
  }

  async getForeground(key: SessionKey): Promise<ForegroundInfo> {
    const session = this.require(key);
    const pane = await this.control.paneForeground(session.name);
    return {
      ...(pane.pid === undefined ? {} : { pid: pane.pid }),
      ...(pane.command === undefined ? {} : { command: pane.command }),
      children: pane.pid === undefined ? [] : childCommands(pane.pid),
    };
  }

  /**
   * `send-keys C-c`. tmux delivers it through the pane’s line discipline, so
   * the signal lands on the foreground process group rather than on the shell.
   */
  async signal(key: SessionKey, _signal: "interrupt"): Promise<void> {
    const session = this.require(key);
    await this.control.run(["send-keys", "-t", session.name, "C-c"]);
  }

  /**
   * The wheel bridge of contract §18.5. The client is deliberately not in
   * mouse mode, so a wheel event never reaches tmux on its own; the page turns
   * it into whole lines and posts them here.
   *
   * `copy-mode -e` is the “exit when you scroll back to the bottom” variant,
   * which is exactly what a wheel should do. `#{pane_in_mode}` is re-read
   * afterwards because that automatic exit is the one transition this side
   * does not initiate itself.
   */
  async scroll(key: SessionKey, lines: number): Promise<void> {
    if (lines === 0) return;
    const session = this.require(key);
    if (!(await this.control.paneInMode(session.name))) {
      // Entering copy-mode to scroll *down* would bounce straight back out;
      // there is nothing below the live screen.
      if (lines < 0) {
        session.inCopyMode = false;
        return;
      }
      await this.control.run(["copy-mode", "-e", "-t", session.name]);
    }
    const count = String(Math.min(Math.abs(Math.trunc(lines)), 10_000));
    await this.control.run([
      "send-keys",
      "-X",
      "-N",
      count,
      "-t",
      session.name,
      lines > 0 ? "scroll-up" : "scroll-down",
    ]);
    session.inCopyMode = await this.control.paneInMode(session.name);
  }

  /** Destroys any `armadra-*` session the caller does not know about. */
  async destroyByReference(reference: string): Promise<void> {
    await this.control.run(["kill-session", "-t", reference]);
  }

  /**
   * Nothing to slow down: a detached tmux session has no client of ours at
   * all, so its bytes are already costing this process nothing. tmux keeps the
   * screen either way, which is what makes waking free.
   */
  async setDormant(_key: SessionKey, _dormant: boolean): Promise<void> {}

  /* --------------------------------- helpers ------------------------------- */

  private require(key: SessionKey): TmuxSession {
    const session = this.sessions.get(key);
    if (session === undefined) {
      throw notFound("Terminal session is not running");
    }
    return session;
  }

  /**
   * Leave copy-mode if we put the pane there, so the next keystroke reaches
   * the application instead of being eaten as a copy-mode command (§18.5).
   *
   * Cheap when the flag is already clear: no tmux call at all. The flag is
   * cached rather than asked from tmux on every keystroke because `input` is
   * the hot path for every character the user types, and a `display -p` round
   * trip per keystroke would be absurd.
   */
  private async leaveCopyMode(session: TmuxSession): Promise<void> {
    if (!session.inCopyMode) return;
    session.inCopyMode = false;
    await this.control.tryRun([
      "send-keys",
      "-X",
      "-t",
      session.name,
      "cancel",
    ]);
  }
}

/** Convenience for the assembly point and for tests. */
export function tmuxEnvironment(): Record<string, string> {
  return asRecord(childEnvironment());
}
