import { z } from "zod";
import {
  adapterIdSchema,
  boardDocumentSchema,
  boardSchema,
  canvasEdgeSchema,
  canvasNodeSchema,
  diffFileStatusSchema,
  strokeSchema,
  viewportSchema,
  workspacePermissionsSchema,
  workspaceSchema,
  workspaceSummarySchema,
} from "./domain.js";

/**
 * Runtime API v2 — see docs/redesign-plan.md §3.
 */

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

export const healthSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
});

/* ---------------------------------- workspaces --------------------------- */

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rootPath: z.string().min(1),
  color: z.string().min(1).max(32).optional(),
  permissions: workspacePermissionsSchema.optional(),
  gatewayEnabled: z.boolean().optional(),
});

export const updateWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: z.string().min(1).max(32).optional(),
  permissions: workspacePermissionsSchema.optional(),
  gatewayEnabled: z.boolean().optional(),
});

export const workspaceListSchema = z.array(workspaceSummarySchema);

/* ------------------------------------ boards ----------------------------- */

export const boardListSchema = z.array(boardSchema);

export const createBoardRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const updateBoardRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
});

export const saveBoardRequestSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  strokes: z.array(strokeSchema).default([]),
  viewport: viewportSchema,
});

export const saveBoardResponseSchema = boardDocumentSchema;

/* ------------------------------------ files ------------------------------ */

export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative(),
  readonly: z.boolean(),
});

export const fileListSchema = z.object({
  path: z.string(),
  entries: z.array(fileEntrySchema),
  truncated: z.boolean(),
});

export const fileContentSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
});

/* ---------------------------------- terminals ---------------------------- */

export const createTerminalRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  cwd: z.string(),
  shell: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
});

// The runtime also emits `kind`, `ownerNodeId` and `adapter` on this payload.
// They are intentionally not modelled here (no consumer yet) and a non-strict
// z.object drops them silently. Do NOT add `.strict()`: it would turn every
// terminal fetch into a parse error. Add the fields first if you want it strict.
export const terminalSessionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  cwd: z.string(),
  shell: z.string(),
  command: z.string().nullable(),
  status: z.enum(["running", "exited", "failed", "terminated"]),
  exitCode: z.number().int().nullable(),
  pid: z.number().int().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
});

/* ----------------------------------- agents ------------------------------ */

export const adapterInfoSchema = z.object({
  id: adapterIdSchema,
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  protocol: z.literal("acp"),
  available: z.boolean(),
  resolvedPath: z.string().nullable().default(null),
});

export const adapterListSchema = z.array(adapterInfoSchema);

export const contextItemKindSchema = z.enum([
  "task",
  "file",
  "context",
  "log",
  "note",
  "browser",
  "text",
]);

export const contextItemSchema = z.object({
  nodeId: z.string().uuid(),
  kind: contextItemKindSchema,
  title: z.string(),
  value: z.string(),
});

export const contextPreviewRequestSchema = z.object({
  agentNodeId: z.string().uuid(),
  items: z.array(contextItemSchema),
});

export const contextPreviewResponseSchema = z.object({
  prompt: z.string(),
});

export const runAgentRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  agentNodeId: z.string().uuid(),
  adapter: adapterIdSchema,
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string(),
  items: z.array(contextItemSchema),
  sessionId: z.string().uuid().optional(),
});

export const runAgentResponseSchema = z.object({
  session: terminalSessionSchema,
  prompt: z.string(),
});

/* ------------------------------------- git ------------------------------- */

export const gitStatusSchema = z.object({
  repository: z.boolean(),
  branch: z.string().nullable(),
  changedCount: z.number().int().nonnegative(),
  // `null` is meaningful here (detached HEAD / no upstream => distance unknown)
  // and it is also what serde emits for `Option::None`, so accept both null and
  // an omitted key rather than making every git-status fetch throw.
  ahead: z.number().int().nonnegative().nullish(),
  behind: z.number().int().nonnegative().nullish(),
});

export const gitFileDiffSchema = z.object({
  path: z.string(),
  status: diffFileStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
  // false = binary/oversized file listed without a textual patch; `patch` is
  // empty and must be skipped when exporting a unified diff.
  previewable: z.boolean().default(true),
});

export const gitDiffSchema = z.object({
  repository: z.boolean(),
  clean: z.boolean(),
  files: z.array(gitFileDiffSchema),
});

export const gitPathsRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

export const gitStageResponseSchema = z.object({
  staged: z.array(z.string()),
});

export const gitRevertResponseSchema = z.object({
  reverted: z.array(z.string()),
});

/* ----------------------------------- gateway ----------------------------- */

export const gatewayDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  lastSeenAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export const gatewayStatusSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().positive(),
  addresses: z.array(z.string()).default([]),
  devices: z.array(gatewayDeviceSchema).default([]),
  implemented: z.literal(false),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type Health = z.infer<typeof healthSchema>;
export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;
export type UpdateWorkspaceRequest = z.infer<
  typeof updateWorkspaceRequestSchema
>;
export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>;
export type UpdateBoardRequest = z.infer<typeof updateBoardRequestSchema>;
export type SaveBoardRequest = z.infer<typeof saveBoardRequestSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type FileList = z.infer<typeof fileListSchema>;
export type FileContent = z.infer<typeof fileContentSchema>;
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type AdapterInfo = z.infer<typeof adapterInfoSchema>;
export type ContextItem = z.infer<typeof contextItemSchema>;
export type ContextItemKind = z.infer<typeof contextItemKindSchema>;
export type RunAgentResponse = z.infer<typeof runAgentResponseSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitDiff = z.infer<typeof gitDiffSchema>;
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>;
export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;
export type GatewayDevice = z.infer<typeof gatewayDeviceSchema>;
