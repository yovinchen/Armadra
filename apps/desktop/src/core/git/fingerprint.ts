import { spawnSync } from "node:child_process";
import { LEGACY_PREFIX, gitEnvironment } from "./command";
import { type GitStatus, parsePorcelainZ, summarizeStatus } from "./status";
import { sha256Hex } from "./support";

/**
 * The Git half of a handoff bundle.
 *
 * A port of `git_fingerprint` in the pre-merge implementation. A
 * handoff says "this is the worktree I was working in"; this is what makes
 * that claim checkable, and what makes it honest when it cannot be checked.
 *
 * `status` is `observed` only when HEAD and the index were actually read. Every
 * other field is independently optional — a repository id can be known for a
 * checkout whose status could not be taken — and `unavailable` is the normal
 * answer for a workspace without the execution grant, because reading the
 * index may trigger lazy fetches and counting changes runs repository filters.
 *
 * It is **synchronous**, unlike everything else in this directory, because the
 * bundle it feeds is assembled synchronously beside a synchronous read of the
 * referenced files. Making one field of that record async would turn the whole
 * handoff path async for a fingerprint that is four short `git` reads.
 */

export interface GitFingerprint {
  readonly headOid: string | null;
  readonly indexDigest: string | null;
  readonly worktreeDigest: string | null;
  readonly repositoryId: string | null;
  readonly worktreeId: string | null;
  /** `observed` or `unavailable`. */
  readonly status: string;
  readonly worktreeDigestBasis: string;
}

export const UNAVAILABLE: GitFingerprint = {
  headOid: null,
  indexDigest: null,
  worktreeDigest: null,
  repositoryId: null,
  worktreeId: null,
  status: "unavailable",
  worktreeDigestBasis: "statusSummary",
};

export interface Fingerprinted {
  readonly rootPath: string;
  readonly execute: boolean;
}

export function gitFingerprint(
  workspace: Fingerprinted | undefined,
): GitFingerprint {
  if (workspace === undefined) return UNAVAILABLE;
  const root = workspace.rootPath;
  const top = read(root, ["rev-parse", "--show-toplevel"]);
  if (top === undefined) return UNAVAILABLE;
  const repository = top.trim();
  const common = read(repository, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const repositoryId = common === undefined ? null : sha256Hex(common.trim());
  const worktreeId = sha256Hex(repository);
  if (!workspace.execute) {
    return { ...UNAVAILABLE, repositoryId, worktreeId };
  }
  const head = read(repository, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const index = readBytes(repository, ["ls-files", "--stage", "-z"]);
  const observed = index !== undefined;
  const status = readStatusSync(repository);
  return {
    headOid: head === undefined ? null : nonEmpty(head.trim()),
    indexDigest: index === undefined ? null : sha256Hex(index),
    worktreeDigest:
      status === undefined ? null : sha256Hex(JSON.stringify(status)),
    repositoryId,
    worktreeId,
    status: observed ? "observed" : "unavailable",
    worktreeDigestBasis: "statusSummary",
  };
}

/**
 * `readStatusFiltered` for the root checkout, without the async path.
 *
 * The two passes and the field order are the ones the async read takes, which
 * matters: the digest is taken over this record's JSON, so a different key
 * order would be a different fingerprint for the same worktree.
 */
function readStatusSync(repository: string): GitStatus | undefined {
  const summary = read(repository, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all",
  ]);
  const entries = read(repository, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (summary === undefined || entries === undefined) return undefined;
  const { branch, ahead, behind, changedCount } = summarizeStatus(summary);
  return {
    repository: true,
    branch,
    changedCount,
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    files: parsePorcelainZ(entries),
  };
}

function read(directory: string, args: readonly string[]): string | undefined {
  const bytes = readBytes(directory, args);
  return bytes === undefined ? undefined : bytes.toString("utf8");
}

function readBytes(
  directory: string,
  args: readonly string[],
): Buffer | undefined {
  const result = spawnSync("git", [...LEGACY_PREFIX, ...args], {
    cwd: directory,
    env: gitEnvironment(),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.stdout === null) return undefined;
  return result.stdout;
}

function nonEmpty(value: string): string | null {
  return value === "" ? null : value;
}
