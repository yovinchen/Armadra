import { z } from "zod";

import { timestampSchema } from "./internal.js";
import { canvasNodeDataSchema } from "./node-data.js";
import {
  DEFAULT_NODE_COLOR,
  edgeKindSchema,
  nodeTypeSchema,
} from "./primitives.js";

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const sizeSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});

/* ----------------------------------- nodes ------------------------------- */

export const canvasNodeSchema = z
  .object({
    id: z.string().uuid(),
    boardId: z.string().uuid(),
    type: nodeTypeSchema,
    /** Header label; also the group label and the sticky heading. */
    title: z.string().min(1).max(160),
    color: z.string().min(1).max(32).default(DEFAULT_NODE_COLOR),
    position: positionSchema,
    size: sizeSchema.optional(),
    collapsed: z.boolean().optional(),
    /** Height restored when the node is expanded again. */
    expandedHeight: z.number().positive().optional(),
    /** Id of the `group` node this node belongs to. */
    parentId: z.string().uuid().optional(),
    /**
     * `+ Label` chips shown under the node header
     * (plan §17). Short and few on purpose: they are a filter, not a field.
     *
     * Defaulted, so a document written before migration 0008 still parses;
     * the runtime emits both keys on every node from 0008 onwards.
     */
    labels: z.array(z.string().trim().min(1).max(24)).max(8).default([]),
    /** Header comment popover — free prose the agent never reads. */
    note: z.string().max(4_000).default(""),
    data: canvasNodeDataSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((node, context) => {
    if (node.type !== node.data.kind) {
      context.addIssue({
        code: "custom",
        message: `Node type ${node.type} does not match data kind ${node.data.kind}`,
        path: ["data", "kind"],
      });
    }
    if (node.parentId === node.id) {
      context.addIssue({
        code: "custom",
        message: "A node cannot be its own parent",
        path: ["parentId"],
      });
    }
  });

/* ----------------------------------- edges ------------------------------- */

export const canvasEdgeSchema = z.object({
  id: z.string().uuid(),
  boardId: z.string().uuid(),
  source: z.string().uuid(),
  target: z.string().uuid(),
  kind: edgeKindSchema.default("link"),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type Position = z.infer<typeof positionSchema>;
export type Size = z.infer<typeof sizeSchema>;
