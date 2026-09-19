/**
 * What a desktop update may stop, and how a restart proves itself
 * (docs/design/updates-and-service-install.md §2.3, §3.4; acceptance R5, R6).
 * Ported from the Rust shell's coordinate suite, all 7 test functions.
 */
import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

import {
  clearPending,
  hostDataDir,
  hostIsOurs,
  launcherPath,
  noReadings,
  pendingPath,
  probeHostVersion,
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

function writeLauncher(directory: string, body: string): void {
  writeFileSync(launcherPath(directory), body);
}

/**
 * R5: only the Host this shell started is stopped. A service-mode Host and its
 * sessions belong to whoever installed it.
 */
it("only a host this shell launched is ours to stop", () => {
  const directory = temporary();
  const binary = join(directory, "armadra-host");
  writeFileSync(binary, "#!/bin/sh\n");

  // No record at all: a Host may be running that never said who started it.
  expect(hostIsOurs(directory, binary)).toBe(false);

  for (const launcher of ["service", "cli", "", "Desktop", "tmux"]) {
    writeLauncher(directory, JSON.stringify({ launcher }));
    expect(
      hostIsOurs(directory, binary),
      `launcher ${JSON.stringify(launcher)} was treated as ours`,
    ).toBe(false);
  }

  // Unreadable records are refused rather than assumed: the whole point of the
  // file is to stop an update acting on a Host it does not own.
  writeLauncher(directory, "not json");
  expect(hostIsOurs(directory, binary)).toBe(false);

  // "desktop" naming another program is a stale record from a crashed Host.
  writeLauncher(
    directory,
    JSON.stringify({
      launcher: "desktop",
      executable: join(directory, "some-other-host"),
    }),
  );
  expect(hostIsOurs(directory, binary)).toBe(false);

  writeLauncher(
    directory,
    JSON.stringify({ launcher: "desktop", executable: binary }),
  );
  expect(hostIsOurs(directory, binary)).toBe(true);

  // An older Host recorded only the launcher; "desktop" is still its own
  // statement about itself.
  writeLauncher(directory, '{"launcher":" desktop "}');
  expect(hostIsOurs(directory, binary)).toBe(true);
});

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

/** R6: the shell, the Host and the Runtime all have to report the new version. */
it("a restart is complete only when all three report the new version", () => {
  const all: HealthReadings = {
    shell: "0.2.0",
    host: "0.2.0",
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
    [{ shell: "0.2.0", host: "0.1.0", runtime: "0.2.0" }, ["host"]],
    [{ shell: "0.2.0", host: null, runtime: null }, ["host", "runtime"]],
    [noReadings(), ["shell", "host", "runtime"]],
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
 * reports "unfinished" rather than agreeing with three empty readings.
 */
it("an empty expected version never counts as agreement", () => {
  const record = { ...pending(), expectedVersion: "  " };
  const outcome = verifyRestart(record, {
    shell: "",
    host: "",
    runtime: "",
  });
  expect(outcome.outcome).toBe("incomplete");
});

/**
 * The Host's data directory has to be found even when the shell passes no
 * `--data-dir`, or every Host would look like somebody else's.
 */
it("the host data directory falls back to the hosts own default", () => {
  const configured = join(tmpdir(), "armadra-host-data");
  expect(hostDataDir(configured)).toBe(configured);
  const fallback = hostDataDir(undefined);
  expect(isAbsolute(fallback)).toBe(true);
  expect(fallback.endsWith(join("Armadra", "host"))).toBe(true);
  // The three platform branches, checked on whichever one is running.
  expect(hostDataDir(undefined, "darwin", { HOME: "/tmp/home" }, posix)).toBe(
    "/tmp/home/Library/Application Support/Armadra/host",
  );
  expect(
    hostDataDir(
      undefined,
      "win32",
      { LOCALAPPDATA: "C:\\Users\\a\\AppData" },
      win32,
    ),
  ).toBe(String.raw`C:\Users\a\AppData\Armadra\host`);
  expect(
    hostDataDir(
      undefined,
      "win32",
      { APPDATA: String.raw`C:\Users\a\AppData\Roaming` },
      win32,
    ),
  ).toBe(String.raw`C:\Users\a\AppData\Roaming\Armadra\host`);
  expect(hostDataDir(undefined, "linux", { HOME: "/tmp/home" }, posix)).toBe(
    "/tmp/home/.config/Armadra/host",
  );
  expect(
    hostDataDir(
      undefined,
      "linux",
      {
        XDG_CONFIG_HOME: "/tmp/xdg",
        HOME: "/tmp/home",
      },
      posix,
    ),
  ).toBe("/tmp/xdg/Armadra/host");
});

/** The version probe is a read that must not hang or trust unbounded output. */
it.runIf(process.platform !== "win32")(
  "the host version probe refuses anything but a short successful json answer",
  async () => {
    const directory = temporary();
    const binary = join(directory, "armadra-host");
    const cases: [string, string | null][] = [
      [
        `test "$1 $2 $3" = 'version --output json' || exit 8\nprintf '{"version":"v0.2.0","channel":"stable"}'`,
        "0.2.0",
      ],
      [`printf '{"version":"0.2.0"}'; exit 3`, null],
      [`printf 'not json'`, null],
      [`printf '{"version":""}'`, null],
      [`head -c 9000 /dev/zero`, null],
    ];
    for (const [script, expected] of cases) {
      writeFileSync(binary, `#!/bin/sh\n${script}\n`);
      chmodSync(binary, 0o700);
      expect(
        await probeHostVersion(binary),
        `script ${JSON.stringify(script)}`,
      ).toBe(expected);
    }
    // A binary that is not there at all answers "I could not ask", never a
    // version: the caller reads `null` as a mismatch (R6).
    expect(await probeHostVersion(join(directory, "absent"))).toBeNull();
    // And a probe that never returns is abandoned rather than awaited forever.
    writeFileSync(binary, "#!/bin/sh\nsleep 30\n");
    chmodSync(binary, 0o700);
    expect(await probeHostVersion(binary, undefined, 250)).toBeNull();
  },
);
