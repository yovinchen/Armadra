import { z } from "zod";

import { contextLinkSchema } from "./agents.js";

/**
 * `POST /api/workspaces/{id}/assets` — old canvas contract §6.2.
 *
 * Backs every picture that lands on a board. Two body shapes, because the
 * client has two kinds of source:
 *
 *   - a `File` / `Blob` is posted **raw** with its own `Content-Type`;
 *   - an already-decoded data URL (a paste, say) is posted as `{ dataUrl }`
 *     with `Content-Type: application/json`.
 *
 * The stored name is the content hash, so the same picture uploaded twice is
 * one file. Only the eight image types below are accepted — the extension ends
 * up in a file name and the type is echoed back as a `Content-Type`, so neither
 * may come from the client.
 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export const ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "image/bmp",
] as const;

export const uploadAssetRequestSchema = z.object({
  dataUrl: z.string().max(MAX_ASSET_BYTES * 2),
});

export const uploadAssetResponseSchema = z.object({
  /** `<sha256[..16]>.<ext>`; also the last segment of `url` and `path`. */
  id: z.string(),
  /** Workspace-relative path (`.armadra/assets/<id>`) — what an agent is handed. */
  path: z.string(),
  /**
   * Runtime-**relative** URL path. The client prefixes its own runtime origin:
   * the runtime does not know which port it was actually bound to.
   */
  url: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
});

/**
 * `POST /api/workspaces/{id}/assets/import` — old canvas contract §8, Phase 3.
 *
 * The desktop shell only learns a *path* when the OS drops a file on it, never
 * the bytes, so the runtime reads the file and stores it exactly as an upload
 * would — same content-addressed name, same `uploadAssetResponseSchema` back.
 * An absolute path may sit outside the workspace (a Finder drag usually comes
 * from `~/Downloads`); a relative one is resolved against the workspace root.
 */
export const importAssetRequestSchema = z.object({
  path: z.string().min(1).max(4_096),
});

export const contextLinksRequestSchema = z.object({
  links: z.array(contextLinkSchema).max(64).default([]),
});

export const contextLinksResponseSchema = z.object({
  nodeId: z.string(),
  links: z.array(contextLinkSchema).default([]),
  updatedAt: z.string().datetime({ offset: true }),
});

export type ContextLinksRequest = z.infer<typeof contextLinksRequestSchema>;
export type UploadAssetRequest = z.infer<typeof uploadAssetRequestSchema>;
export type ImportAssetRequest = z.infer<typeof importAssetRequestSchema>;
export type UploadAssetResponse = z.infer<typeof uploadAssetResponseSchema>;
