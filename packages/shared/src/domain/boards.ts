import { z } from "zod";

import { timestampSchema } from "./internal.js";
import { canvasEdgeSchema, canvasNodeSchema } from "./nodes.js";

export const viewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().positive(),
});

export const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;

/** Opaque retirement records. No update request schema or canvas state owns them. */
export const legacyKanbanArchiveSummarySchema = z.object({
  canvasId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  canvasName: z.string(),
  archivedAt: z.string(),
  kanbanBytes: z.number().int().nonnegative().safe(),
  labelCount: z.number().int().nonnegative().safe(),
});
export const legacyNodeLabelArchiveSchema = z.object({
  nodeId: z.string(),
  canvasId: z.string(),
  workspaceId: z.string().nullable(),
  nodeTitle: z.string(),
  nodeType: z.string(),
  labelsJson: z.string(),
  note: z.string(),
  nodeCreatedAt: z.string(),
  nodeUpdatedAt: z.string(),
  archivedAt: z.string(),
});
export const legacyKanbanArchiveSchema =
  legacyKanbanArchiveSummarySchema.extend({
    kanbanJson: z.string(),
    kanbanSha256: z.string().regex(/^[a-f0-9]{64}$/),
    canvasCreatedAt: z.string(),
    canvasUpdatedAt: z.string(),
    labels: z.array(legacyNodeLabelArchiveSchema),
  });
export const legacyKanbanArchivePageSchema = z.object({
  archives: z.array(legacyKanbanArchiveSummarySchema),
  nextCursor: z.string().nullable(),
});
export const legacyKanbanArchiveExportSchema = z.object({
  formatVersion: z.literal(1),
  archive: legacyKanbanArchiveSchema,
});
export type LegacyKanbanArchiveSummary = Readonly<
  z.infer<typeof legacyKanbanArchiveSummarySchema>
>;
export type LegacyNodeLabelArchive = Readonly<
  z.infer<typeof legacyNodeLabelArchiveSchema>
>;
export type LegacyKanbanArchive = Readonly<
  z.infer<typeof legacyKanbanArchiveSchema>
>;

/**
 * Whiteboard snapshot cap — tldraw plan §6.1. Images never live inside the
 * snapshot (they go through the asset endpoint), so this is only ink, shapes
 * and text; 8 MiB is far beyond anything a hand can draw.
 */
export const MAX_WHITEBOARD_BYTES = 8 * 1024 * 1024;

export const boardSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  sortOrder: z.number().int().default(0),
  viewport: viewportSchema.default(DEFAULT_VIEWPORT),
  /**
   * Opaque whiteboard document (JSON string) holding the whiteboard-native
   * objects only — canvas-react-flow plan §3.1. Neither the runtime nor the
   * host looks inside it; only the web client parses it. Empty string = no
   * whiteboard content. Defaulted so a document written before migration 0009
   * still parses.
   */
  whiteboard: z.string().max(MAX_WHITEBOARD_BYTES).default(""),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const boardDocumentSchema = z.object({
  board: boardSchema,
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
});

export type Viewport = z.infer<typeof viewportSchema>;
export type Board = z.infer<typeof boardSchema>;
export type BoardDocument = z.infer<typeof boardDocumentSchema>;
