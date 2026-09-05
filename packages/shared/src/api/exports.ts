import { z } from "zod";

import { ContextLink } from "./agents.js";

/**
 * `POST /api/workspaces/{id}/exports/{exportId}/png` — tldraw plan §6.3.
 *
 * Whatever is being exported — ink, a geo shape or a whole frame — only exists
 * as vectors inside the browser, so the web app is the only party that can
 * rasterise it. It uploads a `data:image/png;base64,…` URL and the runtime
 * drops the bytes into `<workspace>/.armadra/exports/<exportId>.png`, where a
 * linked agent reads them with its own file tools. The id only has to be a
 * uuid: it is not looked up as a node, which is what lets a whiteboard shape
 * be exported at all.
 */
export const MAX_EXPORT_PNG_BYTES = 8 * 1024 * 1024;

export const exportPngRequestSchema = z.object({
  dataUrl: z
    .string()
    .max(MAX_EXPORT_PNG_BYTES)
    .refine((value) => value.startsWith("data:image/png;base64,"), {
      message: "Only base64 PNG data URLs may be exported",
    }),
});

export const exportPngResponseSchema = z.object({
  /** Absolute path — what an agent is told to open. */
  path: z.string(),
  /** The same file relative to the workspace root — `ContextLink.content.pngPath`. */
  relativePath: z.string(),
  bytes: z.number().int().nonnegative(),
});

export type ExportPngRequest = z.infer<typeof exportPngRequestSchema>;
export type ExportPngResponse = z.infer<typeof exportPngResponseSchema>;
export type ExportNodePngRequest = ExportPngRequest;
export type ExportNodePngResponse = ExportPngResponse;
