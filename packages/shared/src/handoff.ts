import { z } from "zod";

const text = z.string().max(8_000);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const handoffSectionsSchema = z.object({
  goal: text.min(1),
  constraints: text.default(""),
  completed: text.default(""),
  pending: text.default(""),
  decisions: text.default(""),
  toolSummary: text.default(""),
});
export const handoffPrepareSchema = z.object({
  sourceNodeId: z.string().uuid(),
  sourceSessionId: z.string().uuid(),
  sourceGeneration: generation,
  targetNodeId: z.string().uuid(),
  targetSessionId: z.string().uuid(),
  targetGeneration: generation,
  sections: handoffSectionsSchema,
  filePaths: z.array(z.string().min(1).max(4_000)).max(32).default([]),
  byteBudget: z.union([z.literal(8192), z.literal(16384), z.literal(32768)]),
  includeTranscript: z.boolean().default(true),
});
export const handoffIdentitySchema = z.object({
  nodeId: z.string().uuid(),
  nodeTitle: z.string(),
  sessionId: z.string().uuid(),
  generation,
  agentId: z.string(),
  provider: z.string(),
  providerSessionId: z.string().nullable(),
  modelId: z.string().nullable(),
  accountId: z.string().nullable(),
  // `local-runtime`，或远端的 `execution-host:<主机 id>`。
  executionHost: z.string(),
  workingDirectory: z.string(),
});
export const handoffBundleSchema = z.object({
  version: z.literal(1),
  handoffId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  createdAt: z.string(),
  source: handoffIdentitySchema,
  target: handoffIdentitySchema,
  cutoff: z.object({
    kind: z.enum(["transcriptBytes", "terminalLog", "unavailable"]),
    reference: z.string().nullable(),
    sourceRevision: z.string().nullable(),
    sha256: z.string().nullable(),
    sourceUpdatedAt: z.string().nullable(),
  }),
  sections: handoffSectionsSchema,
  transcriptExcerpt: z.string(),
  summaryMethod: z.literal("editableTemplateAndExcerpt"),
  trust: z.literal("peerDataNotSystemInstructions"),
  sourcePreserved: z.literal(true),
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().nullable(),
      bytes: z.number().int().nonnegative().nullable(),
      status: z.enum(["referenced", "missing", "excluded", "changed"]),
      executionHost: z.string(),
    }),
  ),
  git: z.object({
    headOid: z.string().nullable(),
    indexDigest: z.string().nullable(),
    worktreeDigest: z.string().nullable(),
    repositoryId: z.string().nullable(),
    worktreeId: z.string().nullable(),
    status: z.enum(["observed", "unavailable"]),
    worktreeDigestBasis: z.literal("statusSummary"),
  }),
  attachments: z.array(z.never()),
  budget: z.object({
    byteLimit: z.number().int().positive(),
    usedBytes: z.number().int().nonnegative(),
    tokenEstimate: z.null(),
    capacityTokens: z.number().int().positive().nullable(),
    availableTokens: z.null(),
    reservedTokens: z.null(),
    truncated: z.boolean(),
    omitted: z.array(z.string()),
  }),
});
/**
 * 交接的四个状态。
 *
 * 冻结（`prepared`）→ 用户批准，材料进目标收件箱（`queued`）→ 目标自己确认
 * 那条消息（`acknowledged`），或者来源撤回、收件箱那条被删掉（`cancelled`）。
 *
 * 不再有 `dispatching` / `notified` / `unknownOutcome` / `failed` / `expired`：
 * 它们描述的是「往对方终端里写」这件事的各种结果，而现在没有这个动作。旧库里
 * 留下的那些值由 Runtime 读出来时归一成 `queued`——批准过、进了信箱、没被确认。
 */
export const handoffStateSchema = z.enum([
  "prepared",
  "queued",
  "acknowledged",
  "cancelled",
]);
export const handoffViewSchema = z.object({
  bundle: handoffBundleSchema,
  digest: z.string(),
  state: handoffStateSchema,
  mailboxId: z.string().nullable(),
  traceId: z.string().nullable(),
  errorCode: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  updatedAt: z.string(),
  sourceHasNewActivity: z.boolean(),
});
export const handoffListSchema = z.array(handoffViewSchema);
export type HandoffSections = z.infer<typeof handoffSectionsSchema>;
export type HandoffPrepare = z.infer<typeof handoffPrepareSchema>;
export type HandoffBundle = z.infer<typeof handoffBundleSchema>;
export type HandoffView = z.infer<typeof handoffViewSchema>;
