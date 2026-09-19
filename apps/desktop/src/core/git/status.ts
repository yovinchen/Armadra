import { DomainError } from "../workspaces/support";
import { gitText, repoContext, validPathspecs } from "./context";
import { nowRfc3339 } from "./support";
import { badRequest } from "./support";

/**
 * Porcelain status parsing and the repository status summary.
 *
 * A port of `apps/runtime/src/git/status.rs`.
 */

export interface GitFileStatus {
  readonly path: string;
  /** Normalized to `M` / `A` / `D` / `R` / `?`. */
  readonly status: string;
  /** `X` of the porcelain `XY` pair: the index differs from HEAD. */
  readonly staged: boolean;
  /** `Y` of the pair: the working tree differs from the index. */
  readonly unstaged: boolean;
  /** Where a renamed or copied entry came from; `null` otherwise. */
  readonly originPath: string | null;
}

export interface GitStatus {
  readonly repository: boolean;
  readonly branch: string | null;
  readonly changedCount: number;
  readonly ahead?: number;
  readonly behind?: number;
  readonly files: GitFileStatus[];
}

/** Normalize a porcelain status code to the `M/A/D/R/?` set the UI renders. */
export function normalizeFileStatus(raw: string): string {
  const code = raw.trim();
  if (code.startsWith("?")) return "?";
  for (const character of code) {
    if (character === "R") return "R";
    if (character === "A" || character === "C") return "A";
    if (character === "D") return "D";
    if (character === "M" || character === "T" || character === "U") return "M";
  }
  return "?";
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * Each record is `XY <path>`, NUL-terminated; for renames and copies the origin
 * path follows as its own NUL-terminated field. The extra field is consumed
 * whether or not the entry survives — leave it in and the *next* record is read
 * as a status line.
 */
export function parsePorcelainZ(output: string): GitFileStatus[] {
  const fields = output.split("\0");
  const entries: GitFileStatus[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index] as string;
    if (record.length < 4) continue;
    const indexCode = record[0] as string;
    const worktreeCode = record[1] as string;
    const path = record.slice(3);
    let originPath: string | null = null;
    if (
      indexCode === "R" ||
      indexCode === "C" ||
      worktreeCode === "R" ||
      worktreeCode === "C"
    ) {
      index += 1;
      const origin = fields[index];
      originPath = origin === undefined || origin === "" ? null : origin;
    }
    // `!!` only appears with --ignored, which is never passed; skip it anyway
    // so an ignored file can never be rendered as a change.
    if (indexCode === "!" || worktreeCode === "!") continue;
    entries.push({
      status: normalizeFileStatus(record.slice(0, 2)),
      path,
      staged: indexCode !== " " && indexCode !== "?",
      unstaged: worktreeCode !== " ",
      originPath,
    });
  }
  return entries;
}

export async function statusEntries(
  repository: string,
  pathspecs: readonly string[],
): Promise<GitFileStatus[]> {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  if (pathspecs.length > 0) args.push("--", ...pathspecs);
  return parsePorcelainZ(await gitText(repository, args));
}

/**
 * The number of changed entries in a checkout, for repository discovery.
 *
 * `undefined` whenever Git cannot answer — a repository mid-rebase, a broken
 * filter, a checkout that vanished — because an unknown count is a normal
 * answer for a list of repositories and a wrong one is not.
 */
export async function dirtyEntryCount(
  checkout: string,
): Promise<number | undefined> {
  try {
    const output = await gitText(checkout, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ]);
    return output.split("\0").filter((entry) => entry.trim() !== "").length;
  } catch {
    return undefined;
  }
}

/**
 * `git status --porcelain=v2 --branch`, summarized for the top bar.
 *
 * A pure function so the synchronous handoff fingerprint can reuse it: the
 * digest that fingerprint takes is over the same record this produces, and two
 * parsers would be two records.
 */
export function summarizeStatus(output: string): {
  branch: string | null;
  ahead: number | undefined;
  behind: number | undefined;
  changedCount: number;
} {
  let branch: string | null = null;
  let ahead: number | undefined;
  let behind: number | undefined;
  let changedCount = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("# ")) {
      const header = line.slice(2);
      if (header.startsWith("branch.head ")) {
        const head = header.slice("branch.head ".length).trim();
        branch = head === "(detached)" ? null : head;
      } else if (header.startsWith("branch.ab ")) {
        for (const token of header.slice("branch.ab ".length).split(/\s+/)) {
          const value = Number.parseInt(token.slice(1), 10);
          if (Number.isNaN(value)) continue;
          if (token.startsWith("+")) ahead = value;
          else if (token.startsWith("-")) behind = value;
        }
      }
      continue;
    }
    if (/^[12u?]/.test(line)) changedCount += 1;
  }
  return { branch, ahead, behind, changedCount };
}

export async function readStatus(workspaceRoot: string): Promise<GitStatus> {
  return readStatusFiltered(workspaceRoot, ".", []);
}

export async function readStatusAt(
  workspaceRoot: string,
  requested: string,
): Promise<GitStatus> {
  return readStatusFiltered(workspaceRoot, requested, []);
}

/**
 * `readStatusAt` narrowed to a pathspec list.
 *
 * The filter is applied by Git to **both** passes — the summary and the
 * per-file rows — so `changedCount` and `files` describe the same set. The
 * branch, ahead and behind numbers are deliberately not narrowed: they are
 * facts about the checkout, and a pathspec does not change how far ahead of its
 * upstream a branch is.
 */
export async function readStatusFiltered(
  workspaceRoot: string,
  requested: string,
  pathspecs: readonly string[],
): Promise<GitStatus> {
  const context = await repoContext(workspaceRoot, requested);
  if (context === undefined) {
    return {
      repository: false,
      branch: null,
      changedCount: 0,
      files: [],
    };
  }
  const prepared = validPathspecs(pathspecs);
  const summary = [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all",
  ];
  if (prepared.length > 0) summary.push("--", ...prepared);
  const { branch, ahead, behind, changedCount } = summarizeStatus(
    await gitText(context.repository, summary),
  );
  return {
    repository: true,
    branch,
    changedCount,
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    files: await statusEntries(context.repository, prepared),
  };
}

/* ------------------------------ batch status ------------------------------ */

export interface StatusBatchRequest {
  readonly paths: readonly string[];
  readonly pathspecs: readonly string[];
}

export interface StatusBatchEntry {
  readonly path: string;
  readonly status?: GitStatus;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface StatusBatchResponse {
  readonly repositories: StatusBatchEntry[];
  readonly observedAt: string;
}

const MAX_STATUS_BATCH = 64;

/**
 * Several checkouts' status in one request.
 *
 * A repository that could not be read is reported as that repository's failure
 * rather than losing the whole batch: one broken checkout in a workspace of
 * twelve must not blank the other eleven.
 */
export async function readStatusBatch(
  workspaceRoot: string,
  request: StatusBatchRequest,
): Promise<StatusBatchResponse> {
  if (request.paths.length === 0 || request.paths.length > MAX_STATUS_BATCH) {
    throw badRequest("Between one and 64 repositories may be read at once");
  }
  // Validated once, before any Git runs: a malformed filter is the caller's
  // mistake for the whole request, not twelve identical per-repository ones.
  validPathspecs(request.pathspecs);
  const repositories: StatusBatchEntry[] = [];
  const seen = new Set<string>();
  for (const path of request.paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      repositories.push({
        path,
        status: await readStatusFiltered(
          workspaceRoot,
          path,
          request.pathspecs,
        ),
      });
    } catch (error) {
      const failure =
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : {
              code: "internal_error",
              message: error instanceof Error ? error.message : String(error),
            };
      repositories.push({ path, error: failure });
    }
  }
  return { repositories, observedAt: nowRfc3339() };
}
