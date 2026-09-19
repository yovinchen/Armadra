import { openSync, readSync, closeSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, workspaceRelativePath } from "../workspaces/roots";
import {
  IGNORE_WHITESPACE,
  MAX_PATHS_PER_REQUEST,
  gitText,
  isInside,
  repoContext,
} from "./context";
import { normalizeFileStatus, statusEntries } from "./status";
import { badRequest, forbidden, requireExecution } from "./support";
import { DomainError } from "../workspaces/support";

/**
 * Working-tree and index diffs: `git diff` and `git diff --cached`.
 *
 * A port of `apps/runtime/src/git/diff.rs`.
 */

export type DiffScope = "worktree" | "staged";

export interface GitFileDiff {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
  /**
   * `false` when the file is listed but its content cannot be shown as a
   * textual patch (binary, or an oversized untracked file).
   */
  readonly previewable: boolean;
  readonly staged: boolean;
}

export interface GitDiff {
  readonly repository: boolean;
  readonly clean: boolean;
  readonly files: GitFileDiff[];
}

export interface DiffRequest {
  readonly scope: DiffScope;
  readonly paths: readonly string[];
  readonly ignoreWhitespace: boolean;
}

interface MutableFileDiff {
  path: string;
  status: string;
  untracked: boolean;
  additions: number;
  deletions: number;
  patch: string;
  previewable: boolean;
  staged: boolean;
}

const MAX_UNTRACKED_PREVIEW = 1024 * 1024;

export async function readDiff(
  workspaceRoot: string,
  requested: string,
  request: DiffRequest,
  execute = true,
): Promise<GitDiff> {
  if (request.scope === "worktree") {
    requireExecution(execute, "Git worktree diff");
  }
  const context = await repoContext(workspaceRoot, requested, execute);
  if (context === undefined) {
    return { repository: false, clean: true, files: [] };
  }
  const { workspaceRoot: root, repository, pathspec } = context;

  let pathspecs: string[];
  if (request.paths.length === 0) {
    pathspecs = pathspec === "" ? [] : [pathspec];
  } else {
    if (request.paths.length > MAX_PATHS_PER_REQUEST) {
      throw badRequest("At most 200 paths can be diffed at once");
    }
    pathspecs = request.paths.map((path) => workspaceRelativePath(path));
  }

  const cached = request.scope === "staged";
  const files = new Map<string, MutableFileDiff>();
  for (const [status, path] of await diffNameStatus(
    repository,
    cached,
    pathspecs,
    execute,
  )) {
    files.set(path, {
      path,
      status,
      untracked: false,
      additions: 0,
      deletions: 0,
      patch: "",
      previewable: true,
      staged: cached,
    });
  }
  if (!cached) {
    for (const entry of await statusEntries(repository, pathspecs)) {
      if (entry.status === "?" && !files.has(entry.path)) {
        files.set(entry.path, {
          path: entry.path,
          status: "?",
          untracked: true,
          additions: 0,
          deletions: 0,
          patch: "",
          previewable: true,
          staged: false,
        });
      }
    }
  }

  // The file list itself never ignores whitespace: a whitespace-only edit is
  // still a change, and hiding the row would contradict `git status`. Only the
  // rendered patch and its line counts honour the option.
  for (const [additions, deletions, path] of await diffNumstat(
    repository,
    cached,
    pathspecs,
    execute,
    request.ignoreWhitespace,
  )) {
    const file = files.get(path);
    if (file !== undefined) {
      file.additions += additions;
      file.deletions += deletions;
    }
  }

  for (const file of files.values()) {
    if (!file.untracked) {
      const args = ["diff"];
      if (cached) args.push("--cached");
      if (request.ignoreWhitespace) args.push(IGNORE_WHITESPACE);
      args.push("--", file.path);
      file.patch = (await gitText(repository, args, execute)).replace(
        /\n+$/,
        "",
      );
      continue;
    }
    // A single un-previewable untracked file must not fail the whole scan; it
    // is listed without a textual patch instead.
    try {
      const content = readUntrackedFile(root, repository, file.path);
      const lines = content.split("\n");
      const trailing = lines.length > 0 && lines[lines.length - 1] === "";
      const counted = trailing ? lines.slice(0, -1) : lines;
      file.additions = counted.length;
      file.patch = counted
        .slice(0, 400)
        .map((line) => `+${line}`)
        .join("\n");
    } catch (error) {
      if (error instanceof DomainError && error.status === 400) {
        file.additions = 0;
        file.patch = "";
        file.previewable = false;
        continue;
      }
      throw error;
    }
  }

  const ordered = [...files.keys()].sort().map((path) => {
    const file = files.get(path) as MutableFileDiff;
    return {
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
      previewable: file.previewable,
      staged: file.staged,
    };
  });
  return { repository: true, clean: ordered.length === 0, files: ordered };
}

function diffArgs(
  mode: string,
  cached: boolean,
  pathspecs: readonly string[],
): string[] {
  const args = ["diff"];
  if (cached) args.push("--cached");
  args.push(mode, "-z", "--", ...pathspecs);
  return args;
}

/**
 * `git diff [--cached] --name-status -z` → `(status, path)`.
 *
 * `-z` is what makes this safe: paths are emitted verbatim, so a path
 * containing a space, quote or newline still parses. Renames and copies emit
 * `R100\0<old>\0<new>\0`; the new path is the one the UI addresses.
 */
async function diffNameStatus(
  repository: string,
  cached: boolean,
  pathspecs: readonly string[],
  execute: boolean,
): Promise<[string, string][]> {
  const output = await gitText(
    repository,
    diffArgs("--name-status", cached, pathspecs),
    execute,
  );
  const fields = output.split("\0").filter((field) => field !== "");
  const entries: [string, string][] = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index] as string;
    index += 1;
    const renamed = code.startsWith("R") || code.startsWith("C");
    const first = fields[index];
    if (first === undefined) break;
    index += 1;
    let path = first;
    if (renamed) {
      const second = fields[index];
      if (second === undefined) break;
      index += 1;
      path = second;
    }
    entries.push([normalizeFileStatus(code), path]);
  }
  return entries;
}

/**
 * `git diff [--cached] --numstat -z` → `(additions, deletions, path)`.
 *
 * Binary files are reported as `-\t-\t<path>`, which parses to `0 / 0`.
 * Renames put the paths in their own NUL fields and leave the inline path
 * empty.
 */
async function diffNumstat(
  repository: string,
  cached: boolean,
  pathspecs: readonly string[],
  execute: boolean,
  ignoreWhitespace: boolean,
): Promise<[number, number, string][]> {
  const args = diffArgs("--numstat", cached, pathspecs);
  if (ignoreWhitespace) {
    // Before the `--` separator, so it is read as an option and not a pathspec.
    args.splice(cached ? 2 : 1, 0, IGNORE_WHITESPACE);
  }
  const output = await gitText(repository, args, execute);
  const fields = output.split("\0").filter((field) => field !== "");
  const entries: [number, number, string][] = [];
  for (let index = 0; index < fields.length; ) {
    const record = fields[index] as string;
    index += 1;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    const additions = Number.parseInt(record.slice(0, firstTab), 10);
    const deletions = Number.parseInt(
      record.slice(firstTab + 1, secondTab),
      10,
    );
    const inline = secondTab < 0 ? "" : record.slice(secondTab + 1);
    let path: string;
    if (inline === "") {
      index += 1; // the origin path
      const destination = fields[index];
      if (destination === undefined) break;
      index += 1;
      path = destination;
    } else {
      path = inline;
    }
    entries.push([
      Number.isNaN(additions) ? 0 : additions,
      Number.isNaN(deletions) ? 0 : deletions,
      path,
    ]);
  }
  return entries;
}

function readUntrackedFile(
  workspaceRoot: string,
  repository: string,
  path: string,
): string {
  const candidate = join(repository, path);
  const info = lstatSync(candidate, { throwIfNoEntry: false });
  if (info === undefined) {
    throw badRequest("Untracked file cannot be inspected");
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw forbidden("Untracked symlinks and special files are not previewed");
  }
  if (info.size > MAX_UNTRACKED_PREVIEW) {
    throw badRequest("Untracked file is too large to preview");
  }
  let canonical: string;
  try {
    canonical = canonicalize(candidate);
  } catch {
    throw badRequest("Untracked file cannot be resolved");
  }
  if (!isInside(workspaceRoot, canonical) || !isInside(repository, canonical)) {
    throw forbidden("Untracked file is outside the authorized workspace");
  }
  const handle = openSync(canonical, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_UNTRACKED_PREVIEW));
    const read = readSync(handle, buffer, 0, buffer.byteLength, 0);
    const bytes = buffer.subarray(0, read);
    const text = bytes.toString("utf8");
    if (Buffer.from(text, "utf8").compare(bytes) !== 0) {
      throw badRequest("Untracked binary files are not previewed");
    }
    return text;
  } finally {
    closeSync(handle);
  }
}
