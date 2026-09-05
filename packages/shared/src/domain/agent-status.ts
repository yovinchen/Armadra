import { z } from "zod";

import { timestampSchema } from "./internal.js";
import { agentIdSchema } from "./node-data.js";
import { agentStateSchema } from "./primitives.js";

export const agentStatusSchema = z.object({
  nodeId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: agentIdSchema,
  state: agentStateSchema.optional(),
  unread: z.boolean().default(false),
  sessionId: z.string().max(200).optional(),
  pendingId: z.string().max(200).optional(),
  /** The reporting hook presented a node token minted by this runtime instance. */
  verified: z.boolean().default(false),
  /** The row was read back from SQLite after a runtime restart. */
  restored: z.boolean().default(false),
  /** Absolute path of the CLI transcript the last report came from, when it
   * reported one. The transcript viewer opens this. */
  transcriptPath: z.string().max(4_000).optional(),
  /** When the last hook event arrived, as opposed to when the row was written. */
  lastEventAt: timestampSchema.optional(),
  /** `start` / `end` of the session the last event belonged to. */
  sessionPhase: z.enum(["start", "end"]).optional(),
  /** Last assistant message, for the session list preview. */
  lastMessage: z.string().max(20_000).optional(),
  /**
   * How the last turn ended — plan §5.4, migration `0007`. Deliberately
   * tri-state: absent means "no verdict yet" (the turn is still open, or the
   * row predates the column), `false` means it ended cleanly, `true` drives
   * the `TURN FAILED` / `PAUSED` pills. Both are cleared back to absent on a
   * new turn, so a pill can never sit over live work.
   */
  errored: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  updatedAt: timestampSchema,
});

export const AGENT_EVENT_KINDS = [
  "state",
  "session",
  "subagent-start",
  "subagent-end",
] as const;

export const agentEventKindSchema = z.enum(AGENT_EVENT_KINDS);

/** Normalized hook event — plan §5.4. */
export const agentEventSchema = z.object({
  nodeId: z.string().uuid(),
  agentId: agentIdSchema,
  kind: agentEventKindSchema,
  state: agentStateSchema.optional(),
  newTurn: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  errored: z.boolean().optional(),
  idle: z.boolean().optional(),
  awaitingInput: z.boolean().optional(),
  pendingId: z.string().max(200).optional(),
  askKind: z.string().max(80).optional(),
  sessionId: z.string().max(200).optional(),
  sessionPhase: z.enum(["start", "end"]).optional(),
  lastMessage: z.string().max(20_000).optional(),
  toolUseId: z.string().max(200).optional(),
  subagentType: z.string().max(120).optional(),
  taskLabel: z.string().max(400).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  result: z.string().max(20_000).optional(),
  verified: z.boolean().optional(),
  clientRevision: z.number().int().nonnegative().optional(),
});

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
