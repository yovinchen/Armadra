import { loadNodePty } from "../core/terminal/pty";

/**
 * The pseudo consoles this process owns.
 *
 * `CreatePseudoConsole` hands the pseudo console to the process that called
 * it, and `ClosePseudoConsole` ends every console process attached to it.
 * That pair of facts is the whole reason this executable exists: hold the
 * HPCON here, and the core and the desktop shell can come and go without the
 * CLI noticing.
 *
 * Three rules, all of them from the ConPTY documentation, and every detail
 * below exists to honour them:
 *
 *   * **Output is always drained.** Not "while a client is attached" —
 *     always. A ConPTY whose output nobody reads fills its buffer and blocks
 *     the CLI, and blocks again on close.
 *   * **Closing the console is not detaching.** It ends the session. Only an
 *     explicit destroy takes that path.
 *   * **The close must be proven, not assumed.** See {@link ConsoleSession.close}.
 *
 * ## What is different from the Rust host
 *
 * | Rust                                  | here                                           |
 * | ------------------------------------- | ---------------------------------------------- |
 * | `portable-pty` → `CreatePseudoConsole` | `node-pty` with `useConpty: true`              |
 * | Job Object with `KILL_ON_JOB_CLOSE`    | no equivalent; the sweep in `server.ts`' `close()` |
 * | blocking reader thread + `Condvar` gate | node-pty's own stream, `pause()` / `resume()` |
 *
 * The Job Object is the real loss and is not papered over: Node has no API
 * for one, and adding a native module to get it back is the dependency R6
 * exists to remove. What replaces it is (1) ConPTY's own guarantee that
 * closing the console ends the processes attached to it, and (2) this
 * process explicitly destroying every session on the way out, from the exit
 * paths wired up in `main.ts`. What neither replaces is a **`SIGKILL`ed
 * host**: the Job Object would have taken the tree with it, and here the tree
 * survives until ConPTY notices its console is gone. That is written down in
 * `docs/design/typescript-core.md` R6 rather than discovered.
 */

/**
 * The slice of node-pty this file uses.
 *
 * Declared rather than imported for the same reason `core/terminal/pty.ts`
 * declares its own: with `encoding: null` node-pty hands back `Buffer`s even
 * though its typings say `string`, and a fake implementation has to be able
 * to satisfy this on a machine where the module was never compiled.
 */
export interface HostPty {
  readonly pid: number;
  onData(listener: (data: Buffer | string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly program: string;
  readonly args: readonly string[];
  /**
   * Built, never inherited: this process' own environment is whatever started
   * it, and a CLI must not see another agent's session variables. The core
   * sends the exact set it wants.
   */
  readonly env: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
}

/** Injectable so the state machine can be tested without a real console. */
export type PtySpawner = (options: SpawnOptions) => HostPty;

/**
 * Opens a real ConPTY.
 *
 * `useConpty: true` is explicit rather than left to node-pty's default: the
 * default falls back to the legacy winpty agent on builds of Windows that
 * predate ConPTY, and a host whose entire contract is "the pseudo console
 * outlives the shell" must not silently become a winpty host that does not.
 * A machine too old for ConPTY should fail here, visibly.
 *
 * `conptyInheritCursor` is deliberately **not** set. It is what makes ConPTY
 * ask the terminal where the cursor is before emitting anything — the query
 * `replay.ts`'s {@link QueryResponder} exists to answer. Leaving it off means
 * one fewer handshake that can deadlock when no UI is attached; the responder
 * stays because a CLI can ask the same question at any time, and because the
 * close path asks it too.
 */
export function openConsole(options: SpawnOptions): HostPty {
  return loadNodePty().spawn(options.program, options.args, {
    name: "xterm-256color",
    cols: Math.max(2, Math.trunc(options.cols)),
    rows: Math.max(2, Math.trunc(options.rows)),
    cwd: options.cwd,
    env: options.env,
    // Bytes, not decoded strings: a chunk that ends mid-character must survive
    // the trip to the replay buffer, which owns the boundary problem.
    encoding: null,
    useConpty: true,
  }) as HostPty;
}

/** How long a close waits for its proof before it becomes an error. */
export const CLOSE_TIMEOUT_MS = 5_000;

export type CloseProof =
  /** The console reported an exit. This is the proof. */
  | { readonly kind: "exited"; readonly exitCode: number | undefined }
  /** It had already exited before the close was asked for. */
  | { readonly kind: "alreadyExited"; readonly exitCode: number | undefined };

/**
 * A close that could not be proven.
 *
 * Thrown rather than swallowed on purpose: this is §4.3 of the status
 * document, the ConPTY release race. node-pty's Windows teardown deletes its
 * own baton before it closes the HPCON when the process tree was killed from
 * outside, and the conhost then leaks until this process exits. The host
 * cannot fix node-pty from here, but it can refuse to *report* a close it did
 * not observe — so an orphaned conhost shows up as a named error in a log
 * rather than as a machine that slowly fills with them.
 */
export class CloseTimeout extends Error {
  constructor(
    readonly sessionKey: string,
    readonly waitedMs: number,
  ) {
    super(
      `会话 ${sessionKey} 的伪控制台在 ${waitedMs}ms 内没有报告退出；HPCON 可能没有被释放`,
    );
    this.name = "CloseTimeout";
  }
}

export interface SessionSpec extends SpawnOptions {
  readonly sessionKey: string;
  readonly onData: (chunk: Buffer) => void;
  /** Fired exactly once, after the last output. */
  readonly onExit: (exitCode: number | undefined) => void;
}

/**
 * One live pseudo console and the process tree inside it.
 *
 * Four states, and the transitions between them are the whole of this class:
 *
 * ```text
 *   running ──(process ended by itself)──▶ exited
 *      │                                      │
 *      │ close()                              │ close()
 *      ▼                                      ▼
 *   closing ──(exit observed)──▶ closed   alreadyExited → closed
 *      └──(timeout)──▶ CloseTimeout, state stays "closing"
 * ```
 *
 * `closing` is not a synonym for `closed`: a session whose close timed out is
 * *not* known to have released its console, and calling `close` again is a
 * legitimate second attempt rather than a no-op.
 */
export class ConsoleSession {
  private readonly pty: HostPty;
  private state: "running" | "exited" | "closed" = "running";
  /**
   * A close has been asked for but not yet proven. Kept beside `state` rather
   * than inside it because the two answer different questions: `state` is
   * what the *console* is doing, `closingNow` is what this process is trying
   * to make it do. A close that timed out leaves a session in `running` and
   * `closingNow` at once, which is exactly the situation worth being able to
   * name.
   */
  private closingNow = false;
  private code: number | undefined;
  private pausedNow = false;
  private readonly exitWaiters: ((code: number | undefined) => void)[] = [];

  constructor(
    private readonly spec: SessionSpec,
    spawn: PtySpawner = openConsole,
    private readonly timeoutMs: number = CLOSE_TIMEOUT_MS,
  ) {
    this.pty = spawn(spec);
    this.pty.onData((data) => {
      spec.onData(typeof data === "string" ? Buffer.from(data, "utf8") : data);
    });
    this.pty.onExit((event) => this.noteExit(event.exitCode));
  }

  get pid(): number | undefined {
    const pid = this.pty.pid;
    return typeof pid === "number" && pid > 0 ? pid : undefined;
  }

  get exited(): boolean {
    return this.state !== "running";
  }

  get exitCode(): number | undefined {
    return this.code;
  }

  /** For the tests and for a log line: which of the four states this is in. */
  get phase(): "running" | "exited" | "closing" | "closed" {
    if (this.state === "closed") return "closed";
    if (this.closingNow) return "closing";
    return this.state;
  }

  get paused(): boolean {
    return this.pausedNow;
  }

  /** Whether this console may still be given work. */
  private get live(): boolean {
    return this.state === "running" && !this.closingNow;
  }

  write(bytes: Buffer): void {
    if (!this.live) return;
    // node-pty's `write` takes a string; `binary` is the one encoding that
    // round-trips arbitrary bytes through it without mangling anything above
    // 0x7f, which a paste of UTF-8 text very much contains.
    this.pty.write(bytes.toString("binary"));
  }

  resize(cols: number, rows: number): void {
    if (!this.live) return;
    try {
      this.pty.resize(
        Math.max(2, Math.trunc(cols)),
        Math.max(2, Math.trunc(rows)),
      );
    } catch {
      // A console that ended between the check and the call. The exit handler
      // is already on its way, and a throw here would take the request with it.
    }
  }

  /**
   * The flow gate. Stopping the reader lets ConPTY's own buffer fill, which
   * back-pressures the CLI — the same shape tmux has. The alternative,
   * buffering without bound in this process, turns one slow frontend into an
   * out-of-memory kill for every session on the machine.
   */
  setPaused(paused: boolean): void {
    if (this.pausedNow === paused || this.state !== "running") return;
    this.pausedNow = paused;
    if (paused) this.pty.pause();
    else this.pty.resume();
  }

  /**
   * Ends the process tree without closing the console, so the last output
   * still drains. Windows has no `SIGTERM`: a Ctrl+C has already been written
   * by the caller if it wanted to be polite, and this is the hard stop.
   */
  kill(): void {
    if (this.state !== "running") return;
    this.hardStop();
  }

  /**
   * The signal itself, with no state check.
   *
   * Separate from {@link kill} because {@link close} needs to signal a console
   * it has already marked as closing — a guard shared between the two would
   * make the close a silent no-op, which is the bug this separation exists to
   * prevent.
   */
  private hardStop(): void {
    // A paused stream does not drain, and node-pty will not run its own
    // teardown until the read side is flowing again — a paused pty that is
    // killed leaks both the handle and the reader. Resume first, always.
    this.setPaused(false);
    try {
      this.pty.kill();
    } catch {
      // Already gone.
    }
  }

  /**
   * Ends the session for good, and **proves** it.
   *
   * Killing a pty is easy; knowing that this particular pseudo console was
   * released is not, and assuming it is how a machine accumulates orphaned
   * conhosts until a reboot. So the close waits for node-pty's `exit` — which
   * node-pty raises from its own teardown, after the console is gone — and
   * rejects with {@link CloseTimeout} if it does not come.
   *
   * The caller decides what a refusal means. The host logs it, tells the
   * session's subscribers, and keeps the row so the failure is visible;
   * `destroy` still forgets the session, because a client that asked for it
   * must not be left holding a key that answers.
   */
  async close(): Promise<CloseProof> {
    if (this.state === "closed") {
      return { kind: "alreadyExited", exitCode: this.code };
    }
    if (this.state === "exited") {
      this.state = "closed";
      return { kind: "alreadyExited", exitCode: this.code };
    }
    // Armed before the kill: a console that exits synchronously inside
    // `kill()` must still be observed.
    const proof = this.awaitExit();
    this.closingNow = true;
    this.hardStop();
    const exitCode = await proof;
    this.state = "closed";
    return { kind: "exited", exitCode };
  }

  private awaitExit(): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      const settle = (code: number | undefined): void => {
        clearTimeout(timer);
        resolve(code);
      };
      const timer = setTimeout(() => {
        const index = this.exitWaiters.indexOf(settle);
        if (index !== -1) this.exitWaiters.splice(index, 1);
        // `closingNow` stays set and `state` stays `running`: this console is
        // not known to have been released, and a second `close` is a
        // legitimate second attempt rather than a no-op.
        reject(new CloseTimeout(this.spec.sessionKey, this.timeoutMs));
      }, this.timeoutMs);
      timer.unref?.();
      this.exitWaiters.push(settle);
    });
  }

  /** Idempotent: node-pty raises `exit` once, but a fake may not. */
  private noteExit(exitCode: number | undefined): void {
    if (this.state !== "running") return;
    this.state = "exited";
    this.code = exitCode;
    this.pausedNow = false;
    for (const waiter of this.exitWaiters.splice(0)) waiter(exitCode);
    // The session's own exit notification goes out whether or not somebody is
    // closing it: a client watching the session wants to know the CLI ended,
    // and `close` is about the console, not about the process.
    this.spec.onExit(exitCode);
  }
}
