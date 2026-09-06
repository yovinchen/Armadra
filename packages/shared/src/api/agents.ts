import { z } from "zod";

import { agentProbeSchema } from "../agent-capabilities.js";
import { AGENT_CAPABILITIES, AGENT_IDS, PROMPT_MODES } from "../agents.js";
import { agentIdSchema } from "../domain/index.js";

/** `GET /api/agents` — registry entry plus local detection. */
export const agentInfoSchema = z.object({
  id: agentIdSchema,
  label: z.string(),
  color: z.string(),
  launchCmd: z.string(),
  promptMode: z.enum(PROMPT_MODES),
  capabilities: z.array(z.enum(AGENT_CAPABILITIES)).default([]),
  /** Extra argv the launch line appends; always empty for a built-in agent. */
  args: z.array(z.string()).default([]),
  /**
   * The built-in agent a `custom:` entry borrows its hooks, prompt mode and
   * permission flags from (plan §24.1). Absent on the built-ins themselves.
   */
  baseAgent: z.enum(AGENT_IDS).optional(),
  /** Absolute path the launch program resolves to, or null. */
  resolvedPath: z.string().nullable().default(null),
  /** The launch program exists on the augmented PATH. */
  installed: z.boolean(),
  /** Revision of the installed hook client, absent when hooks are not installed. */
  clientRevision: z.number().int().nonnegative().nullish(),
  /**
   * Cached `--version` probe (`agent-capabilities.ts`). Absent means the CLI
   * has not been probed yet, which resolves gated capabilities to `unknown` —
   * never to supported.
   */
  probe: agentProbeSchema.nullish(),
});

export const agentListSchema = z.array(agentInfoSchema);

/**
 * `POST /api/agents/{id}/hooks/install|uninstall`.
 *
 * Loose on purpose: the runtime omits `clientBin` and `warning` when they are
 * empty, and adds fields faster than the settings page reads them.
 */
export const hookInstallReportSchema = z.looseObject({
  agentId: agentIdSchema,
  configPath: z.string(),
  clientBin: z.string().optional(),
  clientRevision: z.number().int().nonnegative(),
  installed: z.boolean(),
  /** Something worked but deserves a sentence in the settings page. */
  warning: z.string().optional(),
});

export const answerApprovalRequestSchema = z.object({
  decision: z.enum(["allow", "deny"]),
});

export const answerApprovalResponseSchema = z.object({
  pendingId: z.string(),
  decision: z.enum(["allow", "deny"]),
  answeredAt: z.string().datetime({ offset: true }),
});

/**
 * `POST /api/agent-status/{nodeId}/suggest-title` — the header's ✦ button.
 *
 * `source` says where the sentence came from so the UI can be honest when the
 * answer is only the agent's name: `transcript` (first user message),
 * `terminal` (last command in the pane) or `agent` (the label, nothing better
 * was available).
 */
export const suggestTitleResponseSchema = z.object({
  title: z.string().min(1).max(40),
  source: z.enum(["transcript", "terminal", "agent"]),
});

/**
 * What a linked whiteboard shape reads as (docs/design/canvas-react-flow.md
 * §2.5). Only present when `kind === "shape"`: text items carry their text,
 * everything else is rasterised by the client and referenced by a
 * workspace-relative PNG path.
 */
export const contextLinkContentSchema = z.object({
  /** Render status is explicit: a visible link need not have a ready image. */
  status: z.enum(["pending", "ready", "error"]).optional(),
  sourceShapeId: z.string().max(160).optional(),
  shapeType: z.string().max(40).optional(),
  textTruncated: z.boolean().optional(),
  text: z.string().max(20_000).optional(),
  pngPath: z.string().max(4_000).optional(),
});

export const contextLinkSchema = z.object({
  /** Node id, or the uuid of the whiteboard item behind a `shape` link. */
  id: z.string().uuid(),
  title: z.string().max(160),
  /**
   * A node type, or `"shape"` for whiteboard content
   * (docs/design/canvas-react-flow.md §2.5).
   */
  kind: z.string().max(40),
  content: contextLinkContentSchema.optional(),
});

export type SuggestTitleResponse = z.infer<typeof suggestTitleResponseSchema>;
export type AgentInfo = z.infer<typeof agentInfoSchema>;
export type HookInstallReport = z.infer<typeof hookInstallReportSchema>;
export type AnswerApprovalRequest = z.infer<typeof answerApprovalRequestSchema>;
export type ContextLink = z.infer<typeof contextLinkSchema>;
export type ContextLinkContent = z.infer<typeof contextLinkContentSchema>;
