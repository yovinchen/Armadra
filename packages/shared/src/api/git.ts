import { z } from "zod";

import { diffScopeSchema } from "../domain/index.js";

export const diffFileStatusSchema = z.enum(["M", "A", "D", "R", "?"]);

/**
 * One row of `git status --porcelain=v1 -z`: `staged` is the `X` column (index
 * vs HEAD), `unstaged` the `Y` column (working tree vs index). Both can be true
 * for a file edited again after staging.
 *
 * This is the only source for the file-tree badges — they must not fetch a
 * diff, which is orders of magnitude more expensive.
 */
export const gitFileStatusSchema = z.object({
  path: z.string(),
  status: diffFileStatusSchema,
  staged: z.boolean(),
  unstaged: z.boolean(),
  /**
   * Where a renamed or copied entry came from; `null` for every other status.
   *
   * Nullish rather than required: a Runtime older than this version omits the
   * key, and a change tree that throws on the whole status because one row
   * predates a field is worse than one row without an arrow.
   */
  originPath: z.string().nullish().default(null),
});

export const gitStatusSchema = z.object({
  repository: z.boolean(),
  branch: z.string().nullable(),
  changedCount: z.number().int().nonnegative(),
  // `null` is meaningful here (detached HEAD / no upstream => distance unknown)
  // and it is also what serde emits for `Option::None`, so accept both null and
  // an omitted key rather than making every git-status fetch throw.
  ahead: z.number().int().nonnegative().nullish(),
  behind: z.number().int().nonnegative().nullish(),
  /** Absent on runtimes older than this version, hence the default. */
  files: z.array(gitFileStatusSchema).default([]),
});

export const gitFileDiffSchema = z.object({
  path: z.string(),
  status: diffFileStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
  // false = binary/oversized file listed without a textual patch; `patch` is
  // empty and must be skipped when exporting a unified diff.
  previewable: z.boolean().default(true),
  /** The patch is `git diff --cached`, i.e. it came from the `staged` scope. */
  staged: z.boolean().default(false),
});

/** Query for `GET /api/workspaces/{id}/git/diff`. */
export const gitDiffRequestSchema = z.object({
  /** Directory the diff is scoped to; the repository root by default. */
  path: z.string().min(1).max(4_000).optional(),
  scope: diffScopeSchema.default("worktree"),
  /** When present only these files are diffed, `path` is ignored. */
  paths: z.array(z.string().min(1).max(4_000)).max(200).optional(),
  /**
   * Display option (`--ignore-all-space`): whitespace-only differences drop
   * out of the patch and its line counts. The file list is unaffected, so a
   * whitespace-only edit still shows up — with an empty patch and 0/0. Nothing
   * is ever staged, applied, or committed from a whitespace-ignoring diff.
   */
  ignoreWhitespace: z.boolean().default(false),
});

export const gitDiffSchema = z.object({
  repository: z.boolean(),
  clean: z.boolean(),
  files: z.array(gitFileDiffSchema),
});

/**
 * `POST /api/workspaces/{id}/git/init` — only offered once a read reported
 * `repository: false`. A workspace that already belongs to any repository is
 * refused rather than nested, so this response always describes a new one.
 */
export const gitInitResponseSchema = z.object({
  repository: z.literal(true),
  /** The unborn branch Git selected; null when it left HEAD detached. */
  branch: z.string().nullable(),
  path: z.string(),
});

export const gitPathsRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

/**
 * Which version a restore takes a tracked file back to. `index` keeps the
 * staged change and drops only the unstaged edit on top of it; `head` also
 * discards the staged change and unstages the file. They lose different work,
 * so the UI offers them as two separate actions rather than one “revert”.
 */
export const gitRestoreSourceSchema = z.enum(["index", "head"]);

/**
 * `POST /api/workspaces/{id}/git/resolve` — stage a conflicted path. Saving a
 * merged file never marks it resolved on its own; the service re-reads the
 * file and refuses while any Git conflict marker is still in it.
 */
export const gitResolveResponseSchema = z.object({
  resolved: z.array(z.string()),
});

export const gitRevertRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  source: gitRestoreSourceSchema.default("index"),
});

export const gitStageResponseSchema = z.object({
  staged: z.array(z.string()),
});

export const gitRevertResponseSchema = z.object({
  reverted: z.array(z.string()),
});

/**
 * `POST /api/workspaces/{id}/git/unstage` — `git restore --staged`. The working
 * tree is untouched, so this is not a destructive action and needs no
 * confirmation dialog (unlike revert).
 */
export const gitUnstageResponseSchema = z.object({
  unstaged: z.array(z.string()),
});

/**
 * `GET /api/workspaces/{id}/git/head-commit` — the commit an amend would
 * rewrite, or null on an unborn branch. `published` means a remote-tracking
 * ref already contains it, so rewriting it rewrites shared history.
 */
export const gitHeadCommitSchema = z
  .object({
    oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    subject: z.string(),
    /** Full message so an amend can start from it; empty when truncated. */
    message: z.string(),
    /** The stored message is too large to resend; amending is refused. */
    truncated: z.boolean(),
    published: z.boolean(),
  })
  .nullable();

export const gitCommitRequestSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  /** When present only these paths are committed (they are staged first). */
  paths: z.array(z.string().min(1)).max(200).optional(),
  /**
   * Rewriting the current commit. Never implied: the composer sends the OID
   * it displayed, and a published commit additionally needs the explicit
   * acknowledgement. An amend never pushes anything.
   */
  amend: z
    .object({
      expectedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
      allowPublished: z.boolean(),
    })
    .strict()
    .optional(),
});

export const gitCommitResponseSchema = z.object({
  commit: z.string(),
  committed: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;
export type GitDiff = z.infer<typeof gitDiffSchema>;
export type GitDiffRequest = z.infer<typeof gitDiffRequestSchema>;
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>;
export type GitUnstageResponse = z.infer<typeof gitUnstageResponseSchema>;
export type GitInitResponse = z.infer<typeof gitInitResponseSchema>;
export type GitHeadCommit = z.infer<typeof gitHeadCommitSchema>;
export type GitRestoreSource = z.infer<typeof gitRestoreSourceSchema>;
export type GitResolveResponse = z.infer<typeof gitResolveResponseSchema>;
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;
export type GitCommitResponse = z.infer<typeof gitCommitResponseSchema>;
