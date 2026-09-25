/**
 * Stopping what this shell owns before an install, and checking afterwards
 * that the update actually happened (design §2.3). A port of
 * the Rust shell this one replaced.
 *
 * 壳只拥有一个后台：进程内的 core（Runtime）。原先还要先认一遍「这个 Host 是不是
 * 我拉起的」（读 `launcher.json`、探 Host 的版本），独立 Host 进程拆掉之后那套
 * 判断没有对象了，一并删掉；装更新前只停 Runtime。
 *
 * The rule that shapes the module: **the restart proves itself.** A new shell
 * reads `pending-restart.json` and compares the versions before it says
 * anything about an update; a mismatch is reported as "the update did not
 * finish", with the previous release's link, rather than being quietly
 * forgotten.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path, { join } from "node:path";

import type { Reason } from "./machine";

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
export function pendingPath(
  dataDir: string,
  pathModule: typeof path = path,
): string {
  return pathModule.join(dataDir, "updates", "pending-restart.json");
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
 * What the shell and the Runtime reported after the restart. An absent reading
 * is `null`, which is never treated as agreement.
 */
export interface HealthReadings {
  shell: string | null;
  runtime: string | null;
}

export function noReadings(): HealthReadings {
  return { shell: null, runtime: null };
}

/** Which of the two did not report the expected version. */
export type Component = "shell" | "runtime";

/** The verdict a restarted shell reaches (design §2.3, acceptance R6). */
export type RestartOutcome =
  /** Both report the expected version. */
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
 * Compares what the shell and the Runtime report with what the install promised.
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
