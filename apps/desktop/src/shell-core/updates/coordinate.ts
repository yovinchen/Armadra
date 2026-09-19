/**
 * Stopping what this shell owns before an install, and checking afterwards
 * that the update actually happened (design §2.3). A port of
 * `src-tauri/src/updates/coordinate.rs`.
 *
 * The rule that shapes the whole module: **only what this shell started is
 * stopped.** A machine can run two Hosts — the one the desktop app holds and
 * the one an operator installed as a service — and a desktop update that
 * stopped the operator's Host would take down their sessions to install
 * something they did not ask for. The Host writes down who launched it
 * (`launcher.json`), and this module believes that record or it stops nothing.
 *
 * The second rule: **the restart proves itself.** A new shell reads
 * `pending-restart.json` and compares three versions before it says anything
 * about an update; a mismatch is reported as "the update did not finish", with
 * the previous release's link, rather than being quietly forgotten.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Reason } from "./machine";

/** What the Host writes about who started it (`hoststate.LauncherRecord`). */
interface LauncherRecord {
  launcher?: unknown;
  executable?: unknown;
}

/** The record file inside the Host's data directory. */
export function launcherPath(hostDataDir: string): string {
  return join(hostDataDir, "launcher.json");
}

export interface CoordinateEnvironment {
  readonly LOCALAPPDATA?: string | undefined;
  readonly APPDATA?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  readonly [name: string]: string | undefined;
}

/**
 * Where the Host keeps its state, mirroring `hoststate.DefaultDir()`.
 *
 * The shell only passes `--data-dir` when `ARMADRA_HOST_DATA_DIR` is set, so
 * without this the launcher record of an ordinary install would be unreadable
 * and every Host would look like somebody else's.
 */
export function hostDataDir(
  configured?: string,
  platform: string = process.platform,
  env: CoordinateEnvironment = process.env,
): string {
  if (configured) return configured;
  return join(defaultHostBase(platform, env), "Armadra", "host");
}

function defaultHostBase(platform: string, env: CoordinateEnvironment): string {
  if (platform === "win32") {
    if (env.LOCALAPPDATA) return env.LOCALAPPDATA;
    if (env.APPDATA) return env.APPDATA;
    return tmpdir();
  }
  // Go's os.UserConfigDir, which is what the Host calls.
  if (platform === "darwin") {
    return env.HOME ? join(env.HOME, "Library/Application Support") : tmpdir();
  }
  if (env.XDG_CONFIG_HOME?.startsWith("/")) return env.XDG_CONFIG_HOME;
  return env.HOME ? join(env.HOME, ".config") : tmpdir();
}

/**
 * Asks the installed Host binary what version it is.
 *
 * `version --output json` is a read: it starts no server, touches no data
 * directory and needs no lock, so calling it right after a restart cannot
 * disturb the Host that is coming up.
 */
export async function probeHostVersion(
  binary: string,
  dataDir?: string,
  timeoutMs = 10_000,
): Promise<string | null> {
  const args = ["version", "--output", "json"];
  if (dataDir) args.push("--data-dir", dataDir);
  const output = await runCapturing(binary, args, timeoutMs);
  if (output === null) return null;
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof report !== "object" || report === null) return null;
  const value = (report as { version?: unknown }).version;
  if (typeof value !== "string") return null;
  const version = value.trim().replace(/^v+/, "");
  return version.length > 0 ? version : null;
}

/** The probe's output, or `null` for anything that is not a short success. */
function runCapturing(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    // Unref so a probe left running cannot hold the event loop open past quit.
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      length += chunk.length;
      // Bounded: an answer larger than this is not a version report, and
      // reading it only gives a misbehaving Host somewhere to put output.
      if (length > 8192) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}

/**
 * Whether the Host serving out of `hostDataDir` is one this shell launched.
 *
 * Three things have to hold, and any doubt answers `false`: the record exists
 * and parses, it says `desktop`, and the executable it names is the binary
 * this shell would start. A `service` or `cli` Host — and a record left behind
 * by a crashed one that named another program — is left alone.
 */
export function hostIsOurs(hostDataDir: string, ourBinary: string): boolean {
  let record: LauncherRecord;
  try {
    record = JSON.parse(readFileSync(launcherPath(hostDataDir), "utf8"));
  } catch {
    return false;
  }
  if (typeof record !== "object" || record === null) return false;
  const launcher = typeof record.launcher === "string" ? record.launcher : "";
  if (launcher.trim() !== "desktop") return false;
  const executable =
    typeof record.executable === "string" ? record.executable : "";
  // An empty executable is an older Host that recorded only the launcher.
  // "desktop" is still its own statement about itself, so it is believed.
  if (executable.trim().length === 0) return true;
  return sameFile(executable.trim(), ourBinary);
}

function sameFile(a: string, b: string): boolean {
  const canonical = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return canonical(a) === canonical(b);
}

/**
 * What the shell writes before handing control to the installer, so the build
 * that starts next knows an update was supposed to happen.
 */
export interface PendingRestart {
  /** The version every side should report once the install worked. */
  expectedVersion: string;
  /** What was running before, so a failed update can point back at it. */
  previousVersion: string;
  /** Where to download the previous release by hand, if it comes to that. */
  previousPackageUrl: string;
  notesUrl: string;
  startedAtMs: number;
}

/** `<data dir>/updates/pending-restart.json`. */
export function pendingPath(dataDir: string): string {
  return join(dataDir, "updates", "pending-restart.json");
}

export type Written = { ok: true } | { ok: false; reason: Reason };

/**
 * Records the restart. Written before the installer runs, because after it
 * runs this process may not exist.
 */
export function writePending(
  dataDir: string,
  pending: PendingRestart,
): Written {
  const path = pendingPath(dataDir);
  try {
    mkdirSync(join(dataDir, "updates"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: writeReason(error) };
  }
}

/**
 * "No space left" is the one write failure a person can act on, so it is told
 * apart from the rest instead of all of them becoming "install failed".
 */
function writeReason(error: unknown): Reason {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOSPC" ? "diskFull" : "installFailed";
}

/** Reads the record, or `null` when no update was pending. */
export function readPending(dataDir: string): PendingRestart | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pendingPath(dataDir), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.expectedVersion !== "string") return null;
  if (typeof record.previousVersion !== "string") return null;
  return {
    expectedVersion: record.expectedVersion,
    previousVersion: record.previousVersion,
    previousPackageUrl:
      typeof record.previousPackageUrl === "string"
        ? record.previousPackageUrl
        : "",
    notesUrl: typeof record.notesUrl === "string" ? record.notesUrl : "",
    startedAtMs:
      typeof record.startedAtMs === "number" ? record.startedAtMs : 0,
  };
}

/**
 * Drops the record. A missing file is success: the point is that no record
 * remains, not that this call is the one that removed it.
 */
export function clearPending(dataDir: string): void {
  const path = pendingPath(dataDir);
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
}

/**
 * What the three services reported after the restart. An absent reading is
 * `null`, which is never treated as agreement.
 */
export interface HealthReadings {
  shell: string | null;
  host: string | null;
  runtime: string | null;
}

export function noReadings(): HealthReadings {
  return { shell: null, host: null, runtime: null };
}

/** Which of the three did not report the expected version. */
export type Component = "shell" | "host" | "runtime";

/** The verdict a restarted shell reaches (design §2.3, acceptance R6). */
export type RestartOutcome =
  /** All three report the expected version. */
  | { outcome: "completed"; version: string }
  /**
   * At least one does not. The pending record is kept so the page can offer
   * the previous release; nothing is rolled back automatically, because a
   * migrated database cannot be un-migrated (design §2.3).
   */
  | {
      outcome: "incomplete";
      mismatched: Component[];
      expectedVersion: string;
      previousVersion: string;
      previousPackageUrl: string;
    };

/**
 * Compares what the three services report with what the install promised.
 *
 * A reading that is missing counts as a mismatch. "I could not ask" and "it
 * answered with the new version" are different answers, and only the second
 * one means the update finished.
 */
export function verifyRestart(
  pending: PendingRestart,
  readings: HealthReadings,
): RestartOutcome {
  const expected = pending.expectedVersion.trim();
  const mismatched: Component[] = [];
  const pairs: [Component, string | null][] = [
    ["shell", readings.shell],
    ["host", readings.host],
    ["runtime", readings.runtime],
  ];
  for (const [component, reading] of pairs) {
    const agrees =
      reading !== null && expected.length > 0 && reading.trim() === expected;
    if (!agrees) mismatched.push(component);
  }
  if (mismatched.length === 0)
    return { outcome: "completed", version: expected };
  return {
    outcome: "incomplete",
    mismatched,
    expectedVersion: expected,
    previousVersion: pending.previousVersion,
    previousPackageUrl: pending.previousPackageUrl,
  };
}
