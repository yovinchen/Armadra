import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimLock, lockPath, readLock, releaseLock } from "./lock";

/**
 * The backup half of the concurrency gate.
 *
 * The primary gate is the listen itself — libuv creates a named pipe with
 * `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a second host's `listen` fails with
 * `EADDRINUSE`, which is what `first_pipe_instance(true)` bought the Rust
 * host. That is Windows behaviour and cannot be asserted here.
 *
 * What *can* be asserted here is the file, and the one decision that makes it
 * useful rather than dangerous: a lock is believed only when the pipe it
 * names answers. These tests inject the connectivity probe so both answers
 * are reachable on a machine with no named pipes.
 */

const directories: string[] = [];

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "armadra-session-lock-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const ENDPOINT = "\\\\.\\pipe\\armadra-session-test";
const alive = async (): Promise<boolean> => true;
const dead = async (): Promise<boolean> => false;

describe("the startup lock", () => {
  it("grants an unclaimed directory and records who holds it", async () => {
    const dataDir = scratch();
    await expect(claimLock(dataDir, ENDPOINT, dead)).resolves.toEqual({
      kind: "granted",
      tookOverStaleLock: false,
    });
    expect(readLock(lockPath(dataDir))).toMatchObject({
      pid: process.pid,
      endpoint: ENDPOINT,
    });
  });

  /**
   * Two cores starting at once is the normal way this process gets launched
   * twice. The second one leaving is the correct outcome, not a failure.
   */
  it("refuses a directory whose host is still answering", async () => {
    const dataDir = scratch();
    writeFileSync(
      lockPath(dataDir),
      JSON.stringify({ pid: 999_999, endpoint: ENDPOINT, startedAt: 1 }),
    );
    const claim = await claimLock(dataDir, ENDPOINT, alive);
    expect(claim.kind).toBe("taken");
    expect(claim.kind === "taken" && claim.held.pid).toBe(999_999);
  });

  /**
   * A lock file outlives a host that was killed. Trusting it on its own would
   * make one crash permanent, so the pipe is what decides.
   */
  it("takes over a lock whose pipe nobody serves", async () => {
    const dataDir = scratch();
    writeFileSync(
      lockPath(dataDir),
      JSON.stringify({ pid: 999_999, endpoint: ENDPOINT, startedAt: 1 }),
    );
    await expect(claimLock(dataDir, ENDPOINT, dead)).resolves.toEqual({
      kind: "granted",
      tookOverStaleLock: true,
    });
    expect(readLock(lockPath(dataDir))?.pid).toBe(process.pid);
  });

  it("treats an unreadable lock as debris rather than a claim", async () => {
    const dataDir = scratch();
    writeFileSync(lockPath(dataDir), "{ truncated");
    // `alive`, so only the unreadability can be the reason it was taken over.
    await expect(claimLock(dataDir, ENDPOINT, alive)).resolves.toEqual({
      kind: "granted",
      tookOverStaleLock: true,
    });
  });

  /**
   * The probe asks the endpoint the *lock* names, not the one this host
   * wants: a lock left by a host of a different protocol major names a
   * different pipe, and asking about this one would take its claim over while
   * it was still running.
   */
  it("probes the endpoint the lock names", async () => {
    const dataDir = scratch();
    writeFileSync(
      lockPath(dataDir),
      JSON.stringify({ pid: 1, endpoint: "other-pipe", startedAt: 1 }),
    );
    const asked: string[] = [];
    await claimLock(dataDir, ENDPOINT, async (endpoint) => {
      asked.push(endpoint);
      return false;
    });
    expect(asked).toEqual(["other-pipe"]);
  });

  it("writes the replacement whole, never half", async () => {
    const dataDir = scratch();
    writeFileSync(lockPath(dataDir), JSON.stringify({ pid: 1, endpoint: "x" }));
    await claimLock(dataDir, ENDPOINT, dead);
    expect(() =>
      JSON.parse(readFileSync(lockPath(dataDir), "utf8")),
    ).not.toThrow();
  });

  /**
   * A host that was replaced must not delete its successor's claim on its way
   * to the exit.
   */
  it("only releases a lock that is still this process'", () => {
    const dataDir = scratch();
    writeFileSync(
      lockPath(dataDir),
      JSON.stringify({ pid: process.pid + 1, endpoint: ENDPOINT }),
    );
    releaseLock(dataDir);
    expect(existsSync(lockPath(dataDir))).toBe(true);

    writeFileSync(
      lockPath(dataDir),
      JSON.stringify({ pid: process.pid, endpoint: ENDPOINT }),
    );
    releaseLock(dataDir);
    expect(existsSync(lockPath(dataDir))).toBe(false);
    // And releasing what is not there is not an error.
    expect(() => releaseLock(dataDir)).not.toThrow();
  });
});
