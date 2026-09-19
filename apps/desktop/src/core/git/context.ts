import { existsSync, statSync } from "node:fs";
import { relative } from "node:path";
import {
  canonicalDirectory,
  canonicalize,
  resolveInRoot,
  workspaceRelativePath,
} from "../workspaces/roots";
import { gitArguments } from "./access";
import {
  LEGACY_PREFIX,
  type CommandOutput,
  commandFailure,
  runGit,
} from "./command";
import {
  badRequest,
  forbidden,
  internalError,
  notFound,
  sanitize,
} from "./support";

/**
 * Which repository a request is about, and the two helpers every read on the
 * legacy Git surface runs its commands through.
 *
 * A port of the free functions at the top of `apps/runtime/src/git/mod.rs`.
 * The repository service keeps its own, richer context (it also needs the
 * common directory, which is the queue key); this one is what `status`,
 * `diff`, `stage`, `commit` and the hunk reader share.
 */

const COMMAND_TIMEOUT_MS = 30_000;
export const MAX_PATHS_PER_REQUEST = 200;
/** Display-only; never used on a path that gets staged or applied. */
export const IGNORE_WHITESPACE = "--ignore-all-space";

export interface RepoContext {
  /** The authorized workspace root, canonical. */
  readonly workspaceRoot: string;
  /** The Git repository root, guaranteed to live inside the workspace root. */
  readonly repository: string;
  /** The requested directory, relative to the repository. */
  readonly pathspec: string;
}

/** `git(...)`: run one command and return its stdout, or throw on failure. */
export async function gitText(
  directory: string,
  args: readonly string[],
  execute = true,
): Promise<string> {
  const output = await gitOutput(directory, args, execute);
  if (output.status !== 0) throw commandFailure(output);
  return output.stdout.toString("utf8");
}

/** The same, but the caller reads the exit status itself. */
export async function gitOutput(
  directory: string,
  args: readonly string[],
  execute = true,
): Promise<CommandOutput> {
  return runGit({
    cwd: directory,
    prefix: LEGACY_PREFIX,
    args: gitArguments(args, execute),
    timeoutMs: COMMAND_TIMEOUT_MS,
    environment: { restrict: !execute },
  });
}

/**
 * The repository that owns `requested` — a workspace-relative directory, `.`
 * for the workspace root.
 *
 * `undefined` means the directory belongs to no repository, which is a normal
 * answer: the drawer offers `git init` on it. A repository whose root sits
 * outside the authorized workspace is refused instead, because answering about
 * it would be this service deciding what it may look at.
 */
export async function repoContext(
  workspaceRoot: string,
  requested: string,
  execute = true,
): Promise<RepoContext | undefined> {
  const root = canonicalDirectory(workspaceRoot);
  const directory = resolveInRoot(root, requested);
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw badRequest("Git path must be a directory");
  }
  const inside = await gitOutput(
    directory,
    ["rev-parse", "--is-inside-work-tree"],
    execute,
  );
  if (inside.status !== 0) {
    const error = inside.stderr.toString("utf8");
    if (error.includes("not a git repository")) return undefined;
    throw internalError(sanitize(error));
  }
  if (inside.stdout.toString("utf8").trim() !== "true") return undefined;
  const top = await gitText(
    directory,
    ["rev-parse", "--show-toplevel"],
    execute,
  );
  let repository: string;
  try {
    repository = canonicalize(top.replace(/\n$/, ""));
  } catch {
    throw internalError("Git repository root cannot be resolved");
  }
  if (repository !== root && !isInside(root, repository)) {
    throw forbidden("Git repository root is outside the authorized workspace");
  }
  const pathspec = relative(repository, directory).replace(/\\/g, "/");
  return { workspaceRoot: root, repository, pathspec };
}

export async function requireRepository(
  workspaceRoot: string,
  requested: string,
): Promise<RepoContext> {
  const context = await repoContext(workspaceRoot, requested);
  if (context === undefined) {
    throw badRequest("The workspace is not a Git repository");
  }
  return context;
}

export function isInside(parent: string, path: string): boolean {
  if (path === parent) return true;
  const step = relative(parent, path);
  return step !== "" && !step.startsWith("..") && step !== path;
}

/**
 * The pathspec list a read may narrow itself with.
 *
 * It is a *filter*, so unlike {@link preparePaths} nothing here has to exist: a
 * panel narrowing its Changes list to a directory that was just deleted is
 * asking a legitimate question with an empty answer. What is refused is a
 * spelling that would stop being a path.
 */
export function validPathspecs(paths: readonly string[]): string[] {
  if (paths.length > MAX_PATHS_PER_REQUEST) {
    throw badRequest("At most 200 pathspecs may be supplied");
  }
  const prepared: string[] = [];
  for (const requested of paths) {
    const value = requested.trim();
    if (value === "") continue;
    if (value.startsWith("-")) {
      throw badRequest("A pathspec must not start with a dash");
    }
    prepared.push(workspaceRelativePath(value));
  }
  return prepared;
}

/**
 * Paths a write is about: relative spelling plus the absolute path on disk.
 *
 * Absolute paths, `..` traversal and paths whose closest existing ancestor
 * resolves outside the authorized workspace (a symlinked directory) are all
 * refused here rather than by Git.
 */
export function preparePaths(
  context: RepoContext,
  paths: readonly string[],
): { relative: string; absolute: string }[] {
  if (paths.length === 0 || paths.length > MAX_PATHS_PER_REQUEST) {
    throw badRequest("Between one and 200 paths must be supplied");
  }
  const prepared: { relative: string; absolute: string }[] = [];
  for (const requested of paths) {
    const relativePath = workspaceRelativePath(requested);
    const absolute = `${context.repository}/${relativePath}`;
    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = existing.slice(0, existing.lastIndexOf("/"));
      if (parent === "" || parent === existing) break;
      existing = parent;
    }
    let canonical: string;
    try {
      canonical = canonicalize(existing);
    } catch {
      throw notFound("Requested path does not exist");
    }
    if (
      !isInside(context.workspaceRoot, canonical) ||
      !isInside(context.repository, canonical)
    ) {
      throw forbidden("Requested path is outside the authorized workspace");
    }
    prepared.push({ relative: relativePath, absolute });
  }
  return prepared;
}

/** `git ls-files -- <path>` — whether Git knows this path at all. */
export async function isTracked(
  context: RepoContext,
  path: string,
): Promise<boolean> {
  const output = await gitText(context.repository, ["ls-files", "--", path]);
  return output.trim() !== "";
}
