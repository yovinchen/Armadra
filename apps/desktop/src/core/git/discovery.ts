import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { canonicalDirectory, canonicalize } from "../workspaces/roots";
import { dirtyEntryCount } from "./status";
import { internalError, nowRfc3339, sha256Hex } from "./support";

/**
 * Workspace repository discovery.
 *
 * A port of `apps/runtime/src/git/discovery.rs`. A workspace directory is not
 * one repository: it may hold the root repository, independent repositories in
 * subdirectories, submodules and linked worktrees, and the Git panel has to see
 * all of them.
 *
 * Three properties are load-bearing and kept:
 *
 *   * **The walk is filesystem-only.** Kind, common directory and HEAD branch
 *     are read from `.git` itself, so a workspace with a dozen repositories
 *     costs a dozen file reads rather than a dozen child processes.
 *   * **`gitignore` is deliberately not consulted.** An ignored directory is
 *     very often an independent repository — a vendored checkout, a scratch
 *     clone — and skipping it would hide exactly what this exists for.
 *   * **`dirtyCount` is `null` without the execution grant.** Counting changes
 *     runs `git status`, which may invoke repository filters. An unknown count
 *     is a normal answer, not an error.
 */

/** Directory names never descended into. Not a gitignore: a fixed short list. */
const SKIPPED = ["node_modules", "target", "dist", ".git", ".armadra"];

export const DEFAULT_MAX_DEPTH = 4;
const MAX_ALLOWED_DEPTH = 12;
const MAX_ENTRIES = 20_000;
const MAX_REPOSITORIES = 256;

export type GitRepositoryKind = "root" | "nested" | "submodule" | "worktree";

export interface GitRepositoryRecord {
  readonly repositoryId: string;
  /** Workspace-relative, `.` for the root — the `path` every request takes. */
  readonly repositoryPath: string;
  readonly name: string;
  readonly kind: GitRepositoryKind;
  readonly parentRepositoryId: string | null;
  readonly headBranch: string | null;
  readonly dirtyCount: number | null;
}

export interface GitRepositoryList {
  readonly workspaceRoot: string;
  readonly maxDepth: number;
  readonly repositories: GitRepositoryRecord[];
  readonly truncated: boolean;
  readonly observedAt: string;
}

interface CacheEntry {
  readonly root: string;
  readonly maxDepth: number;
  readonly execute: boolean;
  readonly list: GitRepositoryList;
}

const CACHE = new Map<string, CacheEntry>();

/**
 * Drop the cached list for a workspace. Called when a `file.changed` event
 * touches a `.git` entry, and whenever an operation adds or removes a worktree.
 */
export function invalidate(workspaceId: string): void {
  CACHE.delete(workspaceId);
}

export function invalidateAll(): void {
  CACHE.clear();
}

/**
 * Whether a changed path can add or remove a repository. Only `.git` entries
 * can: everything else leaves the set of repositories exactly as it was.
 */
export function affectsRepositories(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".git" ||
    normalized.endsWith("/.git") ||
    normalized.includes("/.git/") ||
    normalized.startsWith(".git/")
  );
}

/** The cached list, rescanning when the cache is cold or was invalidated. */
export async function repositories(
  workspaceId: string,
  workspaceRoot: string,
  maxDepth: number | undefined,
  execute: boolean,
): Promise<GitRepositoryList> {
  const root = canonicalDirectory(workspaceRoot);
  const depth = Math.min(maxDepth ?? DEFAULT_MAX_DEPTH, MAX_ALLOWED_DEPTH);
  const cached = CACHE.get(workspaceId);
  if (
    cached !== undefined &&
    cached.root === root &&
    cached.maxDepth === depth &&
    cached.execute === execute
  ) {
    return cached.list;
  }
  const list = await scan(root, depth, execute);
  // A workspace map that only ever grows would outlive the workspaces in it;
  // the ceiling is generous but finite.
  if (CACHE.size >= 64) CACHE.clear();
  CACHE.set(workspaceId, { root, maxDepth: depth, execute, list });
  return list;
}

/** Walk the workspace and describe every repository under it. */
export async function scan(
  workspaceRoot: string,
  maxDepth: number,
  execute: boolean,
): Promise<GitRepositoryList> {
  const root = canonicalDirectory(workspaceRoot);
  const found: {
    path: string;
    commonDir: string;
    kind: GitRepositoryKind;
  }[] = [];
  const queue: { directory: string; depth: number }[] = [
    { directory: root, depth: 0 },
  ];
  let visited = 0;
  let truncated = false;
  while (queue.length > 0) {
    const { directory, depth } = queue.pop() as {
      directory: string;
      depth: number;
    };
    if (visited >= MAX_ENTRIES || found.length >= MAX_REPOSITORIES) {
      truncated = true;
      break;
    }
    visited += 1;
    // An unreadable or malformed `.git` is not a repository this panel can
    // offer; it must not fail the whole scan either.
    let classified: { commonDir: string; kind: GitRepositoryKind } | undefined;
    try {
      classified = classify(directory, directory === root);
    } catch {
      classified = undefined;
    }
    if (classified !== undefined) {
      found.push({ path: directory, ...classified });
    }
    if (depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Symlinked directories are never followed: they can leave the workspace,
      // and a cycle would never terminate.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIPPED.includes(entry.name)) continue;
      queue.push({ directory: join(directory, entry.name), depth: depth + 1 });
    }
  }
  found.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  const records: GitRepositoryRecord[] = [];
  for (const entry of found) {
    const repositoryId = deriveId(entry.commonDir);
    const repositoryPath = relativePath(root, entry.path);
    const name =
      repositoryPath === "."
        ? basename(root) || "."
        : basename(entry.path) || repositoryPath;
    let parentRepositoryId: string | null = null;
    if (entry.kind === "worktree") {
      const main = found.find(
        (candidate) =>
          candidate.path !== entry.path &&
          candidate.commonDir === entry.commonDir &&
          candidate.kind !== "worktree",
      );
      parentRepositoryId = main === undefined ? null : deriveId(main.commonDir);
    } else if (entry.kind !== "root") {
      let best: (typeof found)[number] | undefined;
      for (const candidate of found) {
        if (candidate.path === entry.path) continue;
        if (!entry.path.startsWith(`${candidate.path}/`)) continue;
        if (
          best === undefined ||
          candidate.path.split("/").length > best.path.split("/").length
        ) {
          best = candidate;
        }
      }
      parentRepositoryId = best === undefined ? null : deriveId(best.commonDir);
    }
    records.push({
      repositoryId,
      repositoryPath,
      name,
      kind: entry.kind,
      parentRepositoryId,
      headBranch: headBranch(entry.commonDir, entry.path),
      dirtyCount: execute
        ? ((await dirtyEntryCount(entry.path)) ?? null)
        : null,
    });
  }
  return {
    workspaceRoot: root,
    maxDepth,
    repositories: records,
    truncated,
    observedAt: nowRfc3339(),
  };
}

function deriveId(commonDir: string): string {
  return sha256Hex(commonDir);
}

function relativePath(root: string, path: string): string {
  if (path === root) return ".";
  const step = relative(root, path);
  if (step === "" || step.startsWith("..")) {
    throw internalError("Repository escaped the workspace during scan");
  }
  return step.replace(/\\/g, "/");
}

/**
 * Read the `.git` entry of `directory` and report its common directory and
 * kind, or `undefined` when the directory is not a repository checkout.
 */
function classify(
  directory: string,
  isRoot: boolean,
): { commonDir: string; kind: GitRepositoryKind } | undefined {
  const dotGit = join(directory, ".git");
  const info = lstatSync(dotGit, { throwIfNoEntry: false });
  if (info === undefined) return undefined;
  if (info.isDirectory()) {
    return {
      commonDir: canonicalDirectory(dotGit),
      kind: isRoot ? "root" : "nested",
    };
  }
  if (!info.isFile()) return undefined;
  // A `.git` file is `gitdir: <path>` and nothing else. The path is absolute
  // for a submodule and may be relative for a linked worktree.
  const target = gitdirTarget(dotGit);
  if (target === undefined) return undefined;
  const gitDir = canonicalDirectory(
    target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)
      ? target
      : join(directory, target),
  );
  // `<common>/worktrees/<name>` is a linked worktree; the repository's common
  // directory is two levels up. Anything else — `<super>/.git/modules/<name>`
  // above all — is its own common directory.
  const parent = dirname(gitDir);
  if (basename(parent) === "worktrees") {
    return { commonDir: dirname(parent), kind: "worktree" };
  }
  return { commonDir: gitDir, kind: "submodule" };
}

function gitdirTarget(file: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("gitdir:")) {
      return trimmed.slice("gitdir:".length).trim();
    }
  }
  return undefined;
}

/**
 * `refs/heads/<name>` from the checkout's own HEAD, or `null` when detached.
 *
 * A linked worktree keeps its HEAD in `<common>/worktrees/<name>/HEAD`, which
 * is exactly the directory `.git` points at, so the checkout's `.git` entry is
 * re-resolved rather than reusing the shared common directory.
 */
function headBranch(commonDir: string, checkout: string): string | null {
  const dotGit = join(checkout, ".git");
  const info = lstatSync(dotGit, { throwIfNoEntry: false });
  let headFile: string;
  if (info?.isDirectory() === true) {
    headFile = join(dotGit, "HEAD");
  } else if (info?.isFile() === true) {
    const target = gitdirTarget(dotGit);
    if (target === undefined) return null;
    const resolved =
      target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)
        ? target
        : join(checkout, target);
    headFile = join(resolved, "HEAD");
  } else {
    headFile = join(commonDir, "HEAD");
  }
  let head: string;
  try {
    head = readFileSync(headFile, "utf8");
  } catch {
    return null;
  }
  const trimmed = head.trim();
  if (!trimmed.startsWith("ref:")) return null;
  const reference = trimmed.slice(4).trim();
  if (!reference.startsWith("refs/heads/")) return null;
  const name = reference.slice("refs/heads/".length);
  return name === "" ? null : name;
}

/** Canonicalise without requiring a directory, for a `.git` file target. */
export function canonicalOrSelf(path: string): string {
  try {
    return canonicalize(path);
  } catch {
    return path;
  }
}
