import { closeSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import {
  gitOutput,
  gitText,
  isTracked,
  preparePaths,
  requireRepository,
} from "./context";
import { badRequest, conflict, forbidden, notFound } from "./support";

/**
 * Staging, unstaging, conflict resolution and restoring paths.
 *
 * A port of the pre-merge implementation.
 */

export interface StageResult {
  readonly staged: string[];
}
export interface UnstageResult {
  readonly unstaged: string[];
}
export interface ResolveResult {
  readonly resolved: string[];
}
export interface RevertResult {
  readonly reverted: string[];
}

/** Which version a restore takes the file back to. */
export type RestoreSource = "index" | "head";

/** The largest file the conflict-marker scan will read. */
const MAX_RESOLVE_SCAN = 16 * 1024 * 1024;

/**
 * `git restore --staged -- <paths>`: drops the index entry back to HEAD and
 * leaves the working tree alone, so nothing the user typed is ever lost.
 *
 * Before the first commit there is no HEAD to restore from, so a freshly added
 * file is removed from the index instead.
 */
export async function unstagePaths(
  workspaceRoot: string,
  requested: string,
  paths: readonly string[],
): Promise<UnstageResult> {
  const context = await requireRepository(workspaceRoot, requested);
  const unstaged = preparePaths(context, paths).map((entry) => entry.relative);
  const head = await gitOutput(context.repository, [
    "rev-parse",
    "--verify",
    "-q",
    "HEAD",
  ]);
  const args =
    head.status === 0
      ? ["restore", "--staged", "--"]
      : ["rm", "--cached", "-q", "--ignore-unmatch", "--"];
  await gitText(context.repository, [...args, ...unstaged]);
  return { unstaged };
}

/**
 * `git add -- <paths>`. Every path must be a workspace-relative regular file
 * inside the authorized root, or a tracked path that was deleted on disk.
 */
export async function stagePaths(
  workspaceRoot: string,
  requested: string,
  paths: readonly string[],
): Promise<StageResult> {
  const context = await requireRepository(workspaceRoot, requested);
  const prepared = preparePaths(context, paths);
  const staged: string[] = [];
  for (const entry of prepared) {
    const info = lstatSync(entry.absolute, { throwIfNoEntry: false });
    if (info === undefined) {
      if (!(await isTracked(context, entry.relative))) {
        throw notFound("Requested path does not exist in the workspace");
      }
    } else if (info.isSymbolicLink() || !info.isFile()) {
      throw forbidden("Only regular files inside the workspace can be staged");
    }
    staged.push(entry.relative);
  }
  if (staged.length > 0) {
    await gitText(context.repository, ["add", "--", ...staged]);
  }
  return { staged };
}

/**
 * Explicitly mark conflicted paths resolved: `git add -- <paths>`, but only
 * after each file has been read back and no longer contains a conflict marker.
 *
 * Saving a file never marks it resolved on its own, and a file that still has
 * markers is refused with the exact lines.
 */
export async function markResolved(
  workspaceRoot: string,
  requested: string,
  paths: readonly string[],
): Promise<ResolveResult> {
  const context = await requireRepository(workspaceRoot, requested);
  const prepared = preparePaths(context, paths);
  const resolved: string[] = [];
  for (const entry of prepared) {
    const unmerged = await gitText(context.repository, [
      "ls-files",
      "--unmerged",
      "-z",
      "--",
      entry.relative,
    ]);
    if (unmerged === "") {
      throw badRequest(
        `${entry.relative} is not a conflicted path in this index`,
      );
    }
    const info = lstatSync(entry.absolute, { throwIfNoEntry: false });
    if (info === undefined) {
      throw notFound(
        `${entry.relative} has no resolved content on disk; delete or restore it with Git first`,
      );
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw forbidden("Only regular files can be marked resolved");
    }
    if (info.size > MAX_RESOLVE_SCAN) {
      throw badRequest(
        `${entry.relative} is too large to check for conflict markers`,
      );
    }
    const markers = conflictMarkerLines(readBounded(entry.absolute, info.size));
    if (markers.length > 0) {
      const shown = markers.slice(0, 20).join(", ");
      const more =
        markers.length > 20 ? ` (and ${markers.length - 20} more)` : "";
      throw conflict(
        `${entry.relative} still contains conflict markers on line(s) ${shown}${more}; resolve them before marking it resolved`,
      );
    }
    resolved.push(entry.relative);
  }
  await gitText(context.repository, ["add", "--", ...resolved]);
  return { resolved };
}

/**
 * 1-based line numbers holding a Git conflict marker. Bytes are scanned
 * directly so a binary or non-UTF-8 file is still checked rather than refused.
 */
export function conflictMarkerLines(bytes: Buffer): number[] {
  const lines: number[] = [];
  let start = 0;
  let number = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    number += 1;
    const length = end - start;
    if (length >= 7) {
      const marker = bytes[start] as number;
      if (
        marker === 0x3c ||
        marker === 0x7c ||
        marker === 0x3d ||
        marker === 0x3e
      ) {
        let uniform = true;
        for (let offset = 0; offset < 7; offset += 1) {
          if (bytes[start + offset] !== marker) {
            uniform = false;
            break;
          }
        }
        if (uniform && (length === 7 || bytes[start + 7] === 0x20)) {
          lines.push(number);
        }
      }
    }
    start = index + 1;
  }
  return lines;
}

/**
 * Tracked paths are restored from the requested source; untracked regular
 * files are deleted either way. Directories and symlinks are refused.
 *
 * Restoring from HEAD also unstages, which is the whole difference from the
 * index restore: the caller has to pick which of the two losses it wants.
 */
export async function revertPaths(
  workspaceRoot: string,
  requested: string,
  paths: readonly string[],
  source: RestoreSource,
): Promise<RevertResult> {
  const context = await requireRepository(workspaceRoot, requested);
  const prepared = preparePaths(context, paths);
  const tracked: string[] = [];
  const untracked: { relative: string; absolute: string }[] = [];
  for (const entry of prepared) {
    const info = lstatSync(entry.absolute, { throwIfNoEntry: false });
    if (info !== undefined && (info.isSymbolicLink() || info.isDirectory())) {
      throw forbidden("Only regular files can be reverted");
    }
    if (await isTracked(context, entry.relative)) {
      tracked.push(entry.relative);
    } else if (info !== undefined) {
      untracked.push(entry);
    }
  }
  const reverted: string[] = [];
  if (tracked.length > 0) {
    let args: string[];
    if (source === "index") {
      args = ["checkout", "--"];
    } else {
      // Before the first commit there is no HEAD to restore from, and refusing
      // is better than pretending the index is HEAD.
      const head = await gitOutput(context.repository, [
        "rev-parse",
        "--verify",
        "-q",
        "HEAD^{commit}",
      ]);
      if (head.status !== 0) {
        throw conflict("This branch has no commit to restore these files from");
      }
      args = ["restore", "--source=HEAD", "--staged", "--worktree", "--"];
    }
    await gitText(context.repository, [...args, ...tracked]);
    reverted.push(...tracked);
  }
  for (const entry of untracked) {
    unlinkSync(entry.absolute);
    reverted.push(entry.relative);
  }
  reverted.sort();
  return { reverted };
}

function readBounded(path: string, size: number): Buffer {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, MAX_RESOLVE_SCAN));
    const read = readSync(handle, buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(handle);
  }
}
