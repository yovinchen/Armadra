import { z } from "zod";

import {
  MAX_WHITEBOARD_BYTES,
  boardDocumentSchema,
  boardSchema,
  canvasEdgeSchema,
  canvasNodeSchema,
  viewportSchema,
} from "../domain/index.js";

export const boardListSchema = z.array(boardSchema);

export const createBoardRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const updateBoardRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
});

export const saveBoardRequestSchema = z.preprocess(
  (value, context) => {
    if (
      value !== null &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "kanban")
    ) {
      context.addIssue({
        code: "custom",
        message: "Task-board writes are retired; use read-only archives",
      });
      return z.NEVER;
    }
    return value;
  },
  z.object({
    expectedUpdatedAt: z.string().datetime({ offset: true }),
    nodes: z.array(canvasNodeSchema),
    edges: z.array(canvasEdgeSchema),
    viewport: viewportSchema,
    /** Omitting the drawing snapshot preserves the stored whiteboard. */
    whiteboard: z.string().max(MAX_WHITEBOARD_BYTES).optional(),
  }),
);

export const saveBoardResponseSchema = boardDocumentSchema;

export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>;
export type UpdateBoardRequest = z.infer<typeof updateBoardRequestSchema>;
export type SaveBoardRequest = z.infer<typeof saveBoardRequestSchema>;
