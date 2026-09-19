import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HandshakeVerifier,
  SKEW_MS,
  ensureKey,
  equalHex,
  keyPath,
  proofInput,
  readKey,
  sign,
  signHello,
  windowsAccount,
} from "./auth";
import { pipeEndpoint } from "./protocol";

/**
 * The handshake is what replaced the pipe's DACL and the per-connection SID
 * check when the host moved to `node:net`, so it carries the whole weight of
 * "who may open somebody's terminal". Every refusal it can produce is asserted
 * here, on a machine with no named pipes at all — which is the point: none of
 * it needs one.
 */

const directories: string[] = [];

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "armadra-session-auth-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const ENDPOINT = pipeEndpoint(
  "S-1-5-21-1111111111-2222222222-3333333333-1001",
  "C:\\Users\\a\\AppData\\Local\\armadra",
);

describe("the key file", () => {
  it("is created once and read back identically", () => {
    const dataDir = scratch();
    const first = ensureKey(dataDir);
    expect(first.byteLength).toBe(32);
    expect(ensureKey(dataDir).equals(first)).toBe(true);
    expect(readKey(dataDir).equals(first)).toBe(true);
  });

  /**
   * The secret the DACL used to be. A key file this user's neighbours can
   * read is not one, and on POSIX the mode is the whole of the check.
   */
  it.skipIf(process.platform === "win32")(
    "is readable by its owner and by nobody else",
    () => {
      const dataDir = scratch();
      ensureKey(dataDir);
      expect(statSync(keyPath(dataDir)).mode & 0o777).toBe(0o600);
    },
  );

  /**
   * Silently replacing a key that is present but wrong would strand every
   * running session behind a secret nobody holds any more. It is a state a
   * person has to look at.
   */
  it("refuses to replace a key it cannot parse", () => {
    const dataDir = scratch();
    writeFileSync(keyPath(dataDir), "not hex at all");
    expect(() => ensureKey(dataDir)).toThrow(/32-byte hex key/);
  });

  it("names the account icacls would grant", () => {
    expect(windowsAccount({ USERNAME: "ada", USERDOMAIN: "LAB" })).toBe(
      "LAB\\ada",
    );
    expect(windowsAccount({ USERNAME: "ada" })).toBe("ada");
    expect(() => windowsAccount({})).toThrow(/USERNAME/);
  });
});

describe("the proof", () => {
  it("binds to the endpoint, the nonce, the time and the major", () => {
    const key = Buffer.alloc(32, 7);
    const base = sign(key, ENDPOINT, "abc", 1000);
    expect(sign(key, `${ENDPOINT}x`, "abc", 1000)).not.toBe(base);
    expect(sign(key, ENDPOINT, "abd", 1000)).not.toBe(base);
    expect(sign(key, ENDPOINT, "abc", 1001)).not.toBe(base);
    expect(sign(key, ENDPOINT, "abc", 1000, 2)).not.toBe(base);
    expect(sign(Buffer.alloc(32, 8), ENDPOINT, "abc", 1000)).not.toBe(base);
  });

  /**
   * The classic way a "hash of several strings" stops separating what it was
   * supposed to separate.
   */
  it("cannot be confused by moving a character across a field boundary", () => {
    expect(proofInput("ab", "c", 1)).not.toBe(proofInput("a", "bc", 1));
  });
});

describe("the verifier", () => {
  const key = Buffer.alloc(32, 3);
  const verifier = (): HandshakeVerifier =>
    new HandshakeVerifier(key, ENDPOINT);

  it("accepts a fresh proof from a client holding the key", () => {
    const now = 1_700_000_000_000;
    expect(verifier().verify(signHello(key, ENDPOINT, now), now)).toEqual({
      ok: true,
    });
  });

  it("refuses a connection that presents nothing at all", () => {
    expect(verifier().verify(undefined)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(verifier().verify({ nonce: 1, issuedAt: "x" })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  /** The single-use half of "one-time". */
  it("refuses a proof it has already accepted", () => {
    const now = 1_700_000_000_000;
    const checker = verifier();
    const auth = signHello(key, ENDPOINT, now);
    expect(checker.verify(auth, now).ok).toBe(true);
    expect(checker.verify(auth, now)).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  /** The bounded half. */
  it("refuses a proof minted outside the window, in either direction", () => {
    const now = 1_700_000_000_000;
    const checker = verifier();
    expect(
      checker.verify(signHello(key, ENDPOINT, now - SKEW_MS - 1), now),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      checker.verify(signHello(key, ENDPOINT, now + SKEW_MS + 1), now),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a proof minted for a different host", () => {
    const now = 1_700_000_000_000;
    const elsewhere = signHello(key, `${ENDPOINT}-other`, now);
    expect(verifier().verify(elsewhere, now)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a proof from a client that does not hold the key", () => {
    const now = 1_700_000_000_000;
    const stranger = signHello(Buffer.alloc(32, 9), ENDPOINT, now);
    expect(verifier().verify(stranger, now)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  /**
   * The nonce set is bounded by the connection rate times the window, not by
   * the life of the process — a host that runs for a month must not be
   * holding a month of nonces.
   */
  it("forgets nonces once they could no longer be replayed", () => {
    const checker = verifier();
    const now = 1_700_000_000_000;
    checker.verify(signHello(key, ENDPOINT, now), now);
    expect(checker.outstanding).toBe(1);
    const later = now + SKEW_MS * 2;
    checker.verify(signHello(key, ENDPOINT, later), later);
    expect(checker.outstanding).toBe(1);
  });

  /** A failed attempt must not be a way to fill this host's memory. */
  it("remembers nothing about a proof it refused", () => {
    const checker = verifier();
    const now = 1_700_000_000_000;
    for (let index = 0; index < 50; index += 1) {
      checker.verify(signHello(Buffer.alloc(32, 9), ENDPOINT, now), now);
    }
    expect(checker.outstanding).toBe(0);
  });
});

describe("equalHex", () => {
  it("is false for anything that is not the same digest", () => {
    expect(equalHex("aabb", "aabb")).toBe(true);
    expect(equalHex("aabb", "aabc")).toBe(false);
    expect(equalHex("aabb", "aa")).toBe(false);
    expect(equalHex("", "")).toBe(false);
  });
});
