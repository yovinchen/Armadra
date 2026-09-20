import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { gitEnvironment, runGit } from "./command";
import type { RepositoryContext } from "./repository/service";
import type { RepositoryService } from "./repository/service";
import { splitNul } from "./repository/parse";
import {
  badRequest,
  conflict,
  forbidden,
  isDigest,
  redactSecrets,
} from "./support";

/**
 * One-hunk mutations, reconstructed from a freshly observed Git diff.
 *
 * A port of the pre-merge implementation. The load-bearing property is that
 * **client input never contains patch bytes**: a request names a file, a scope,
 * a digest of the diff it was looking at and the id of one hunk inside it, and
 * the patch that gets applied is rebuilt here from a diff taken under the
 * repository lock. A diff that moved is a refusal, not a fuzzy apply.
 */

const MAX_DIFF = 8 * 1024 * 1024;
const MAX_ERROR = 64 * 1024;
const MAX_HUNKS = 4096;
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

export type GitHunkScope = "worktree" | "staged";
export type GitHunkAction = "stage" | "unstage" | "revert";

export interface GitHunkMutation {
  readonly path: string;
  readonly file: string;
  readonly scope: GitHunkScope;
  readonly diffDigest: string;
  readonly hunkId: string;
  readonly action: GitHunkAction;
}

export interface GitHunk {
  readonly id: string;
  readonly header: string;
  readonly content: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface GitHunkDiff {
  file: string;
  scope: GitHunkScope;
  diffDigest: string;
  supported: boolean;
  unsupportedReason: string | null;
  hunks: GitHunk[];
}

export interface GitHunkResult {
  readonly applied: boolean;
  readonly file: string;
  readonly scope: GitHunkScope;
  readonly action: GitHunkAction;
  readonly hunkId: string;
}

interface Observed {
  readonly diff: GitHunkDiff;
  readonly prefix: string;
}

export async function readHunks(
  service: RepositoryService,
  workspaceRoot: string,
  checkout: string,
  file: string,
  scope: GitHunkScope,
): Promise<GitHunkDiff> {
  return service.withGuard(workspaceRoot, checkout, async (guard) => {
    return (await observe(guard.context, file, scope)).diff;
  });
}

/**
 * Apply, unapply or revert one hunk.
 *
 * The diff is observed, checked with `git apply --check`, **observed again**
 * and only then applied. The second read is what covers an editor: an editor
 * is not a Git writer and does not take the repository lock, so an edit made
 * during the check has to invalidate the observation before anything lands.
 */
export async function applyHunk(
  service: RepositoryService,
  workspaceRoot: string,
  request: GitHunkMutation,
): Promise<GitHunkResult> {
  return service.withGuard(workspaceRoot, request.path, async (guard) => {
    const valid =
      (request.scope === "worktree" &&
        (request.action === "stage" || request.action === "revert")) ||
      (request.scope === "staged" && request.action === "unstage");
    if (!valid || !isDigest(request.diffDigest) || !isDigest(request.hunkId)) {
      throw badRequest("Hunk action, scope or identity is invalid");
    }
    const observed = await observe(guard.context, request.file, request.scope);
    if (!observed.diff.supported) {
      // `notTrackedModification` is not a property of the file — it means the
      // change the caller is holding is gone from this scope (already staged,
      // reverted, or moved by someone else). Answering "this file does not
      // support hunks" there sends the user looking for a capability problem
      // that does not exist; the honest answer is the same one a changed
      // digest gets, which the panel already knows how to recover from.
      if (observed.diff.unsupportedReason === "notTrackedModification") {
        throw stale();
      }
      throw badRequest("This file does not support individual hunk operations");
    }
    if (observed.diff.diffDigest !== request.diffDigest) throw stale();
    const hunk = observed.diff.hunks.find(
      (candidate) => candidate.id === request.hunkId,
    );
    if (hunk === undefined) throw stale();
    const patch = `${observed.prefix}${hunk.header}\n${hunk.content}`;
    const args = ["apply", "--whitespace=nowarn"];
    if (request.action !== "revert") args.push("--cached");
    if (request.action !== "stage") args.push("--reverse");
    await hunkGit(
      guard.context.repository,
      [...args, "--check", "-"],
      Buffer.from(patch, "utf8"),
    );
    const rechecked = await observe(guard.context, request.file, request.scope);
    if (
      !rechecked.diff.supported ||
      rechecked.diff.diffDigest !== request.diffDigest
    ) {
      throw stale();
    }
    await hunkGit(
      guard.context.repository,
      [...args, "-"],
      Buffer.from(patch, "utf8"),
    );
    return {
      applied: true,
      file: request.file,
      scope: request.scope,
      action: request.action,
      hunkId: request.hunkId,
    };
  });
}

async function observe(
  context: RepositoryContext,
  rawFile: string,
  scope: GitHunkScope,
): Promise<Observed> {
  const file = safeFile(context, rawFile);
  const diff: GitHunkDiff = {
    file: rawFile,
    scope,
    diffDigest: "",
    supported: false,
    unsupportedReason: null,
    hunks: [],
  };
  if (!file.startsWith(`${context.repository}/`)) {
    throw badRequest("File is outside the Git repository");
  }
  const relative = file
    .slice(context.repository.length + 1)
    .replace(/\\/g, "/");
  // Refuse clean/smudge and working-tree encoding conversions before Git reads
  // content: their representation may not match an apply-able patch.
  const attributes = await hunkGit(context.repository, [
    "check-attr",
    "-z",
    "filter",
    "working-tree-encoding",
    "--",
    relative,
  ]);
  if (attributes.length === 0 || attributes[attributes.length - 1] !== 0) {
    throw badRequest("Malformed Git attribute response");
  }
  const attributeFields = splitNul(attributes.subarray(0, -1));
  if (attributeFields.length % 3 !== 0) {
    throw badRequest("Malformed Git attribute response");
  }
  for (let index = 2; index < attributeFields.length; index += 3) {
    const value = (attributeFields[index] as Buffer).toString("utf8");
    if (value !== "unspecified" && value !== "unset") {
      return unsupported(diff, "filter");
    }
  }
  const rawArgs = [
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
  ];
  if (scope === "staged") rawArgs.push("--cached");
  rawArgs.push("--", relative);
  const raw = await hunkGit(context.repository, rawArgs);
  if (raw.length === 0) return unsupported(diff, "notTrackedModification");
  const records = splitNul(raw).filter((field) => field.length > 0);
  if (records.length !== 2 || records[1]?.toString("utf8") !== relative) {
    return unsupported(diff, "unsupportedPatch");
  }
  const fields = (records[0] as Buffer)
    .toString("utf8")
    .split(/\s+/)
    .filter((field) => field !== "");
  if (fields.length !== 5) return unsupported(diff, "unsupportedPatch");
  if (fields[4] !== "M") return unsupported(diff, "notTrackedModification");
  if ((fields[0] as string).replace(/^:+/, "") !== fields[1]) {
    return unsupported(diff, "modeChange");
  }
  if (fields[1] !== "100644" && fields[1] !== "100755") {
    return unsupported(diff, "notRegularFile");
  }
  const args = [
    "diff",
    "--patch",
    "--full-index",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--unified=3",
    "--inter-hunk-context=0",
  ];
  if (scope === "staged") args.push("--cached");
  args.push("--", relative);
  const bytes = await hunkGit(context.repository, args);
  if (bytes.includes(0)) return unsupported(diff, "binary");
  const patch = bytes.toString("utf8");
  if (Buffer.compare(Buffer.from(patch, "utf8"), bytes) !== 0) {
    return unsupported(diff, "nonUtf8");
  }
  const head = await hunkGit(context.repository, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const branch = await hunkGit(context.repository, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const digest = createHash("sha256");
  for (const part of [
    Buffer.from(context.repository, "utf8"),
    Buffer.from(rawFile, "utf8"),
    Buffer.from(scope === "staged" ? "staged" : "worktree", "utf8"),
    head,
    branch,
    bytes,
  ]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.byteLength));
    digest.update(length);
    digest.update(part);
  }
  diff.diffDigest = digest.digest("hex");
  const parsed = parsePatch(patch, diff.diffDigest);
  if (parsed === undefined) {
    return unsupported(
      diff,
      patch.includes("Binary files ") || patch.includes("GIT binary patch")
        ? "binary"
        : "unsupportedPatch",
    );
  }
  if (parsed.hunks.length === 0) {
    return unsupported(diff, "notTrackedModification");
  }
  diff.supported = true;
  diff.hunks = parsed.hunks;
  return { diff, prefix: parsed.prefix };
}

/**
 * Even an unsupported result has a stable display identity; it can never
 * authorize a write, because {@link applyHunk} rechecks `supported` itself.
 */
function unsupported(diff: GitHunkDiff, reason: string): Observed {
  if (diff.diffDigest === "") {
    diff.diffDigest = createHash("sha256")
      .update(`${diff.file}:${scopeDebug(diff.scope)}:${reason}`)
      .digest("hex");
  }
  diff.unsupportedReason = reason;
  return { diff, prefix: "" };
}

/** The Rust enum's `{:?}` spelling, which the digest is defined over. */
function scopeDebug(scope: GitHunkScope): string {
  return scope === "staged" ? "Staged" : "Worktree";
}

/**
 * Resolve one file inside the checkout the guard opened.
 *
 * The path is **repository-relative**, which is how every other Git read spells
 * a file and how the change tree already addresses one.
 */
function safeFile(context: RepositoryContext, raw: string): string {
  if (
    raw === "" ||
    raw.length > 4096 ||
    raw.includes("\\") ||
    hasControl(raw) ||
    raw
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          part.includes(":"),
      )
  ) {
    throw badRequest("File must be a safe repository-relative path");
  }
  let current = context.repository;
  for (const part of raw.split("/")) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info === undefined) continue;
    if (info.isSymbolicLink()) {
      throw forbidden("Git hunk paths must not traverse symlinks");
    }
  }
  if (!current.startsWith(`${context.repository}/`)) {
    throw forbidden("File is outside the Git repository");
  }
  const info = lstatSync(current, { throwIfNoEntry: false });
  if (info !== undefined && !info.isFile()) {
    throw badRequest("Git hunks require a regular file");
  }
  return current;
}

function parsePatch(
  patch: string,
  digest: string,
): { prefix: string; hunks: GitHunk[] } | undefined {
  const lines = patch.split(/(?<=\n)/);
  if (!(lines[0] ?? "").startsWith("diff --git ")) return undefined;
  const first = lines.findIndex((line) => line.startsWith("@@ "));
  if (first < 0) return undefined;
  const head = lines.slice(0, first);
  const prefix = head.join("");
  if (
    head.some(
      (line, index) =>
        index > 0 &&
        !(
          line.startsWith("index ") ||
          line.startsWith("--- ") ||
          line.startsWith("+++ ")
        ),
    )
  ) {
    return undefined;
  }
  if (
    !head.some(
      (line) => line.startsWith("--- a/") || line.startsWith('--- "a/'),
    ) ||
    !head.some(
      (line) => line.startsWith("+++ b/") || line.startsWith('+++ "b/'),
    )
  ) {
    return undefined;
  }
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("@@ ")) starts.push(index);
  });
  if (starts.length > MAX_HUNKS) return undefined;
  starts.push(lines.length);
  const hunks: GitHunk[] = [];
  for (let index = 0; index + 1 < starts.length; index += 1) {
    const start = starts[index] as number;
    const end = starts[index + 1] as number;
    const header = (lines[start] as string).replace(/\n$/, "");
    if (header === lines[start]) return undefined;
    const captures = HEADER.exec(header);
    if (captures === null) return undefined;
    const oldStart = Number.parseInt(captures[1] as string, 10);
    const oldLines =
      captures[2] === undefined ? 1 : Number.parseInt(captures[2], 10);
    const newStart = Number.parseInt(captures[3] as string, 10);
    const newLines =
      captures[4] === undefined ? 1 : Number.parseInt(captures[4], 10);
    const body = lines.slice(start + 1, end);
    let oldCount = 0;
    let newCount = 0;
    for (const line of body) {
      const marker = line[0];
      if (marker === " ") {
        oldCount += 1;
        newCount += 1;
      } else if (marker === "-") {
        oldCount += 1;
      } else if (marker === "+") {
        newCount += 1;
      } else if (marker === "\\" && line === "\\ No newline at end of file\n") {
        // Git's own marker line; it counts for neither side.
      } else {
        return undefined;
      }
    }
    if (oldCount !== oldLines || newCount !== newLines) return undefined;
    const content = body.join("");
    hunks.push({
      id: createHash("sha256")
        .update(`${digest}\0${header}\n${content}`)
        .digest("hex"),
      header,
      content,
      oldStart,
      oldLines,
      newStart,
      newLines,
    });
  }
  return { prefix, hunks };
}

/**
 * The hunk reader's own Git invocation.
 *
 * It is not the repository service's: this one pins the diff algorithm and the
 * blank-line handling, because the patch it produces has to be byte-identical
 * to the patch it later applies, and `core.quotepath=true` because a quoted
 * path in the patch header is what `git apply` expects to read back.
 */
async function hunkGit(
  directory: string,
  args: readonly string[],
  input?: Buffer,
): Promise<Buffer> {
  const output = await runGit({
    cwd: directory,
    prefix: [
      "--no-pager",
      "--literal-pathspecs",
      "-c",
      "color.ui=false",
      "-c",
      "core.quotepath=true",
      "-c",
      "apply.ignoreWhitespace=no",
      "-c",
      "apply.whitespace=nowarn",
      "-c",
      "diff.algorithm=myers",
      "-c",
      "diff.suppressBlankEmpty=false",
      "-c",
      "core.fsmonitor=false",
    ],
    args,
    timeoutMs: 15_000,
    stdoutLimit: MAX_DIFF,
    stderrLimit: MAX_ERROR,
    ...(input === undefined ? {} : { input }),
  });
  if (output.status !== 0) {
    throw conflict(
      `Git hunk operation failed: ${redactSecrets(
        output.stderr.toString("utf8"),
      ).slice(0, 2000)}`,
    );
  }
  return output.stdout;
}

function stale(): Error {
  return conflict("The file diff changed; reload its hunks before operating");
}

function hasControl(value: string): boolean {
  return CONTROL.test(value);
}

const CONTROL = /[\u0000-\u001f\u007f]/;

export { gitEnvironment };
