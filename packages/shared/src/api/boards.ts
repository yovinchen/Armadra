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

/* ------------------------- 在线设备与编辑租约（§9） ------------------------ */

/** 一个标签页一个的随机串；core 只认这个字符集。 */
export const presenceClientIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/);

export const presenceClientSchema = z.object({
  clientId: z.string(),
  deviceName: z.string(),
  lastSeenAt: z.string(),
});

export const boardLeaseSchema = z.object({
  clientId: z.string(),
  deviceName: z.string(),
  acquiredAt: z.string(),
});

/** 心跳、离开、拿租约的回答，也是 `canvas.presence` 事件的字段。 */
export const boardPresenceSchema = z.object({
  boardId: z.string(),
  clients: z.array(presenceClientSchema),
  lease: boardLeaseSchema.nullable(),
  /**
   * 只在心跳的回答里（契约 §9.1）：发这次心跳的人能不能写这块画布。事件里
   * 没有——同一帧发给所有人，而能不能写因人而异。
   */
  writable: z.boolean().optional(),
});

export const presenceHeartbeatRequestSchema = z.object({
  clientId: presenceClientIdSchema,
  deviceName: z.string().max(256).optional(),
  active: z.boolean().optional(),
});

export const leaseRequestSchema = z.object({
  clientId: presenceClientIdSchema,
  deviceName: z.string().max(256).optional(),
  takeover: z.boolean().optional(),
});

/** 别人持有租约时写入与拿租约的拒绝码。 */
export const CANVAS_LEASE_HELD = "canvas_lease_held";

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
    /** 写者（core JSON §9.3）：别人持有编辑租约时这次保存被 423 拒绝。 */
    clientId: presenceClientIdSchema.optional(),
  }),
);

export const saveBoardResponseSchema = boardDocumentSchema;

export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>;
export type UpdateBoardRequest = z.infer<typeof updateBoardRequestSchema>;
export type SaveBoardRequest = z.infer<typeof saveBoardRequestSchema>;
export type PresenceClient = z.infer<typeof presenceClientSchema>;
export type BoardLease = z.infer<typeof boardLeaseSchema>;
export type BoardPresence = z.infer<typeof boardPresenceSchema>;
