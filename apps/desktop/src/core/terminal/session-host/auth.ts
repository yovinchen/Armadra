import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { PROTOCOL_MAJOR } from "./protocol";

/**
 * Who is allowed to talk to the session host, now that both ends are
 * TypeScript.
 *
 * ## What this replaces, and why it had to be replaced
 *
 * The Rust host closed this question with two Win32 facts. The pipe was
 * created with a **protected DACL** (`O:<sid>G:<sid>D:P(A;;GA;;;SY)(A;;GA;;;<sid>)`)
 * so the object itself admitted only this user and LocalSystem; and every
 * accepted connection was checked with `GetNamedPipeClientProcessId` plus the
 * client process' SID, so being connected still had to be earned.
 *
 * `node:net` reaches neither. It creates a named pipe through libuv with a
 * default security descriptor and hands back a `Socket`, not a `HANDLE`;
 * there is no Node API for a pipe's security descriptor and none for the
 * peer's identity. Adding a native module to get them back is exactly the
 * dependency R6 exists to remove.
 *
 * So the check moves from the object to the conversation: a **one-time HMAC
 * proof** derived from a key file that only this user can read. The file is
 * the secret the DACL used to be; the proof is the per-connection check the
 * SID comparison used to be.
 *
 *   * `<userDataDir>/session-host.key` — 32 random bytes, hex, written with
 *     mode `0600` and, on Windows, an ACL reset to this user alone with
 *     `icacls`. **A failure to tighten it refuses to start**: a key file every
 *     account on the machine can read is not a key file, and a host that
 *     served anyway would be worse than one that does not exist.
 *   * Every connection's `hello` carries `{ nonce, issuedAt, proof }`, where
 *     `proof = HMAC-SHA256(key, context ‖ major ‖ endpoint ‖ nonce ‖ issuedAt)`.
 *     The endpoint is in the message so a proof minted for one host cannot be
 *     presented to another; `issuedAt` bounds it in time; the nonce makes it
 *     single-use within that bound.
 *
 * ## Residual risk, stated rather than hidden
 *
 * 1. **The window.** A proof is replayable for {@link SKEW_MS} by anything
 *    that can observe the bytes. Observing them means already holding an
 *    authorised connection or debugging the process, both of which are
 *    already this user.
 * 2. **No peer identity.** The host learns that its peer can read the key
 *    file, not which process it is. Under the Rust host a process of this
 *    user that had never seen the key was still refused if its SID differed;
 *    here every process of this user is equivalent. Against the actual threat
 *    — *another account* on a shared machine — the two are the same, because
 *    the file's ACL is the same ACL the pipe used to carry.
 * 3. **`icacls` is the tightening.** There is no in-process Win32 call here;
 *    if `icacls` is missing or refuses, the host refuses too.
 *
 * Pure functions over bytes, so the whole of it is testable on a machine that
 * has no named pipes.
 */

/** The file under the data directory that holds the shared key. */
export const KEY_FILE = "session-host.key";

/** Domain separation: this key signs nothing else, ever. */
export const AUTH_CONTEXT = "armadra-session-host/auth";

/** How far from the host's clock a proof may be minted and still be used. */
export const SKEW_MS = 60_000;

/** Bytes of key material. Thirty-two is a full SHA-256 block's worth. */
const KEY_BYTES = 32;

export interface HelloAuth {
  /** Hex, {@link KEY_BYTES} / 2 bytes. Single use within the skew window. */
  readonly nonce: string;
  /** Unix milliseconds, as the client's clock read them. */
  readonly issuedAt: number;
  /** Hex HMAC-SHA256. */
  readonly proof: string;
}

export function keyPath(dataDir: string): string {
  return join(dataDir, KEY_FILE);
}

/**
 * Reads the key, or throws saying which file is missing.
 *
 * Deliberately not "create it if absent": a client that mints a key has
 * created a second secret rather than found the shared one, and would then
 * fail the handshake with a confusing mismatch instead of a clear "the host
 * has not been started".
 */
export function readKey(dataDir: string): Buffer {
  const path = keyPath(dataDir);
  const text = readFileSync(path, "utf8").trim();
  const key = Buffer.from(text, "hex");
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(
      `${path} is not a ${KEY_BYTES}-byte hex key (${key.byteLength} bytes decoded)`,
    );
  }
  return key;
}

/**
 * The key, created on first use.
 *
 * Written through a temporary file and renamed, so a reader never sees a
 * half-written key; created with `0600` before anything is in it, so the
 * bytes are never briefly world-readable.
 */
export function ensureKey(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true });
  try {
    return readKey(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A key that is present but unreadable or malformed is a state a person
      // has to look at: silently replacing it would strand every running
      // session behind a secret nobody holds any more.
      throw error;
    }
  }
  const key = randomBytes(KEY_BYTES);
  const path = keyPath(dataDir);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${key.toString("hex")}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  protectKeyFile(path);
  return key;
}

/**
 * Narrows the key file to this user, and throws if it cannot.
 *
 * POSIX needs only the `chmod` the write already applied; it is repeated
 * because a file inherited from an earlier build may be wider. Windows needs
 * `icacls`: `/inheritance:r` drops the ACEs the parent directory contributed
 * — which on a default profile include Administrators and SYSTEM — and
 * `/grant:r <user>:F` puts exactly one back.
 */
export function protectKeyFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }
  const account = windowsAccount(environment);
  try {
    execFileSync(
      "icacls",
      [path, "/inheritance:r", "/grant:r", `${account}:F`],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
  } catch (error) {
    throw new Error(
      `无法收紧会话宿主密钥文件的权限（icacls ${path}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** `DOMAIN\user`, or the bare user name when there is no domain. */
export function windowsAccount(environment: NodeJS.ProcessEnv): string {
  const user = environment.USERNAME ?? "";
  if (user === "") {
    throw new Error("USERNAME is not set; cannot name the account to grant");
  }
  const domain = environment.USERDOMAIN ?? "";
  return domain === "" ? user : `${domain}\\${user}`;
}

/**
 * The bytes a proof covers.
 *
 * Newline-joined rather than concatenated: every field is a fixed shape
 * except the endpoint, and a separator the endpoint cannot contain keeps
 * `("a", "bc")` from signing the same string as `("ab", "c")`.
 */
export function proofInput(
  endpoint: string,
  nonce: string,
  issuedAt: number,
  major: number = PROTOCOL_MAJOR,
): string {
  return [AUTH_CONTEXT, String(major), endpoint, nonce, String(issuedAt)].join(
    "\n",
  );
}

export function sign(
  key: Buffer,
  endpoint: string,
  nonce: string,
  issuedAt: number,
  major: number = PROTOCOL_MAJOR,
): string {
  return createHmac("sha256", key)
    .update(proofInput(endpoint, nonce, issuedAt, major))
    .digest("hex");
}

/** A fresh, single-use proof for one connection. */
export function signHello(
  key: Buffer,
  endpoint: string,
  now: number = Date.now(),
  major: number = PROTOCOL_MAJOR,
): HelloAuth {
  const nonce = randomBytes(16).toString("hex");
  return {
    nonce,
    issuedAt: now,
    proof: sign(key, endpoint, nonce, now, major),
  };
}

export type AuthRefusal =
  | "missing"
  | "malformed"
  | "expired"
  | "replayed"
  | "mismatch";

export type AuthVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AuthRefusal };

/**
 * Checks one `hello`'s proof, once.
 *
 * Holds the nonces it has already accepted for as long as they could still be
 * inside the window, and no longer: the set is bounded by the connection rate
 * times {@link SKEW_MS}, not by the life of the process.
 */
export class HandshakeVerifier {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly key: Buffer,
    private readonly endpoint: string,
    private readonly skewMs: number = SKEW_MS,
    private readonly major: number = PROTOCOL_MAJOR,
  ) {}

  verify(auth: unknown, now: number = Date.now()): AuthVerdict {
    if (auth === undefined || auth === null) {
      return { ok: false, reason: "missing" };
    }
    const candidate = auth as Partial<HelloAuth>;
    if (
      typeof candidate.nonce !== "string" ||
      candidate.nonce.length < 16 ||
      candidate.nonce.length > 128 ||
      typeof candidate.proof !== "string" ||
      typeof candidate.issuedAt !== "number" ||
      !Number.isFinite(candidate.issuedAt)
    ) {
      return { ok: false, reason: "malformed" };
    }
    // Checked before the HMAC is computed: an expired proof is refused without
    // this process doing any work an unauthenticated peer asked for.
    if (Math.abs(now - candidate.issuedAt) > this.skewMs) {
      return { ok: false, reason: "expired" };
    }
    this.prune(now);
    if (this.seen.has(candidate.nonce)) {
      return { ok: false, reason: "replayed" };
    }
    const expected = sign(
      this.key,
      this.endpoint,
      candidate.nonce,
      candidate.issuedAt,
      this.major,
    );
    if (!equalHex(expected, candidate.proof)) {
      return { ok: false, reason: "mismatch" };
    }
    // Recorded only on success. A wrong proof must not let an unauthenticated
    // peer fill this map, and it could not be replayed anyway.
    this.seen.set(candidate.nonce, candidate.issuedAt);
    return { ok: true };
  }

  /** For the tests, and for a log line that says how much is being held. */
  get outstanding(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [nonce, issuedAt] of this.seen) {
      if (Math.abs(now - issuedAt) > this.skewMs) this.seen.delete(nonce);
    }
  }
}

/**
 * Constant-time comparison of two hex strings.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * side channel if the lengths were secret. They are not — the digest length
 * is fixed and public — so an early, explicit refusal is correct here.
 */
export function equalHex(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  if (left.byteLength !== right.byteLength || left.byteLength === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}
