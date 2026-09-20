import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  canonicalDirectory,
  canonicalize,
  resolveInRoot,
  validDirectoryName,
} from "../../workspaces/roots";
import { DomainError } from "../../workspaces/support";
import {
  badRequest,
  conflict,
  forbidden,
  hasControlCharacter,
  notFound,
} from "../support";
import { parseWorktrees } from "./parse";
import {
  type Operation,
  RepositoryService,
  type RepositoryContext,
  repositoryId,
} from "./service";
import type {
  WorktreeBindingRequest,
  WorktreeBindingVerdict,
  WorktreeRecord,
} from "./types";

/**
 * Linked worktrees: listing them, verifying a Frame's binding, and preparing
 * the directories a new one may be created in.
 *
 * A port of the pre-merge implementation.
 */

export async function worktreeRecords(
  service: RepositoryService,
  context: RepositoryContext,
  signal?: AbortSignal,
): Promise<WorktreeRecord[]> {
  const output = await service.read(
    context.repository,
    ["worktree", "list", "--porcelain", "-z"],
    signal,
  );
  const records = parseWorktrees(output);
  for (const record of records) {
    let canonical: string;
    try {
      canonical = canonicalize(record.path);
    } catch {
      continue;
    }
    record.accessible =
      canonical === context.workspaceRoot ||
      canonical.startsWith(`${context.workspaceRoot}/`);
    if (record.accessible && !record.bare) {
      const status = await service.read(
        canonical,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
        ],
        signal,
      );
      record.dirty = status.length > 0;
    }
  }
  return records;
}

export async function worktrees(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
): Promise<WorktreeRecord[]> {
  service.requireExecutionGrant("Git worktree inspection");
  const context = await service.context(workspaceRoot, requested);
  return worktreeRecords(service, context);
}

/**
 * Whether a Frame's worktree binding still names a checkout of the repository
 * it claims.
 *
 * The path is resolved against the workspace root first and a path that escapes
 * it is refused, not reported: a directory outside the registered root is one
 * this workspace's grants never covered. Everything that can legitimately drift
 * — the checkout was removed, the branch was switched, the repository was
 * re-cloned — gets its own `code`, because each is a different repair.
 */
export async function verifyWorktreeBinding(
  service: RepositoryService,
  workspaceRoot: string,
  request: WorktreeBindingRequest,
): Promise<WorktreeBindingVerdict> {
  service.requireExecutionGrant("Git worktree binding check");
  const root = canonicalDirectory(workspaceRoot);
  const requested = request.worktreePath.trim();
  if (requested === "") {
    throw badRequest("A worktree binding names no path");
  }
  // Absolute and relative spellings both occur: a terminal's `cwd` is absolute
  // and the discovery record's `repositoryPath` is relative.
  let relativePath: string;
  if (isAbsolutePath(requested)) {
    let candidate: string;
    try {
      candidate = canonicalDirectory(requested);
    } catch {
      throw notFound("The bound worktree directory does not exist");
    }
    if (candidate !== root && !candidate.startsWith(`${root}/`)) {
      throw forbidden("The bound worktree is outside the workspace");
    }
    relativePath = relative(root, candidate).replace(/\\/g, "/");
  } else {
    relativePath = requested;
  }
  if (relativePath === "") relativePath = ".";
  const absolute = resolveInRoot(root, relativePath);

  let context: RepositoryContext;
  try {
    context = await service.context(root, relativePath);
  } catch (error) {
    // Not a repository any more, or the directory is gone. Both are the same
    // repair for the person looking at the badge.
    if (
      error instanceof DomainError &&
      (error.status === 400 || error.status === 404)
    ) {
      return {
        valid: false,
        code: "pathMissing",
        worktreePath: relativePath,
        absolutePath: absolute,
        repositoryId: "",
        branch: null,
        headOid: null,
        isMain: false,
        locked: false,
        prunable: false,
      };
    }
    throw error;
  }
  const id = repositoryId(context);
  const records = await worktreeRecords(service, context);
  // Git prints absolute paths; the binding may hold either spelling and may
  // have been written before a symlinked root was resolved. Both sides are
  // canonicalized before they are compared.
  let target: string;
  try {
    target = canonicalize(absolute);
  } catch {
    target = absolute;
  }
  const found = records.find((record) => {
    try {
      return canonicalize(record.path) === target;
    } catch {
      return record.path === target;
    }
  });
  if (found === undefined) {
    return {
      valid: false,
      code: "notAWorktree",
      worktreePath: relativePath,
      absolutePath: target,
      repositoryId: id,
      branch: null,
      headOid: null,
      isMain: false,
      locked: false,
      prunable: false,
    };
  }
  const code =
    request.repositoryId !== null && request.repositoryId !== id
      ? "repositoryMismatch"
      : request.branch !== null && found.branch !== request.branch
        ? "branchChanged"
        : "ok";
  return {
    valid: code === "ok",
    code,
    worktreePath: relativePath,
    absolutePath: target,
    repositoryId: id,
    branch: found.branch,
    headOid: found.headOid,
    isMain: found.isMain,
    locked: found.locked,
    prunable: found.prunable,
  };
}

/**
 * Where a new worktree may be created.
 *
 * The nearest existing ancestor is resolved and every new segment is validated,
 * but nothing is created here: request validation must not leave directories
 * behind when the request is then refused.
 */
export function newWorktreePath(
  context: RepositoryContext,
  requested: unknown,
): string {
  if (
    typeof requested !== "string" ||
    requested === "" ||
    requested.length > 4096 ||
    requested.includes("\0")
  ) {
    throw badRequest("Worktree path is invalid");
  }
  const candidate = isAbsolutePath(requested)
    ? requested
    : join(context.workspaceRoot, requested);
  if (candidate.split(/[/\\]/).includes("..")) {
    throw badRequest("Worktree path must not contain parent traversal");
  }
  if (lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) {
    throw conflict("Worktree destination already exists");
  }
  let ancestor = candidate;
  const missing: string[] = [];
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) {
    const name = basename(ancestor);
    if (name === "") {
      throw badRequest("Worktree path has no existing ancestor");
    }
    if (validDirectoryName(name) !== name) {
      throw badRequest("Worktree path must not have padded directory names");
    }
    missing.push(name);
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw badRequest("Worktree path has no existing ancestor");
    }
    ancestor = parent;
  }
  let target = canonicalDirectory(ancestor);
  if (
    target !== context.workspaceRoot &&
    !target.startsWith(`${context.workspaceRoot}/`)
  ) {
    throw forbidden("Worktree path is outside the workspace");
  }
  for (const segment of missing.reverse()) target = join(target, segment);
  if (
    target === context.commonDir ||
    target.startsWith(`${context.commonDir}/`)
  ) {
    throw forbidden(
      "Worktrees cannot be created inside Git administration directories",
    );
  }
  return target;
}

/**
 * The parent directories one worktree creation made, so a failure can remove
 * exactly those — never a partial checkout and never anything another process
 * added.
 */
export class CreatedParents {
  constructor(private readonly created: string[]) {}

  rollback(): void {
    for (const directory of [...this.created].reverse()) {
      try {
        rmdirSync(directory);
      } catch {
        // Only empty directories this invocation created are removable; a
        // non-empty one now holds something worth keeping.
      }
    }
  }
}

export function createWorktreeParents(
  context: RepositoryContext,
  target: string,
  operation: Operation,
): CreatedParents {
  const parent = dirname(target);
  if (parent === target) {
    throw badRequest("Worktree needs a parent directory");
  }
  if (
    parent !== context.workspaceRoot &&
    !parent.startsWith(`${context.workspaceRoot}/`)
  ) {
    throw forbidden("Worktree is outside the workspace");
  }
  const step = relative(context.workspaceRoot, parent);
  let cursor = context.workspaceRoot;
  const created: string[] = [];
  for (const part of step === "" ? [] : step.split(/[/\\]/)) {
    if (operation.controller.signal.aborted) {
      throw conflict("Worktree creation cancelled");
    }
    cursor = join(cursor, part);
    const info = lstatSync(cursor, { throwIfNoEntry: false });
    if (info === undefined) {
      operation.mutationStarted = true;
      mkdirSync(cursor, { mode: 0o700 });
      created.push(cursor);
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw forbidden("Worktree parent changed to a link or non-directory");
    }
  }
  return new CreatedParents(created);
}

/**
 * Register a nested checkout in the repository's private excludes, so a later
 * Stage All cannot stage a repository inside itself.
 */
export function protectNestedWorktree(
  context: RepositoryContext,
  repositoryRoot: string,
  target: string,
  operation: Operation,
): void {
  if (target !== repositoryRoot && !target.startsWith(`${repositoryRoot}/`)) {
    return;
  }
  const step = relative(repositoryRoot, target);
  if (step === "") return;
  let pattern = "/";
  const parts = step.split(/[/\\]/);
  parts.forEach((value, index) => {
    if (index > 0) pattern += "/";
    if (hasControlCharacter(value)) {
      throw badRequest(
        "Nested worktree paths cannot contain control characters",
      );
    }
    for (const character of value) {
      if ("\\*?[]!# ".includes(character)) pattern += "\\";
      pattern += character;
    }
  });
  pattern += "/";
  if (step.replace(/\\/g, "/").startsWith(".armadra/worktrees")) {
    pattern = "/.armadra/worktrees/";
  }
  if (operation.controller.signal.aborted) {
    throw conflict("Worktree creation cancelled");
  }
  const info = join(context.commonDir, "info");
  const infoStat = lstatSync(info, { throwIfNoEntry: false });
  if (infoStat === undefined) {
    operation.mutationStarted = true;
    mkdirSync(info);
  } else if (!infoStat.isDirectory() || infoStat.isSymbolicLink()) {
    throw forbidden("Git info directory must not be a link");
  }
  const exclude = join(info, "exclude");
  const excludeStat = lstatSync(exclude, { throwIfNoEntry: false });
  if (
    excludeStat !== undefined &&
    (!excludeStat.isFile() || excludeStat.isSymbolicLink())
  ) {
    throw forbidden("Git exclude must be a regular file");
  }
  let previous = "";
  if (excludeStat !== undefined) {
    if (excludeStat.size > 1_048_576) {
      throw conflict("Git exclude exceeds the editable size budget");
    }
    previous = readFileSync(exclude, "utf8");
  }
  if (previous.split("\n").includes(pattern)) return;
  operation.mutationStarted = true;
  // Appending preserves other writers' content; the leading newline also keeps
  // an unterminated original final line intact.
  appendFileSync(exclude, `\n${pattern}\n`, { mode: 0o600 });
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
