import { createHash } from "node:crypto";

/**
 * The named-pipe wire format of the Windows session host, in TypeScript.
 *
 * The host itself was the Rust session-host binary before R6 rewrote it in
 * TypeScript — so this file was a second speaker on an existing wire, not a
 * new protocol. Every constant, every field name and every derivation below
 * is pinned to that pre-merge implementation, and the tests beside it use its
 * unit tests' own vectors so a drift is a failure here rather than a Windows
 * machine that cannot open a terminal.
 *
 * ## The frame
 *
 * One connection carries two kinds of traffic: control messages, which are
 * JSON because they are rare and want to be readable in a log, and terminal
 * output, which is raw bytes because a 60 fps TUI redraw does not deserve a
 * base64 round trip. A fixed 24-byte header in front of both is what lets a
 * reader tell them apart without guessing.
 *
 * ```text
 * offset  size  meaning
 * 0       1     magic 0xA1
 * 1       1     kind: 1 json, 2 output, 3 snapshot, 4 snapshot-end
 * 2       2     reserved, must be zero
 * 4       8     generation (little endian)
 * 12      8     sequence   (little endian, per session, from 1)
 * 20      4     payload length (little endian)
 * 24      N     payload
 * ```
 *
 * `sequence` is not decoration. A client that sees a gap knows the host
 * dropped output under back pressure and must re-attach for a fresh replay
 * instead of writing bytes that no longer join up into xterm. `generation` is
 * the same fence used everywhere else: a frame from a superseded session is
 * dropped, never rendered.
 *
 * Everything in this file is a pure function over bytes or JSON. That is
 * deliberate and is the whole Windows testing strategy: no machine here can
 * open a named pipe, so the codec, the pipe-name derivation, the welcome check
 * and the gap detector are tested exactly, and only the socket itself is left
 * as `TODO(R6)`.
 */

/* ---------------------------------- frames -------------------------------- */

/** First byte of every frame. Anything else is not this protocol. */
export const MAGIC = 0xa1;
export const HEADER_LEN = 24;
/** The largest payload a single frame may carry. */
export const MAX_PAYLOAD = 1024 * 1024;
/** How long a connection has to complete its handshake. */
export const HANDSHAKE_TIMEOUT_MS = 2_000;
/** How long a request may wait before the caller is told the host is gone. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** How long to keep trying after starting the host. */
export const START_TIMEOUT_MS = 5_000;
/** The protocol major both sides must agree on. */
export const PROTOCOL_MAJOR = 1;
export type FrameKind = "json" | "output" | "snapshot" | "snapshotEnd";

const KIND_BYTES: Record<FrameKind, number> = {
  json: 1,
  output: 2,
  snapshot: 3,
  snapshotEnd: 4,
};

export function kindFromByte(value: number): FrameKind | undefined {
  switch (value) {
    case 1:
      return "json";
    case 2:
      return "output";
    case 3:
      return "snapshot";
    case 4:
      return "snapshotEnd";
    default:
      return undefined;
  }
}

export interface Frame {
  readonly kind: FrameKind;
  readonly generation: number;
  readonly sequence: number;
  readonly payload: Buffer;
}

/**
 * A stream that is not this protocol, or a header this build must not guess
 * at. Unrecoverable in every case: there is no framing left to resynchronise
 * to, so the connection is closed rather than repaired.
 */
export class FrameError extends Error {
  constructor(
    readonly code: "badMagic" | "badKind" | "reserved" | "tooLarge",
    message: string,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

export function encodeFrame(frame: {
  kind: FrameKind;
  generation?: number;
  sequence?: number;
  payload: Buffer;
}): Buffer {
  if (frame.payload.byteLength > MAX_PAYLOAD) {
    throw new FrameError(
      "tooLarge",
      `frame payload of ${frame.payload.byteLength} exceeds ${MAX_PAYLOAD}`,
    );
  }
  const header = Buffer.alloc(HEADER_LEN);
  header[0] = MAGIC;
  header[1] = KIND_BYTES[frame.kind];
  // Bytes 2 and 3 stay zero: they are reserved, and a future version may use
  // them. Writing anything there now would make this build unreadable then.
  header.writeBigUInt64LE(BigInt(frame.generation ?? 0), 4);
  header.writeBigUInt64LE(BigInt(frame.sequence ?? 0), 12);
  header.writeUInt32LE(frame.payload.byteLength, 20);
  return Buffer.concat([header, frame.payload]);
}

/** A control frame. Generation and sequence are zero: replies match by `id`. */
export function jsonFrame(message: unknown): Buffer {
  return encodeFrame({
    kind: "json",
    payload: Buffer.from(JSON.stringify(message), "utf8"),
  });
}

/**
 * Reassembles frames from a byte stream.
 *
 * A named pipe in byte mode splits and merges writes wherever it likes, so
 * every read has to be treated as "some bytes", never as "a message".
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer =
      this.buffer.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk]);
  }

  get buffered(): number {
    return this.buffer.byteLength;
  }

  /** The next complete frame, or `undefined` when more bytes are needed. */
  next(): Frame | undefined {
    if (this.buffer.byteLength < HEADER_LEN) return undefined;
    if (this.buffer[0] !== MAGIC) {
      throw new FrameError(
        "badMagic",
        `frame magic 0x${(this.buffer[0] as number).toString(16).padStart(2, "0")} is not 0xa1`,
      );
    }
    const kind = kindFromByte(this.buffer[1] as number);
    if (kind === undefined) {
      throw new FrameError("badKind", `unknown frame kind ${this.buffer[1]}`);
    }
    if (this.buffer[2] !== 0 || this.buffer[3] !== 0) {
      throw new FrameError("reserved", "reserved frame bytes are not zero");
    }
    const generation = Number(this.buffer.readBigUInt64LE(4));
    const sequence = Number(this.buffer.readBigUInt64LE(12));
    const length = this.buffer.readUInt32LE(20);
    // Checked before the length is used for anything, so a hostile header
    // cannot make this process reserve a gigabyte.
    if (length > MAX_PAYLOAD) {
      throw new FrameError(
        "tooLarge",
        `frame payload of ${length} exceeds ${MAX_PAYLOAD}`,
      );
    }
    if (this.buffer.byteLength < HEADER_LEN + length) return undefined;
    const payload = this.buffer.subarray(HEADER_LEN, HEADER_LEN + length);
    const frame: Frame = {
      kind,
      generation,
      sequence,
      payload: Buffer.from(payload),
    };
    this.buffer = Buffer.from(this.buffer.subarray(HEADER_LEN + length));
    return frame;
  }
}

/* --------------------------------- messages -------------------------------- */

export interface HostSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * A console with zero rows or columns is not a smaller console, it is an
 * invalid one, and ConPTY rejects it.
 */
export function clampSize(size: HostSize): HostSize {
  const clamp = (value: number): number =>
    Math.min(1000, Math.max(2, Math.trunc(value) || 2));
  return { cols: clamp(size.cols), rows: clamp(size.rows) };
}

export interface CreateSpec {
  readonly sessionKey: string;
  readonly generation: number;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly command?: string | null;
  readonly args: readonly string[];
  /**
   * Addresses and identity only. The core never puts a credential here; any
   * process of this user can read another process' environment.
   */
  readonly env: readonly (readonly [string, string])[];
  readonly size: HostSize;
}

export interface SessionSummary {
  readonly sessionKey: string;
  readonly generation: number;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly size: HostSize;
  readonly pid: number | null;
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly subscribers: number;
}

export type HostErrorCode =
  | "unauthorized"
  | "unsupportedProtocol"
  | "notFound"
  | "stale"
  | "conflict"
  | "badRequest"
  | "internal"
  | "draining";

/**
 * The one-time proof a `hello` carries.
 *
 * Structural rather than imported from `auth.ts` so the dependency runs one
 * way only — `auth.ts` needs {@link PROTOCOL_MAJOR} from here, and a cycle
 * between two modules a CJS bundle loads at startup is the kind of thing that
 * works until the bundler reorders it.
 *
 * Optional on the wire: the pre-merge Rust host ignored unknown fields and
 * had no notion of this proof, so a build talking to it sent the field and
 * was not refused for it. The TypeScript host of `src/session-host/`
 * **requires** it. That asymmetry is what let the two hosts share one
 * protocol major through R6.
 */
export interface HelloAuth {
  readonly nonce: string;
  readonly issuedAt: number;
  readonly proof: string;
}

export type ClientMessage =
  | { type: "hello"; protocol: number; client: string; auth?: HelloAuth }
  | ({ type: "create"; id: number } & CreateSpec)
  | {
      type: "attach";
      id: number;
      sessionKey: string;
      generation: number;
      size: HostSize;
    }
  | { type: "detach"; id: number; sessionKey: string }
  | { type: "write"; id: number; sessionKey: string; data: string }
  | ({ type: "resize"; id: number; sessionKey: string } & HostSize)
  | { type: "list"; id: number }
  | { type: "interrupt"; id: number; sessionKey: string }
  | { type: "kill"; id: number; sessionKey: string }
  | { type: "destroy"; id: number; sessionKey: string }
  | { type: "flow"; id: number; sessionKey: string; paused: boolean };

export type HostMessage =
  | {
      type: "welcome";
      protocol: number;
      host: string;
      pid: number;
      instanceId: string;
      sessions: SessionSummary[];
    }
  | {
      type: "ok";
      id: number;
      session?: SessionSummary;
      sessions?: SessionSummary[];
    }
  | { type: "error"; id: number; code: HostErrorCode; message: string }
  | {
      type: "exit";
      sessionKey: string;
      generation: number;
      exitCode: number | null;
    }
  | {
      type: "stale";
      sessionKey: string;
      generation: number;
      current: number;
    }
  | { type: "warning"; sessionKey: string; message: string }
  | { type: "bye"; reason: string; drain: boolean };

/**
 * `create` and `resize` flatten their payload into the message (serde's
 * `#[serde(flatten)]`), which is invisible in the TypeScript union above, so
 * the builders live here rather than at every call site.
 */
export function createMessage(id: number, spec: CreateSpec): ClientMessage {
  return {
    type: "create",
    id,
    ...spec,
    command: spec.command ?? null,
    args: [...spec.args],
    env: spec.env.map(([name, value]) => [name, value] as const),
    size: clampSize(spec.size),
  };
}

export function resizeMessage(
  id: number,
  sessionKey: string,
  size: HostSize,
): ClientMessage {
  const clamped = clampSize(size);
  return { type: "resize", id, sessionKey, ...clamped };
}

/** Hands out request ids. Monotonic within a connection, and never zero. */
export class RequestIds {
  private value = 0;

  /** Named `issue` rather than `next` so it is never mistaken for an iterator. */
  issue(): number {
    this.value += 1;
    return this.value;
  }
}

export interface Greeting {
  readonly hostVersion: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly sessions: readonly SessionSummary[];
}

/**
 * Checks a `welcome` before anything is built on it.
 *
 * A host answering a major this client does not speak is not a host this
 * client may use: the frame layout is the same, so the mistake would surface
 * much later as nonsense rather than immediately as a refusal.
 */
export function acceptWelcome(
  message: HostMessage,
  expectedMajor: number = PROTOCOL_MAJOR,
): Greeting {
  if (message.type === "error") {
    throw new Error(
      `session host refused the handshake: ${message.code} ${message.message}`,
    );
  }
  if (message.type !== "welcome") {
    throw new Error(`expected welcome, got ${message.type}`);
  }
  if (message.protocol !== expectedMajor) {
    throw new Error(
      `session host speaks protocol ${message.protocol}, this core speaks ${expectedMajor}`,
    );
  }
  return {
    hostVersion: message.host,
    pid: message.pid,
    instanceId: message.instanceId,
    sessions: message.sessions,
  };
}

/* --------------------------------- delivery -------------------------------- */

/** What an attached client should do with an output frame. */
export type Delivery =
  | { readonly kind: "write" }
  /**
   * It belongs to a generation this attachment is not showing, or it is a
   * repeat. Dropping it is the fence: bytes from the CLI you recycled away
   * from must never be painted into the one that replaced it.
   */
  | { readonly kind: "wrong" }
  /**
   * Frames were lost. The screen cannot be made correct by writing this, so
   * the attachment has to be redone.
   */
  | { readonly kind: "gap"; readonly missing: number };

/** Follows one attachment's output stream. */
export class OutputTracker {
  /** Sequence numbers start at 1, so zero means "nothing yet". */
  private last = 0;

  constructor(private readonly generation: number) {}

  observe(generation: number, sequence: number): Delivery {
    if (generation !== this.generation) return { kind: "wrong" };
    // The first frame may be any sequence: the session was running before this
    // attachment existed, and the host does not restart its counter for a new
    // subscriber.
    if (this.last === 0) {
      this.last = sequence;
      return { kind: "write" };
    }
    if (sequence === this.last + 1) {
      this.last = sequence;
      return { kind: "write" };
    }
    if (sequence <= this.last) return { kind: "wrong" };
    const missing = sequence - this.last - 1;
    this.last = sequence;
    return { kind: "gap", missing };
  }
}

/* -------------------------------- discovery -------------------------------- */

/**
 * Windows named pipes live in a flat namespace, so the name has to carry
 * everything that distinguishes one host from another.
 */
export const PIPE_PREFIX = "\\\\.\\pipe\\armadra-session-";
/** Bytes of the digest that end up in the name. */
const DIGEST_HEX_LEN = 16;

/**
 * `\\.\pipe\armadra-session-<sid>-<hash>-v<major>`.
 *
 * Derived, never configured: both sides compute it from the same three things
 * and therefore always agree without a discovery file that could be stale,
 * replaced or pointed somewhere else. Two users never share a pipe, two
 * installations never share a pipe, and a host speaking an older major keeps
 * its own name while it drains.
 *
 * The SID stays readable in the name: when something goes wrong, "which
 * user's host is this" should be answerable by looking, not by recomputing a
 * hash.
 */
export function pipeEndpoint(
  sid: string,
  dataDir: string,
  major: number = PROTOCOL_MAJOR,
): string {
  return `${PIPE_PREFIX}${sanitizeComponent(sid)}-${pipeDigest(sid, dataDir)}-v${major}`;
}

/** The per-user mutex name that stops two cores from starting two hosts. */
export function startupMutex(
  sid: string,
  dataDir: string,
  major: number = PROTOCOL_MAJOR,
): string {
  return `armadra-session-host-${pipeDigest(sid, dataDir)}-v${major}`;
}

/**
 * Everything outside `[A-Za-z0-9-]` becomes `-`: the Windows pipe namespace
 * accepts most characters, but a name built out of unvalidated input is a name
 * somebody else can aim.
 */
export function sanitizeComponent(value: string): string {
  const cleaned = [...value]
    .map((character) => (/[A-Za-z0-9-]/.test(character) ? character : "-"))
    .join("");
  return cleaned === "" ? "unknown" : cleaned;
}

/**
 * Length-prefixed, so `("ab", "c")` and `("a", "bc")` cannot hash the same:
 * two different installations must never land on one pipe.
 */
export function pipeDigest(sid: string, dataDir: string): string {
  const hash = createHash("sha256");
  for (const part of [sid, dataDir]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, DIGEST_HEX_LEN);
}

/**
 * `backend_ref` for a host session: key plus generation, so a recycle is a
 * different reference and an orphan sweep cannot confuse the two.
 */
export function hostReference(sessionKey: string, generation: number): string {
  return `${sessionKey}#${generation}`;
}

/** The key half of a {@link hostReference}. */
export function keyOfReference(reference: string): string {
  const cut = reference.indexOf("#");
  return cut === -1 ? reference : reference.slice(0, cut);
}
