import { z } from "zod";

/**
 * One row of `agent_deliveries` — `GET /api/workspaces/{id}/deliveries`.
 * The board log (`<workspace>/.armadra/board-log.jsonl`) carries the same fields;
 * neither of them ever records the message body, only its length.
 */
export const agentDeliverySchema = z.object({
  traceId: z.string(),
  workspaceId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  outcome: z.string(),
  receipt: z.string().nullish(),
  bodyChars: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
});

export const deliveriesResponseSchema = z.array(agentDeliverySchema);

/**
 * One row of `agent_send_queue` — `GET /api/workspaces/{id}/deliveries?node=`.
 *
 * The other slice of the same path: what is still queued in front of a target
 * terminal, which is what the node header's 「排队 N」 counts (设计
 * `agent-delivery.md` §4.6、§10). Like the record above it never carries the
 * body — a list says what is waiting, not what it says.
 */
export const deliveryQueueItemSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sourceNodeId: z.string(),
  sourceName: z.string().default(""),
  targetNodeId: z.string(),
  origin: z.string().default("send"),
  queuedAt: z.number().int().nonnegative().default(0),
  expiresAt: z.number().int().nonnegative().default(0),
  position: z.number().int().nonnegative().default(1),
  bodyChars: z.number().int().nonnegative().default(0),
  attempts: z.number().int().nonnegative().default(0),
  /** 上一次没投出去的稳定码，页面按它取文案。 */
  reason: z.string().optional(),
});

export const deliveryQueueResponseSchema = z.array(deliveryQueueItemSchema);

/** `DELETE /api/workspaces/{id}/deliveries/{deliveryId}` — 人拒收一条。 */
export const deliveryCancelResponseSchema = z.object({
  cancelled: z.boolean(),
});

/** `POST /api/control/confirm/{requestId}` — plan §5.8, the human gate. */
export const controlConfirmRequestSchema = z.object({
  approve: z.boolean(),
});

export const controlConfirmResponseSchema = z.object({
  requestId: z.string(),
  approve: z.boolean(),
  /** False when nothing was waiting any more (the verb already timed out). */
  accepted: z.boolean(),
});

export type AgentDelivery = z.infer<typeof agentDeliverySchema>;
export type DeliveryQueueItem = z.infer<typeof deliveryQueueItemSchema>;
export type ControlConfirmRequest = z.infer<typeof controlConfirmRequestSchema>;
export type ControlConfirmResponse = z.infer<
  typeof controlConfirmResponseSchema
>;
