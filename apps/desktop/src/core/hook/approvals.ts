import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { hardenDirectory, hardenFile, pendingDir } from "../paths";

/**
 * Hook-reply permission answers — contract §5.5.
 *
 * When the hook client is waiting on a permission request it has written
 * `<data>/pending/<id>.json` and is polling for `<id>.answer`; writing that
 * file is deterministic — the CLI gets the decision through its own hook
 * protocol and never sees a keystroke.
 *
 * Orphan files are swept at start-up and hourly, because a client that was
 * killed mid-wait leaves both files behind and they contain the tool call the
 * agent wanted to make.
 */

/** Pending files older than this are the remains of a client that went away. */
export const ORPHAN_MINUTES = 10;
/** How often the sweep runs after the one at start-up. */
export const SWEEP_INTERVAL_MS = 3_600_000;
/** `ARMADRA_PERM_WAIT_SECS` for a CLI that supports hook replies. */
export const PERM_WAIT_SECONDS = 45;

/**
 * The extra PTY variable that switches the hook client from "report and exit"
 * to "write the request, wait for an answer file, print the decision"
 * (contract §5.5).
 *
 * Only Claude implements a hook that can answer a permission request, and the
 * user can turn it off with `hooks.replyApprovals`. Everything else gets an
 * empty list, which is the same as not being injected at all.
 */
export function permissionWaitEnvironment(
  agentId: string,
  replyApprovals: boolean,
): readonly (readonly [string, string])[] {
  if (agentId !== "claude" || !replyApprovals) return [];
  return [["ARMADRA_PERM_WAIT_SECS", String(PERM_WAIT_SECONDS)]];
}

/**
 * `<nodeId>-<epochMs>-<pid>`; anything that could escape the directory or name
 * a file we did not write is refused before it reaches the filesystem.
 */
export function validPendingId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    !value.includes("..")
  );
}

/**
 * Writes `<pending>/<id>.answer` atomically, 0600. `false` means there was no
 * pending request file, so nobody is polling for the answer.
 */
export function writeAnswerFile(
  directory: string,
  pendingId: string,
  decision: string,
): boolean {
  if (!validPendingId(pendingId)) {
    throw new Error("Approval id is invalid");
  }
  if (!existsSync(join(directory, `${pendingId}.json`))) return false;
  mkdirSync(directory, { recursive: true });
  hardenDirectory(directory);
  const target = join(directory, `${pendingId}.answer`);
  const temporary = join(directory, `.${pendingId}.answer.tmp`);
  writeFileSync(temporary, decision, "utf8");
  hardenFile(temporary);
  renameSync(temporary, target);
  hardenFile(target);
  return true;
}

/**
 * Deletes pending request and answer files older than {@link ORPHAN_MINUTES}.
 * Returns how many files went away.
 */
export function sweepOrphans(directory: string, olderThanMs: number): number {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const path = join(directory, name);
    const extension = extname(name).slice(1);
    if (!["json", "answer", "tmp"].includes(extension)) continue;
    let stale = false;
    try {
      stale = Date.now() - statSync(path).mtimeMs > olderThanMs;
    } catch {
      continue;
    }
    if (!stale) continue;
    try {
      rmSync(path, { force: true });
      removed += 1;
    } catch {
      // A file we cannot remove is one the next sweep tries again.
    }
  }
  return removed;
}

/**
 * Starts the start-up sweep and the hourly one; returns the stop function.
 * The timer is unref'd so it never keeps the process alive on its own.
 */
export function startApprovalSweep(
  dataDir: string,
  onSwept: (removed: number) => void = () => {},
): () => void {
  const directory = pendingDir(dataDir);
  const age = ORPHAN_MINUTES * 60_000;
  const run = (): void => {
    const removed = sweepOrphans(directory, age);
    if (removed > 0) onSwept(removed);
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
