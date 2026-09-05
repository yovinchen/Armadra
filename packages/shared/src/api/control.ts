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
export type ControlConfirmRequest = z.infer<typeof controlConfirmRequestSchema>;
export type ControlConfirmResponse = z.infer<
  typeof controlConfirmResponseSchema
>;
