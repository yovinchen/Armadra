import { canonicalDirectory } from "../workspaces/roots";
import { LEGACY_PREFIX, runGit } from "./command";
import { gitOutput, gitText, repoContext, requireRepository } from "./context";
import { stagePaths } from "./stage";
import { badRequest, conflict, internalError, sanitize } from "./support";

/**
 * Reading HEAD, committing (including amend) and `git init`.
 *
 * A port of `apps/runtime/src/git/commit.rs`.
 */

export interface CommitResult {
  readonly commit: string;
  readonly committed: string[];
  readonly summary: string;
}

export interface HeadCommit {
  readonly oid: string;
  readonly subject: string;
  /** The full message; empty when `truncated`. */
  readonly message: string;
  readonly truncated: boolean;
  /** A remote-tracking ref contains this commit, so rewriting it is public. */
  readonly published: boolean;
}

export interface AmendRequest {
  readonly expectedHead: string;
  readonly allowPublished: boolean;
}

export interface InitResult {
  readonly repository: boolean;
  readonly branch: string | null;
  readonly path: string;
}

/** `HEAD` as the amend controls describe it, or `null` on an unborn branch. */
export async function headCommit(
  workspaceRoot: string,
  requested: string,
): Promise<HeadCommit | null> {
  const context = await requireRepository(workspaceRoot, requested);
  const resolved = await gitOutput(context.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD^{commit}",
  ]);
  if (resolved.status !== 0) return null;
  const oid = resolved.stdout.toString("utf8").trim();
  if (oid === "") return null;
  const raw = await gitText(context.repository, [
    "log",
    "-1",
    "--no-show-signature",
    "--format=%B",
    oid,
    "--",
  ]);
  // Trailing newlines are Git's own formatting, not part of the message.
  const message = raw.replace(/\n+$/, "");
  const truncated = Buffer.byteLength(message, "utf8") > 10_000;
  const containing = await gitText(context.repository, [
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    oid,
    "refs/remotes/",
  ]);
  return {
    oid,
    subject: message.split("\n")[0] ?? "",
    message: truncated ? "" : message,
    truncated,
    published: containing.trim() !== "",
  };
}

/**
 * `git commit [--amend] -m <message> [-- <paths>]`.
 *
 * With `paths` the listed files are staged first, through the same validation
 * as {@link stagePaths}, and the commit is scoped to them. `amend` rewrites
 * history and is therefore never implied: it needs the OID the caller
 * reviewed, and a commit any remote-tracking ref already contains
 * additionally needs an explicit acknowledgement. Nothing here force-pushes.
 */
export async function commit(
  workspaceRoot: string,
  requested: string,
  rawMessage: string,
  paths: readonly string[] | undefined,
  amend: AmendRequest | undefined,
): Promise<CommitResult> {
  const message = rawMessage.trim();
  if (
    message === "" ||
    Buffer.byteLength(message, "utf8") > 10_000 ||
    message.includes("\0")
  ) {
    throw badRequest("Commit message is invalid");
  }
  const context = await requireRepository(workspaceRoot, requested);
  if (amend !== undefined) {
    const current = await headCommit(workspaceRoot, requested);
    if (current === null) {
      throw conflict("There is no commit to amend on this branch");
    }
    if (current.oid !== amend.expectedHead) {
      throw conflict(
        "HEAD moved since the commit was reviewed; refresh before amending",
      );
    }
    if (current.published && !amend.allowPublished) {
      throw conflict(
        "This commit is already contained in a remote-tracking ref; amending rewrites published history and needs an explicit acknowledgement",
      );
    }
  }
  const committed =
    paths === undefined
      ? []
      : (await stagePaths(workspaceRoot, requested, paths)).staged;

  const args = ["commit"];
  if (amend !== undefined) args.push("--amend");
  args.push("-m", message);
  if (committed.length > 0) args.push("--", ...committed);
  const output = await runGit({
    cwd: context.repository,
    prefix: LEGACY_PREFIX,
    args,
    timeoutMs: 120_000,
  });
  if (output.status !== 0) {
    const stderr = output.stderr.toString("utf8").trim();
    const detail =
      stderr === "" ? output.stdout.toString("utf8").trim() : stderr;
    // "nothing to commit" is a user error, not a runtime failure — and git's
    // own wording for it is a screenful of porcelain (the whole untracked list
    // included), so it gets one sentence of ours instead.
    if (/nothing (added )?to commit|no changes added to commit/i.test(detail)) {
      throw badRequest("Nothing is staged to commit");
    }
    throw badRequest(`Git could not commit: ${sanitize(detail)}`);
  }
  const summary = output.stdout.toString("utf8").trim();
  const created = (
    await gitText(context.repository, ["rev-parse", "--short", "HEAD"])
  ).trim();
  if (amend !== undefined) {
    const current = (
      await gitText(context.repository, ["rev-parse", "--verify", "HEAD"])
    ).trim();
    if (current === amend.expectedHead) {
      throw conflict(
        "Git reported success but HEAD still points at the original commit; inspect the repository",
      );
    }
  }
  return { commit: created, committed, summary };
}

/**
 * `git init` for a workspace that does not belong to any repository yet.
 *
 * A directory that already resolves to a Git directory — its own, an
 * ancestor's, or a bare one — is refused instead of nested: a second
 * repository inside an existing checkout silently shadows the outer index.
 */
export async function initRepository(
  workspaceRoot: string,
): Promise<InitResult> {
  const root = canonicalDirectory(workspaceRoot);
  const existing = await gitOutput(root, ["rev-parse", "--absolute-git-dir"]);
  if (existing.status === 0) {
    throw conflict("The workspace already belongs to a Git repository");
  }
  const failure = existing.stderr.toString("utf8");
  if (!failure.includes("not a git repository")) {
    throw internalError(sanitize(failure));
  }
  await gitText(root, ["init"]);
  // Report the repository Git actually created, never the request's intent.
  const context = await repoContext(root, ".");
  if (context === undefined) {
    throw internalError("Git did not create a working repository here");
  }
  if (context.repository !== root) {
    throw internalError(
      "Git initialized a repository outside the workspace root",
    );
  }
  let branch: string | null = null;
  const symbolic = await gitOutput(context.repository, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (symbolic.status === 0) {
    const value = symbolic.stdout.toString("utf8").trim();
    branch = value === "" ? null : value;
  }
  return { repository: true, branch, path: context.repository };
}
