import { z } from "zod";

/**
 * `GET /api/workspaces/{id}/file-index?query=&limit=` — 快速打开.
 *
 * A fuzzy filename match with build folders skipped. `truncated` says the list
 * was cut: either more files matched than `limit`, or the walk hit its own
 * ceiling. The client shows that rather than implying a complete answer.
 */
export const fileIndexEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
});

export const fileIndexSchema = z.object({
  entries: z.array(fileIndexEntrySchema),
  truncated: z.boolean(),
  scanned: z.number().int().nonnegative(),
});

/** `POST /api/workspaces/{id}/file-search` — 项目搜索. */
export const fileSearchRequestSchema = z.object({
  query: z.string().min(1).max(1_000),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  /** Comma-separated globs; empty means every file. */
  include: z.string().max(500).optional(),
  exclude: z.string().max(500).optional(),
  maxMatchesPerFile: z.number().int().positive().optional(),
  /** How many *files* one page carries. */
  limit: z.number().int().positive().optional(),
  /** `nextOffset` from the previous page. */
  offset: z.number().int().nonnegative().optional(),
});

export const fileSearchMatchSchema = z.object({
  /** 1-based, ready for “open at line”. */
  line: z.number().int().positive(),
  /** 1-based, counted in characters. */
  column: z.number().int().positive(),
  length: z.number().int().nonnegative(),
  preview: z.string(),
  previewTruncated: z.boolean(),
});

export const fileSearchFileSchema = z.object({
  path: z.string(),
  matches: z.array(fileSearchMatchSchema),
  /** The file had more matches than the per-file ceiling allowed. */
  truncated: z.boolean(),
});

export const fileSearchResultSchema = z.object({
  files: z.array(fileSearchFileSchema),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** The runtime's wall-clock budget ran out before the walk finished. */
  timedOut: z.boolean(),
  /** Files not read: above the size limit, or binary. */
  skipped: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullish(),
});

export const fileEntryKindSchema = z.enum(["file", "directory"]);

/** `POST /api/workspaces/{id}/file-entries` — 新建文件 / 新建文件夹. */
export const createFileEntryRequestSchema = z.object({
  path: z.string().min(1).max(4_000),
  kind: fileEntryKindSchema,
});

/** `POST …/file-entries/rename` — 重命名 and 移动 are one operation. */
export const renameFileEntryRequestSchema = z.object({
  from: z.string().min(1).max(4_000),
  to: z.string().min(1).max(4_000),
});

export const fileEntryResultSchema = z.object({
  path: z.string(),
  kind: fileEntryKindSchema,
});

/**
 * One entry in `<workspace>/.armadra/trash/`. Deleting moves bytes there and
 * `POST …/file-entries/restore` puts them back; nothing deletes permanently.
 */
export const trashEntrySchema = z.object({
  id: z.string(),
  originalPath: z.string(),
  name: z.string(),
  kind: fileEntryKindSchema,
  deletedAt: z.string(),
});

export const trashListSchema = z.array(trashEntrySchema);

/**
 * `GET /api/workspaces/{id}/language-service` — capability probe.
 *
 * Armadra has no LSP yet, so `unavailable` is the only answer the runtime
 * gives. The editor shows no completion affordances rather than an empty list
 * pretending to be one (editor design §2, §4).
 */
export const languageServiceStatusSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.string().optional(),
});

export type FileIndexEntry = z.infer<typeof fileIndexEntrySchema>;
export type FileIndex = z.infer<typeof fileIndexSchema>;
export type FileSearchRequest = z.infer<typeof fileSearchRequestSchema>;
export type FileSearchMatch = z.infer<typeof fileSearchMatchSchema>;
export type FileSearchFile = z.infer<typeof fileSearchFileSchema>;
export type FileSearchResult = z.infer<typeof fileSearchResultSchema>;
export type FileEntryKind = z.infer<typeof fileEntryKindSchema>;
export type FileEntryResult = z.infer<typeof fileEntryResultSchema>;
export type TrashEntry = z.infer<typeof trashEntrySchema>;
export type LanguageServiceStatus = z.infer<typeof languageServiceStatusSchema>;
