import { z } from "zod";

export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative(),
  readonly: z.boolean(),
});

export const fileListSchema = z.object({
  path: z.string(),
  entries: z.array(fileEntrySchema),
  truncated: z.boolean(),
});

/** How a file's lines end. `mixed` cannot round-trip and is reported as such. */
export const fileEolSchema = z.enum(["lf", "crlf", "mixed", "none"]);

/** `unknown` means the bytes are not valid UTF-8, so the file is read-only. */
export const fileEncodingSchema = z.enum(["utf-8", "unknown"]);

export const fileContentSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  /**
   * The content version for the next save. Absent for a file that is not valid
   * UTF-8: the editor is showing a lossy reading and must not write it back.
   */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** Older runtimes answer without these; the editor then shows no badge. */
  encoding: fileEncodingSchema.optional(),
  /** A UTF-8 BOM was stripped from `content`; a save passes it back. */
  bom: z.boolean().optional(),
  eol: fileEolSchema.optional(),
  /** The file itself cannot be written, whatever the workspace allows. */
  readonly: z.boolean().optional(),
});

export const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_IMPORT_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_FILES = 256;
export const fileInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  preview: z.enum(["text", "image", "download"]),
});
export const importFilesResponseSchema = z.object({
  path: z.string(),
  files: z.array(fileInfoSchema),
});
export type ImportedFileInfo = z.infer<typeof fileInfoSchema>;
export type ImportFilesResponse = z.infer<typeof importFilesResponseSchema>;

/** Runtime ceiling for `PUT /api/workspaces/{id}/file`. */
export const MAX_WRITE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * `PUT /api/workspaces/{id}/file` — the editor node's save.
 *
 * Existing files require their observed SHA-256. Omitting it creates only a
 * new file; the legacy size field alone cannot authorize an overwrite.
 */
export const writeFileRequestSchema = z.object({
  path: z.string().min(1).max(4_000),
  content: z.string().max(MAX_WRITE_FILE_BYTES),
  expectedSize: z.number().int().nonnegative().optional(),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /**
   * Re-emit the UTF-8 BOM the read stripped, so a file that arrived with one
   * keeps it. Omitted means no BOM, which is what a new file wants.
   */
  bom: z.boolean().optional(),
});

export const writeFileResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/* ------------------------------ file watching ---------------------------- */

/**
 * `GET /api/workspaces/{id}/file-version?path=` — what is on disk right now.
 *
 * A missing file answers `exists: false` rather than 404: the editor keeps the
 * draft of a deleted file. `sha256` is absent for a file above the write
 * limit, which the editor refuses to open anyway.
 */
export const fileVersionSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  size: z.number().int().nonnegative().nullish(),
  /** RFC 3339 when the platform reports one. */
  mtime: z.string().nullish(),
});

/** `POST /api/workspaces/{id}/file-watch` — an editor node opens a file. */
export const watchFileRequestSchema = z.object({
  path: z.string().min(1).max(4_000),
  nodeId: z.string().min(1).max(128),
});

/**
 * `watching` = changes arrive as `file.changed`. `unsupported` = no platform
 * watcher (backend missing, descriptor or queue limit); the client falls back
 * to asking `file-version` on demand.
 */
export const watchStatusSchema = z.enum(["watching", "unsupported"]);

export const watchRegistrationSchema = z.object({
  status: watchStatusSchema,
  reason: z.string().nullish(),
  version: fileVersionSchema,
});

/** How the file on disk differs from what the editor last read. */
export const fileChangeKindSchema = z.enum(["modified", "removed", "replaced"]);

export type FileEntry = z.infer<typeof fileEntrySchema>;
export type FileList = z.infer<typeof fileListSchema>;
export type FileContent = z.infer<typeof fileContentSchema>;
export type WriteFileRequest = z.infer<typeof writeFileRequestSchema>;
export type WriteFileResponse = z.infer<typeof writeFileResponseSchema>;
export type FileVersion = z.infer<typeof fileVersionSchema>;
export type WatchFileRequest = z.infer<typeof watchFileRequestSchema>;
export type WatchStatus = z.infer<typeof watchStatusSchema>;
export type WatchRegistration = z.infer<typeof watchRegistrationSchema>;
export type FileChangeKind = z.infer<typeof fileChangeKindSchema>;
export type FileEol = z.infer<typeof fileEolSchema>;
export type FileEncoding = z.infer<typeof fileEncodingSchema>;
