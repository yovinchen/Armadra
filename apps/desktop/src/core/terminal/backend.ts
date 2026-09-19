/**
 * The backend contract of contract §15.4, in TypeScript.
 *
 * Everything above this interface — the REST handlers, the socket, the
 * database rows, the reaper — is written once against every backend. R2's
 * remaining backends (`direct`, `sessionHost`, `ssh`) implement the same
 * twelve methods; this batch ships only {@link TmuxBackend}.
 *
 * ## The twelve, and where each came from
 *
 * The design (`docs/design/typescript-core.md` §7, R2) names twelve:
 * `create`, `list`, `attach`, `detach`, `input`, `paste`, `resize`,
 * `capture`, `signal`, `terminate`, `getForeground`, `getCapabilities`. The
 * Rust trait (`apps/runtime/src/terminal/backend.rs`) spells some of them
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
 * `Drop`: the socket handler owns the lifetime and says when it is over. The
 * Rust members with no entry above — `scroll`, `destroy_by_reference`,
 * `set_dormant` — belong to the rest of R2 (the wheel bridge, the GC, the
 * dormancy budget) and are added to this interface by whoever writes them.
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
 * What every method this batch does not implement throws.
 *
 * It is a 501 with the feature named, the same answer the route table gives
 * for a path nobody has written: the front end already knows how to degrade on
 * that shape, and a backend that silently did nothing would look like a
 * terminal that ignores you.
 */
export class NotImplemented extends TerminalError {
  constructor(what: string) {
    super(501, "not_implemented", `${what}（R2 余下部分）`);
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

  /** Release process-local resources without ending persistent sessions. */
  detachAll(): Promise<void>;
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
