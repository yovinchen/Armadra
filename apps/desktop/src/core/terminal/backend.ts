/**
 * The backend contract of contract §15.4, in TypeScript.
 *
 * Everything above this interface — the REST handlers, the socket, the
 * database rows, the reaper — is written once against every backend. Three
 * implement it today: `TmuxBackend`, `DirectBackend` and
 * `SessionHostBackend`; `ssh` (R2b) is the fourth and reuses the same shape.
 *
 * ## The twelve, and where each came from
 *
 * The design (`docs/design/typescript-core.md` §7, R2) names twelve:
 * `create`, `list`, `attach`, `detach`, `input`, `paste`, `resize`,
 * `capture`, `signal`, `terminate`, `getForeground`, `getCapabilities`. The
 * Rust trait (the pre-merge implementation) spells some of them
 * differently and splits two of them, so the correspondence is written down
 * here rather than left to be rediscovered:
 *
 * | this interface     | Rust `TerminalBackend`                        |
 * | ------------------ | --------------------------------------------- |
 * | `create`           | `create`                                      |
 * | `list`             | `list_alive`                                  |
 * | `attach`           | `attach`                                      |
 * | `detach`           | the `DetachGuard` an `attach` returns, plus `detach_all` |
 * | `input`            | `write`                                       |
 * | `paste`            | `paste`                                       |
 * | `resize`           | `resize`                                      |
 * | `capture`          | `capture`                                     |
 * | `signal`           | `interrupt` (one named signal, not a number)  |
 * | `terminate`        | `terminate_process` + `destroy`, by mode      |
 * | `getForeground`    | `foreground`                                  |
 * | `getCapabilities`  | `kind` + `BackendKind::persistent`            |
 *
 * `detach` is a method here rather than a guard because TypeScript has no
 * `Drop`: the socket handler owns the lifetime and says when it is over.
 *
 * Three more arrived with the rest of R2, and they map one to one as well:
 *
 * | this interface       | Rust `TerminalBackend`  | who calls it            |
 * | -------------------- | ----------------------- | ----------------------- |
 * | `scroll`             | `scroll`                | the wheel bridge (§18.5)|
 * | `destroyByReference` | `destroy_by_reference`  | the orphan sweep (§15.6)|
 * | `setDormant`         | `set_dormant`           | the dormancy budget     |
 * | `notices`            | the `BackendNotice` mpsc| the manager's exit loop |
 *
 * `adopt` is deliberately **not** on this interface — only a backend whose
 * sessions outlive the core has anything to adopt, and a default here would
 * invite `DirectBackend` to pretend it does. It lives on
 * {@link AdoptableBackend} instead, exactly as the Rust `Adoptable` trait does.
 *
 * Nothing in here touches the database or the event bus. A backend knows
 * about processes and bytes; the manager knows about rows.
 */

/* --------------------------------- identity ------------------------------- */

/**
 * The stable logical identity of a terminal, independent of whichever process
 * is behind it right now: the owning node id, or the session id for a
 * node-less terminal.
 */
export type SessionKey = string & { readonly __sessionKey?: unique symbol };

export function sessionKey(value: string): SessionKey {
  return value as SessionKey;
}

/** `terminal_sessions.backend_kind`. The strings are contractual. */
export type BackendKind = "direct" | "tmux" | "sessionHost";

/**
 * Parsing an unknown value as `direct` would claim a session this build cannot
 * reach is reachable, so unknown rows stay unknown.
 */
export function parseBackendKind(value: string): BackendKind | undefined {
  return value === "direct" || value === "tmux" || value === "sessionHost"
    ? value
    : undefined;
}

/** Whether sessions of this backend survive the core process. */
export function persistent(kind: BackendKind): boolean {
  return kind === "tmux" || kind === "sessionHost";
}

/* ----------------------------------- types -------------------------------- */

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Everything a backend needs to start a session. `generation` is chosen by the
 * manager (create = 1, recycle = previous + 1) and becomes part of the tmux
 * session name, so a recycled session can never collide with its predecessor.
 */
export interface TerminalSpec {
  readonly sessionKey: SessionKey;
  readonly workspaceId: string;
  readonly generation: number;
  readonly cwd: string;
  readonly shell: string;
  readonly command?: string | undefined;
  readonly args: readonly string[];
  /**
   * `ARMADRA_*` hook variables and anything else the caller injects. Addresses
   * only — never credentials; any process of the same user can read them.
   */
  readonly env: readonly (readonly [string, string])[];
  readonly size: TerminalSize;
  /**
   * `settings.ssh.hosts[].id`, when this session is to run `ssh …` rather than
   * a local shell.
   *
   * Declared here, and optional, so that one spec type travels through every
   * backend: only the decorator in `ssh/backend.ts` reads it, and the other
   * three pass it through without knowing what it means. Declaring it only on
   * `SshTerminalSpec` would make the manager — which has no business knowing
   * what an SSH host is — need two spec types and a branch to choose between
   * them.
   */
  readonly sshHostId?: string | undefined;
}

/** The program the session runs: an explicit command, else the shell. */
export function executable(spec: TerminalSpec): string {
  return spec.command ?? spec.shell;
}

export interface TerminalHandle {
  readonly sessionKey: SessionKey;
  readonly generation: number;
  /** tmux session name; `undefined` for a backend with no external handle. */
  readonly backendRef?: string | undefined;
  readonly pid?: number | undefined;
}

/**
 * One socket's view of a session. Several may exist at once for the same key,
 * which is why the id is handed back: `detach` takes it.
 */
export interface Attachment {
  readonly attachmentId: number;
  readonly generation: number;
  /** Raw PTY bytes. Never decoded here — see `Utf8Decoder` at the socket. */
  onData(listener: (chunk: Buffer) => void): void;
  /** The session ended by itself. Not called for a detach. */
  onExit(listener: (exitCode: number | undefined) => void): void;
}

/** One live backend session as the backend itself sees it. */
export interface BackendRef {
  /** tmux session name, or the session key for a backend with no server. */
  readonly name: string;
  readonly attached: boolean;
}

export interface ForegroundInfo {
  readonly pid?: number | undefined;
  readonly command?: string | undefined;
  /** argv of the processes below the shell, innermost last. */
  readonly children: readonly string[];
}

/**
 * Three levels, the same three the `terminate` frame carries (contract §15.5):
 * interrupt the foreground process, end the session's process tree, or destroy
 * the persistent session behind the key.
 */
export type TerminateMode = "interrupt" | "process" | "session";

export interface BackendCapabilities {
  readonly kind: BackendKind;
  /** Sessions outlive this process. */
  readonly persistent: boolean;
  /** The backend redraws by itself, so no `snapshot` frame is owed. */
  readonly redrawsOnAttach: boolean;
  /** Version banner of whatever is behind it, when there is one. */
  readonly version?: string | undefined;
  /** Why it cannot be used; absent when it can. */
  readonly reason?: string | undefined;
  readonly usable: boolean;
}

/**
 * Sessions end without anybody asking: the shell exits, the user types
 * `exit`, the machine kills the process. Backends report that through
 * {@link TerminalBackend.notices} and the manager turns it into a database
 * row, a `status` frame and a `terminal.exit` workspace event.
 *
 * A notice is not addressed to a socket. A session nobody is watching still
 * has to stop claiming to be running, which is the whole reason this channel
 * exists beside {@link Attachment.onExit}.
 */
export type BackendNotice = {
  readonly type: "exited";
  readonly key: SessionKey;
  readonly generation: number;
  readonly exitCode?: number | undefined;
};

/* --------------------------------- errors --------------------------------- */

/**
 * Backend failures carry the HTTP status the API face owes them, because the
 * distinction matters: a stale generation is a 409 the client recovers from by
 * reconnecting, and an exited session is a 404, and neither is a 500.
 */
export class TerminalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

export const notFound = (message: string): TerminalError =>
  new TerminalError(404, "not_found", message);

export const conflict = (message: string): TerminalError =>
  new TerminalError(409, "conflict", message);

export const internal = (message: string): TerminalError =>
  new TerminalError(500, "internal", message);

/**
 * What a backend method that this build cannot answer throws.
 *
 * It is a 501 with the feature named, the same answer the route table gives
 * for a path nobody has written: the front end already knows how to degrade on
 * that shape, and a backend that silently did nothing would look like a
 * terminal that ignores you. Nothing in the three backends here raises it any
 * more; the remote backend of R2b is the next user.
 */
export class NotImplemented extends TerminalError {
  constructor(what: string, phase = "R2b") {
    super(501, "not_implemented", `${what}（${phase}）`);
    this.name = "NotImplemented";
  }
}

/* -------------------------------- the contract ----------------------------- */

export interface TerminalBackend {
  readonly kind: BackendKind;

  create(spec: TerminalSpec): Promise<TerminalHandle>;

  list(): Promise<BackendRef[]>;

  /**
   * Output stream plus the right to write. `generation` is the caller's view
   * of the session; attaching with a stale one is a 409, never a silent
   * attach to whatever is there now.
   */
  attach(
    key: SessionKey,
    generation: number,
    size: TerminalSize,
  ): Promise<Attachment>;

  /** Ends one attachment. The session keeps running — this is not a kill. */
  detach(key: SessionKey, attachmentId: number): Promise<void>;

  input(key: SessionKey, bytes: Buffer): Promise<void>;

  /** Bracketed paste, so a CLI that understands it treats the text as data. */
  paste(key: SessionKey, text: string, pressEnter: boolean): Promise<void>;

  resize(key: SessionKey, size: TerminalSize): Promise<void>;

  /** Plain text for agents to read, escape-carrying text for a snapshot. */
  capture(
    key: SessionKey,
    lines: number,
    withEscapes: boolean,
  ): Promise<string>;

  /** Currently only `interrupt` — Ctrl+C to the foreground process group. */
  signal(key: SessionKey, signal: "interrupt"): Promise<void>;

  terminate(key: SessionKey, mode: TerminateMode): Promise<void>;

  getForeground(key: SessionKey): Promise<ForegroundInfo>;

  getCapabilities(): BackendCapabilities;

  /**
   * The wheel bridge of contract §18.5. Positive `lines` scrolls towards older
   * output. Only tmux has history the browser cannot see; the other backends
   * hand their scrollback to xterm and do nothing here.
   */
  scroll(key: SessionKey, lines: number): Promise<void>;

  /**
   * Destroy a session by the backend's own handle rather than by key — the
   * orphan case, where no database row points at it any more (contract §15.6).
   */
  destroyByReference(reference: string): Promise<void>;

  /**
   * Nothing has been attached to this session for a while, or something just
   * attached again.
   *
   * Dormancy is about **resources, not execution**: the process keeps running,
   * the screen or replay buffer the next attach needs is kept, and waking is
   * never a create. What a backend may release is everything downstream of
   * that — per-frame delivery and the wakeups it costs.
   */
  setDormant(key: SessionKey, dormant: boolean): Promise<void>;

  /** Subscribe to unsolicited session news. Several listeners are allowed. */
  notices(listener: (notice: BackendNotice) => void): void;

  /**
   * The replay this backend keeps, as one string, for a backend that has no
   * screen to redraw. Absent when there is nothing to replay — which is also
   * the honest answer for tmux, whose client repaints the real pane.
   *
   * Optional rather than returning `undefined` everywhere: a backend that owns
   * no buffer should not have to say so in code, and `redrawsOnAttach` already
   * tells the socket layer whether to ask.
   */
  snapshot?(key: SessionKey): string | undefined;

  /** Release process-local resources without ending persistent sessions. */
  detachAll(): Promise<void>;
}

/**
 * A backend that can take a session it finds at start-up back under
 * management, and say what pid is behind it.
 *
 * Separate from {@link TerminalBackend} on purpose: `DirectBackend` has
 * nothing to adopt — its sessions died with whoever wrote the row — and a
 * default implementation would let it claim otherwise.
 */
export interface AdoptableBackend extends TerminalBackend {
  adopt(
    key: SessionKey,
    reference: string,
    generation: number,
  ): Promise<number | undefined>;
}

export function isAdoptable(
  backend: TerminalBackend,
): backend is AdoptableBackend {
  return typeof (backend as AdoptableBackend).adopt === "function";
}

/* ------------------------------- shared helpers ---------------------------- */

/**
 * Bracketed paste wrapper. A CLI with bracketed paste enabled sees the text as
 * one paste event instead of as keystrokes, so a multi-line prompt does not
 * submit itself line by line.
 */
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/**
 * How many output batches a backend with no real screen keeps for `capture`
 * and for the `snapshot` frame. The same 128 the Rust `REPLAY_CHUNKS` keeps:
 * enough to redraw a full-screen TUI, small enough that thirty idle terminals
 * are not a memory plan.
 */
export const REPLAY_CHUNKS = 128;

/**
 * The delivery cadence of an attached session, and of one nothing is watching.
 *
 * 16 ms is a display frame (contract §18.3, 输出吞吐). Half a second is what a
 * dormant session falls back to: every byte is still kept — the process is
 * running and its screen is what the next attach replays — but nobody is
 * waiting for those bytes at display latency.
 */
export const OUTPUT_FLUSH_INTERVAL_MS = 16;
export const DORMANT_FLUSH_INTERVAL_MS = 500;
export const OUTPUT_FLUSH_BYTES = 64 * 1024;

/**
 * Pasted text must not be able to close the bracket itself or inject its own
 * escape sequences into the CLI's parser.
 */
export function sanitizePaste(text: string): string {
  let output = "";
  for (const character of text) {
    if (character === "\n" || character === "\t" || character === "\r") {
      output += character;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    // The Rust side filters `char::is_control`, which is C0 plus C1.
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control) output += character;
  }
  return output;
}

/**
 * tmux session name component: `[A-Za-z0-9-]` only (tmux itself rejects `.`
 * and `:`), truncated to `width` characters, never empty.
 */
export function nameComponent(value: string, width: number): string {
  const cleaned = [...value]
    .filter((character) => /[A-Za-z0-9-]/.test(character))
    .slice(0, width)
    .join("");
  return cleaned === "" ? "x".repeat(Math.min(width, 2)) : cleaned;
}

/**
 * Same sanitising, but from the end of the value.
 *
 * The session key is a UUIDv7, whose leading hex digits are a millisecond
 * timestamp: every node created inside the same ~65 second window shares its
 * first eight characters. Taking them from the front would give two terminals
 * of one workspace the same tmux session name, and the second `new-session`
 * would take over the first one's pane. The tail is the random half.
 */
export function tailComponent(value: string, width: number): string {
  const cleaned = [...value].filter((character) =>
    /[A-Za-z0-9-]/.test(character),
  );
  if (cleaned.length === 0) return "x".repeat(Math.min(width, 2));
  return cleaned.slice(Math.max(0, cleaned.length - width)).join("");
}

/** Every session name the core owns starts with this. */
export const SESSION_PREFIX = "armadra-";

/**
 * `armadra-<workspace 8>-<key 8>-<generation>` (contract §15.2). The workspace
 * part is a label; the key part is what has to be unique.
 */
export function sessionName(
  workspaceId: string,
  key: SessionKey,
  generation: number,
): string {
  return `${SESSION_PREFIX}${nameComponent(workspaceId, 8)}-${tailComponent(key, 8)}-${generation}`;
}

/**
 * Strips ANSI/OSC escape sequences so a captured screen can be handed to an
 * agent as plain text. A direct port of the Rust state machine, including its
 * treatment of BEL as a terminator and as a character to drop.
 */
export function stripEscapes(text: string): string {
  let output = "";
  const characters = [...text];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index] as string;
    index += 1;
    if (character !== "\u001b") {
      if (character !== "\u0007") output += character;
      continue;
    }
    const next = characters[index];
    index += 1;
    if (next === "[") {
      // CSI: parameters then a final byte in @..~.
      while (index < characters.length) {
        const code = (characters[index] as string).codePointAt(0) ?? 0;
        index += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      continue;
    }
    if (next === "]" || next === "P" || next === "_" || next === "^") {
      // OSC / DCS / APC / PM: run to BEL or ST.
      while (index < characters.length) {
        const current = characters[index] as string;
        index += 1;
        if (current === "\u0007") break;
        if (current === "\u001b" && characters[index] === "\\") {
          index += 1;
          break;
        }
      }
      continue;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+") {
      index += 1;
    }
  }
  return output;
}

/** Trailing blank lines are the unused rows of the pane, not content. */
export function trimCaptured(text: string): string {
  const lines = text.split("\n");
  while (
    lines.length > 0 &&
    (lines[lines.length - 1] as string).replace(/[\r \t]+$/, "") === ""
  ) {
    lines.pop();
  }
  return lines.join("\n");
}

/** Keeps at most the last `lines` lines; `0` means "everything". */
export function tailLines(text: string, lines: number): string {
  if (lines === 0) return text;
  const collected = text.split("\n");
  return collected.slice(Math.max(0, collected.length - lines)).join("\n");
}

/**
 * Chunk-by-chunk UTF-8 decoding.
 *
 * A PTY read can end in the middle of a multi-byte character, and decoding
 * each chunk on its own would turn that into a permanent replacement
 * character on screen — the Rust `Utf8Decoder` exists for the same reason.
 * `node:string_decoder` implements exactly this, so the class is a named seam
 * rather than a reimplementation.
 */
export { StringDecoder as Utf8Decoder } from "node:string_decoder";
