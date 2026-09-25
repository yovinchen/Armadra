/**
 * What a desktop update may stop, and how a restart proves itself
 * (docs/design/updates-and-service-install.md §2.3, §3.4; acceptance R5, R6).
 * Ported from the Rust shell's coordinate suite, all 7 test functions.
 */
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import {
  clearPending,
  noReadings,
  pendingPath,
  readPending,
  verifyRestart,
  writePending,
  type Component,
  type HealthReadings,
  type PendingRestart,
} from "./coordinate";

const temporaries: string[] = [];

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-updates-"));
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function pending(): PendingRestart {
  return {
    expectedVersion: "0.2.0",
    previousVersion: "0.1.0",
    previousPackageUrl:
      "https://releases.invalid/download/v0.1.0/Armadra_0.1.0.dmg",
    notesUrl: "https://releases.invalid/v0.2.0",
    startedAtMs: 1_700_000_000_000,
  };
}

it("the pending record survives a round trip and clears once", () => {
  const directory = temporary();
  expect(readPending(directory)).toBeNull();
  expect(writePending(directory, pending())).toEqual({ ok: true });
  expect(readPending(directory)).toEqual(pending());
  expect(pendingPath(directory)).toBe(
    join(directory, "updates", "pending-restart.json"),
  );
  expect(pendingPath(String.raw`C:\Users\x\AppData\Local\Armadra`, win32)).toBe(
    String.raw`C:\Users\x\AppData\Local\Armadra\updates\pending-restart.json`,
  );
  clearPending(directory);
  expect(readPending(directory)).toBeNull();
  // Clearing a record that is already gone is success: what matters is that
  // none remains.
  expect(() => clearPending(directory)).not.toThrow();
});

/** R6: the shell and the Runtime both have to report the new version. */
it("a restart is complete only when both report the new version", () => {
  const all: HealthReadings = {
    shell: "0.2.0",
    runtime: "0.2.0",
  };
  expect(verifyRestart(pending(), all)).toEqual({
    outcome: "completed",
    version: "0.2.0",
  });
});

/**
 * A reading that could not be taken is not agreement. "I could not ask" and
 * "it answered with the new version" are different answers.
 */
it("a missing or stale reading reports the update as unfinished", () => {
  const cases: [HealthReadings, Component[]][] = [
    [{ shell: "0.2.0", runtime: "0.1.0" }, ["runtime"]],
    [{ shell: "0.2.0", runtime: null }, ["runtime"]],
    [noReadings(), ["shell", "runtime"]],
  ];
  for (const [readings, expected] of cases) {
    expect(verifyRestart(pending(), readings)).toEqual({
      outcome: "incomplete",
      mismatched: expected,
      expectedVersion: "0.2.0",
      previousVersion: "0.1.0",
      previousPackageUrl:
        "https://releases.invalid/download/v0.1.0/Armadra_0.1.0.dmg",
    });
  }
});

/**
 * A record with no expected version cannot be satisfied by anything, so it
 * reports "unfinished" rather than agreeing with empty readings.
 */
it("an empty expected version never counts as agreement", () => {
  const record = { ...pending(), expectedVersion: "  " };
  const outcome = verifyRestart(record, {
    shell: "",
    runtime: "",
  });
  expect(outcome.outcome).toBe("incomplete");
});
