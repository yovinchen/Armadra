import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hardenDirectory, hardenFile, writeSecret } from "../paths";

/**
 * Hook credentials — contract §5.2.
 *
 * Two secrets, two very different lifetimes:
 *
 *   * the **app bearer** (`ARMADRA_HOOK_TOKEN`) proves "this process may talk
 *     to the hook routes at all". It lives in the endpoint file and is
 *     regenerated only when that file has none.
 *   * the **per-node token** proves "this report is about *that* node". It is
 *     derived, never stored: `<data>/node-tokens/<nodeId>` is a cache of a
 *     value that can always be recomputed from the instance secret.
 *
 * Deriving instead of storing is what makes the three-way verdict possible: a
 * token minted by a previous install carries a foreign `kid`, so it is
 * `legacy` (accepted, flagged) rather than `forged` (rejected).
 *
 * The byte-level scheme is the Rust Runtime's, unchanged, because both
 * implementations read the same `hook-secret` file and a terminal started by
 * one must keep reporting to the other.
 */

/**
 * Domain separators. Both are versioned so a future scheme can coexist with
 * tokens minted today instead of silently changing their meaning.
 */
const KID_DOMAIN = "armadra-node-kid-v1";
const MAC_DOMAIN_PREFIX = "armadra-node-v1|";
/**
 * Characters of the base64url key id kept in a token. Eight is enough to tell
 * installs apart and short enough to keep the file readable.
 */
const KID_LENGTH = 8;
const SECRET_BYTES = 32;

/** How a hook report authenticated itself for the node it claims. */
export type Verdict = "verified" | "legacy" | "forged";

/**
 * A node id is joined onto a filesystem path, so it is validated before it is
 * ever touched: no separators, no `..`, no empty string.
 */
export function validNodeId(nodeId: string): boolean {
  return (
    nodeId.length > 0 && nodeId.length <= 80 && /^[A-Za-z0-9_-]+$/.test(nodeId)
  );
}

function hmac(secret: Buffer, message: string): Buffer {
  return createHmac("sha256", secret).update(message, "utf8").digest();
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function deriveKid(secret: Buffer): string {
  return base64url(hmac(secret, KID_DOMAIN)).slice(0, KID_LENGTH);
}

function deriveMac(secret: Buffer, nodeId: string): string {
  return base64url(hmac(secret, `${MAC_DOMAIN_PREFIX}${nodeId}`));
}

/**
 * Constant time throughout: a length-only mismatch must not be faster to
 * discover than a byte mismatch. `timingSafeEqual` throws on a length
 * difference, so the length is folded in first — the comparison itself stays
 * branch-free.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(): string {
  return base64url(randomBytes(SECRET_BYTES));
}

/**
 * Loads the instance secret from `<dataDir>/hook-secret`, creating it on first
 * use.
 *
 * TODO(keyring): contract §5.2 wants the secret in the OS keyring with this
 * file as the fallback. The file is the whole implementation for now, and it
 * is 0600 inside a 0700 directory.
 */
function loadOrCreateSecret(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true });
  hardenDirectory(dataDir);
  const path = join(dataDir, "hook-secret");
  try {
    const existing = readFileSync(path);
    if (existing.length === SECRET_BYTES) {
      hardenFile(path);
      return existing;
    }
  } catch {
    // Not there, or unreadable: a new one is minted below.
  }
  const secret = randomBytes(SECRET_BYTES);
  writeSecret(path, secret);
  return secret;
}

export class HookAuth {
  readonly kid: string;

  private constructor(
    private readonly secret: Buffer,
    readonly bearer: string,
  ) {
    this.kid = deriveKid(secret);
  }

  /**
   * `bearer` is the token already present in the endpoint file, if any:
   * reusing it keeps terminals that outlive the core working. A bearer that is
   * missing or obviously truncated is replaced.
   */
  static load(dataDir: string, bearer?: string | undefined): HookAuth {
    const secret = loadOrCreateSecret(dataDir);
    const kept =
      bearer !== undefined && bearer.length >= 16 ? bearer : randomToken();
    return new HookAuth(secret, kept);
  }

  /** In-memory only: for tests and for a data directory we could not write. */
  static ephemeral(): HookAuth {
    return new HookAuth(randomBytes(SECRET_BYTES), randomToken());
  }

  /** `kid.mac` — what a hook client presents as `X-Armadra-Node-Token`. */
  nodeToken(nodeId: string): string {
    return `${this.kid}.${deriveMac(this.secret, nodeId)}`;
  }

  bearerMatches(presented: string | undefined): boolean {
    if (presented === undefined) return false;
    return constantTimeEqual(presented, this.bearer);
  }

  verdict(nodeId: string, presented: string | undefined): Verdict {
    const token = presented?.trim();
    if (token === undefined || token === "") return "legacy";
    const separator = token.indexOf(".");
    if (separator < 0) return "legacy";
    const kid = token.slice(0, separator);
    const mac = token.slice(separator + 1);
    if (!constantTimeEqual(kid, this.kid)) {
      // Another install's token. Contract §5.2 accepts it and flags the row.
      return "legacy";
    }
    return constantTimeEqual(mac, deriveMac(this.secret, nodeId))
      ? "verified"
      : "forged";
  }

  /**
   * Writes `<tokenDir>/<nodeId>` (0600) atomically and returns the token.
   * A node id that could escape the directory is refused before the write.
   */
  writeNodeToken(tokenDir: string, nodeId: string): string {
    if (!validNodeId(nodeId)) {
      throw new Error("node id is not path safe");
    }
    const token = this.nodeToken(nodeId);
    mkdirSync(tokenDir, { recursive: true });
    hardenDirectory(tokenDir);
    writeSecret(join(tokenDir, nodeId), token);
    return token;
  }
}
