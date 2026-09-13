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
   * Revision of the installed collaboration skill, absent when the skill is not
   * installed. It is read from the file on disk rather than from a row, so a
   * user who deletes the skill by hand sees that here on the next refresh.
   */
  skillsRevision: z.number().int().nonnegative().nullish(),
  /**
   * Cached `--version` probe (`agent-capabilities.ts`). Absent means the CLI
   * has not been probed yet, which resolves gated capabilities to `unknown` —
   * never to supported.
   */
  probe: agentProbeSchema.nullish(),
  /**
   * Argv a session of this agent must carry for its adapter to load
   * (docs/design/agent-integration.md §3) — `--settings <file>` for Claude
   * Code, empty for everyone else and for an uninstalled integration.
   *
   * It is answered per request rather than frozen into a launch definition
   * because both halves are the runtime's: the path is that data directory's
   * and the flag is that CLI version's.
   *
   * Optional rather than defaulted: the runtime omits it when there is nothing
   * to add, and "this agent needs no argv" and "this runtime predates the
   * field" are the same instruction to the caller — add nothing.
   */
  launchArgs: z.array(z.string()).optional(),
});

export const agentListSchema = z.array(agentInfoSchema);

/**
 * `GET /api/agents/{id}/models` — 节点头部「模型」菜单的候选（用户实测反馈 F7）。
 *
 * `source` 说的是这一条**从哪来**，因为三种来源不是一回事：
 *
 *   * `cli` —— CLI 自己说的（`claude --help` 的别名、Codex `config.toml` 里
 *     配好的模型）。它反映的是这台机器、这个账号的实际情况，所以排在最前；
 *   * `catalog` —— models.dev 上该 provider 的条目，按发布日期倒序；
 *   * `builtin` —— 离线兜底，只在前两者都拿不到时出现。
 *
 * 没有 `releaseDate` 的条目排在有日期的之前：别名永远指向该系列的最新模型，
 * 不可能比下面任何一条更旧，而且那是 CLI 自己文档里的写法。
 */
export const agentModelSourceSchema = z.enum(["cli", "catalog", "builtin"]);
export type AgentModelSource = z.infer<typeof agentModelSourceSchema>;

export const agentModelSchema = z.object({
  /** 原样放到启动行 `--model` 后面的值。 */
  id: z.string().min(1),
  label: z.string(),
  source: agentModelSourceSchema,
  /** `YYYY-MM-DD`，目录里有才有。 */
  releaseDate: z.string().optional(),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentModelListSchema = z.array(agentModelSchema);

/**
 * How a provider's hook adapter reaches its CLI
 * (docs/design/agent-integration.md §3).
 *
 * The distinction the settings page shows is "does integrating me edit a file
 * you also edit": `launch` passes the adapter on the command line and `extension`
 * writes a generated module only we ever touch, so neither goes near the user's
 * own configuration; `file` merges into it, idempotently and repairably.
 */
export const INJECTION_MODES = ["launch", "file", "extension"] as const;

/** One half of an install unit — the adapter, or the skill. */
export const integrationHalfSchema = z.object({
  installed: z.boolean(),
  /** Where it lives. Present even when it is not installed: the answer to
   * "why is this not on" is usually "look here". */
  path: z.string().optional(),
  /** The revision on disk; `0` when this half is not installed. */
  revision: z.number().int().nonnegative().default(0),
});

/** Something an earlier product name left behind (设计 §4). */
export const legacyIntegrationFindingSchema = z.object({
  /** `hook_entry` / `skill_dir` / `codex_unknown_key` / `status_line`. */
  kind: z.string(),
  path: z.string(),
  /** The command, key or directory name, so a person can recognise their own. */
  detail: z.string(),
});

/**
 * `GET /api/agents/{id}/integration`, and what install / uninstall answer with
 * (docs/design/agent-integration.md §5).
 *
 * Hook and skill are **one** install unit with one state: before this, a CLI
 * had two switches and three ways to be half-integrated, and no single screen
 * could say which. `revision` is what a fresh install writes — the hook
 * revision and the skill revision folded together — and `stale` is the only
 * question the page has to ask about it.
 *
 * Loose on purpose: the runtime omits what is empty and adds fields faster than
 * the settings page reads them.
 */
export const integrationStateSchema = z.looseObject({
  agentId: agentIdSchema,
  mode: z.enum(INJECTION_MODES),
  hook: integrationHalfSchema,
  skill: integrationHalfSchema,
  legacy: z.object({
    found: z.array(legacyIntegrationFindingSchema).default([]),
  }),
  revision: z.number().int().nonnegative(),
  /** What the files on disk were written by; absent when nothing is installed. */
  installedRevision: z.number().int().nonnegative().optional(),
  stale: z.boolean().default(false),
  /**
   * Argv a session of this agent must carry for its adapter to load. Empty for
   * every mode but `launch`, and for an integration that is not installed.
   */
  launchArgs: z.array(z.string()).default([]),
  clientBin: z.string().optional(),
  /** Something worked but deserves a sentence in the settings page. */
  warning: z.string().optional(),
});

/**
 * `POST /api/agents/{id}/integration/repair` — what the pass actually did.
 *
 * `kept` is the point of the report: everything this repair recognised as not
 * ours and wrote back exactly as it read it.
 */
export const integrationRepairReportSchema = z.looseObject({
  agentId: agentIdSchema,
  found: z.array(legacyIntegrationFindingSchema).default([]),
  removed: z.array(z.string()).default([]),
  kept: z.array(z.string()).default([]),
  /** The newest backup, for the sentence the settings page shows. */
  backup: z.string().optional(),
  backups: z.array(z.string()).default([]),
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
 * `GET /api/agent-status/{nodeId}/transcript` — the node's own conversation,
 * one prose line per message.
 *
 * `truncated` is a field rather than an ellipsis in the text because a cut-off
 * conversation read as a whole one is a wrong answer, not a short one. A
 * provider that keeps nothing readable answers 501 with a reason, so an empty
 * `text` here never stands for "this CLI has no transcript".
 */
export const agentTranscriptSchema = z.object({
  nodeId: z.string().max(160),
  text: z.string(),
  truncated: z.boolean(),
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
export type AgentTranscript = z.infer<typeof agentTranscriptSchema>;
export type AgentInfo = z.infer<typeof agentInfoSchema>;
export type InjectionMode = (typeof INJECTION_MODES)[number];
export type IntegrationHalf = z.infer<typeof integrationHalfSchema>;
export type LegacyIntegrationFinding = z.infer<
  typeof legacyIntegrationFindingSchema
>;
export type IntegrationState = z.infer<typeof integrationStateSchema>;
export type IntegrationRepairReport = z.infer<
  typeof integrationRepairReportSchema
>;
export type AnswerApprovalRequest = z.infer<typeof answerApprovalRequestSchema>;
export type ContextLink = z.infer<typeof contextLinkSchema>;
export type ContextLinkContent = z.infer<typeof contextLinkContentSchema>;
