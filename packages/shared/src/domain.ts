import { z } from "zod";

/**
 * Domain model v2 — see docs/redesign-plan.md §2.
 *
 * The three enumerations below are also exported as plain arrays so the UI can
 * iterate them (node palette, status legend, edge picker) without re-deriving
 * the list from the zod schema.
 */
export const NODE_TYPES = [
  "task",
  "agent",
  "terminal",
  "diff",
  "file",
  "context",
  "note",
  "browser",
  "image",
  "log",
] as const;

export const EDGE_TYPES = [
  "link",
  "dispatch",
  "produce",
  "write",
  "trigger",
  "ref",
] as const;

export const NODE_STATUSES = [
  "idle",
  "running",
  "waiting",
  "done",
  "review",
  "modified",
  "error",
  "disconnected",
  "connecting",
  "linked",
] as const;

export const NODE_ZOOMS = ["mini", "normal", "focus"] as const;

export const nodeTypeSchema = z.enum(NODE_TYPES);
export const edgeTypeSchema = z.enum(EDGE_TYPES);
export const nodeStatusSchema = z.enum(NODE_STATUSES);
export const nodeZoomSchema = z.enum(NODE_ZOOMS);

export const syncPolicySchema = z.enum([
  "local_only",
  "metadata_only",
  "full_sync",
]);

export const adapterIdSchema = z.enum([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "pi",
  "omp",
  "custom",
]);

const timestampSchema = z.string().datetime({ offset: true });

const baseNodeDataSchema = z.object({
  title: z.string().min(1).max(160),
  subtitle: z.string().max(160).optional(),
  status: nodeStatusSchema.default("idle"),
});

export const checklistItemSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(2_000),
  done: z.boolean().default(false),
});

export const taskNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("task"),
  description: z.string().max(20_000),
  checklist: z.array(checklistItemSchema).default([]),
});

export const contextChipKindSchema = z.enum([
  "file",
  "context",
  "note",
  "browser",
  "text",
]);

export const contextChipSchema = z.object({
  id: z.string().min(1).max(64),
  kind: contextChipKindSchema,
  label: z.string().min(1).max(160),
  value: z.string().max(20_000),
});

export const agentNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("agent"),
  adapter: adapterIdSchema,
  sessionId: z.string().uuid().optional(),
  projectPath: z.string(),
  // Custom adapters are allowed to be saved before their command is complete.
  // Execution remains disabled until the user enters a non-blank command.
  command: z.string().max(1_024),
  args: z.array(z.string()).default([]),
  contextChips: z.array(contextChipSchema).default([]),
});

export const terminalNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("terminal"),
  sessionId: z.string().uuid().optional(),
  cwd: z.string(),
  shell: z.string().min(1),
  command: z.string().max(4_000).optional(),
  lastExitCode: z.number().int().nullable().optional(),
});

export const diffFileStatusSchema = z.enum(["M", "A", "D", "R", "?"]);
export const diffFileStateSchema = z.enum(["pending", "accepted", "reverted"]);

export const diffFileSchema = z.object({
  path: z.string(),
  status: diffFileStatusSchema.default("M"),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
  previewable: z.boolean().default(true),
  state: diffFileStateSchema.default("pending"),
});

export const diffNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("diff"),
  repoPath: z.string(),
  sourceAgentNodeId: z.string().uuid().optional(),
  files: z.array(diffFileSchema),
});

export const fileNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("file"),
  path: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  readonly: z.boolean(),
  syncPolicy: syncPolicySchema.default("local_only"),
  language: z.string().max(40).optional(),
});

export const contextNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("context"),
  path: z.string(),
  includePatterns: z.array(z.string()).default([]),
  excludePatterns: z.array(z.string()).default([]),
});

export const noteNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("note"),
  content: z.string().max(20_000),
});

export const MAX_BROWSER_HISTORY = 50;

export const browserNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("browser"),
  url: z.string().max(4_000),
  history: z.array(z.string().max(4_000)).max(MAX_BROWSER_HISTORY).default([]),
  historyIndex: z.number().int().min(-1).default(-1),
});

export const MAX_IMAGE_SRC_BYTES = 2 * 1024 * 1024;

export const imageNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("image"),
  src: z
    .string()
    .max(MAX_IMAGE_SRC_BYTES)
    .refine((value) => value.startsWith("data:"), {
      message: "Image sources must be inlined as a data: URL",
    }),
  mimeType: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sourcePath: z.string().optional(),
});

export const logEntrySourceSchema = z.enum([
  "agent",
  "terminal",
  "gateway",
  "system",
]);

export const logEntrySchema = z.object({
  at: timestampSchema,
  source: logEntrySourceSchema,
  text: z.string().max(20_000),
});

export const logNodeDataSchema = baseNodeDataSchema.extend({
  kind: z.literal("log"),
  content: z.string().max(100_000),
  level: z.enum(["info", "warning", "error"]).default("info"),
  entries: z.array(logEntrySchema).optional(),
});

export const canvasNodeDataSchema = z.discriminatedUnion("kind", [
  taskNodeDataSchema,
  agentNodeDataSchema,
  terminalNodeDataSchema,
  diffNodeDataSchema,
  fileNodeDataSchema,
  contextNodeDataSchema,
  noteNodeDataSchema,
  browserNodeDataSchema,
  imageNodeDataSchema,
  logNodeDataSchema,
]);

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const sizeSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});

export const canvasNodeSchema = z
  .object({
    id: z.string().uuid(),
    boardId: z.string().uuid(),
    type: nodeTypeSchema,
    position: positionSchema,
    size: sizeSchema.optional(),
    zoom: nodeZoomSchema.default("normal"),
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
  });

export const canvasEdgeSchema = z.object({
  id: z.string().uuid(),
  boardId: z.string().uuid(),
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  type: edgeTypeSchema,
  label: z.string().max(80).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const strokeSchema = z.object({
  id: z.string().uuid(),
  color: z.string().min(1).max(32),
  width: z.number().positive().max(64).default(3),
  points: z.array(positionSchema),
});

export const viewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().positive(),
});

export const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;

export const boardSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  sortOrder: z.number().int().default(0),
  viewport: viewportSchema.default(DEFAULT_VIEWPORT),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const boardDocumentSchema = z.object({
  board: boardSchema,
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  strokes: z.array(strokeSchema).default([]),
});

export const workspacePermissionsSchema = z.object({
  read: z.boolean().default(true),
  write: z.boolean().default(true),
  execute: z.boolean().default(true),
});

export const DEFAULT_WORKSPACE_PERMISSIONS = {
  read: true,
  write: true,
  execute: true,
} as const;

export const WORKSPACE_COLORS = [
  "#5B5BD6",
  "#2E7CF6",
  "#1F9D64",
  "#D18F0F",
  "#8A4FD6",
  "#0E9AA7",
  "#E0762E",
  "#DC4C4A",
] as const;

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  rootPath: z.string().min(1),
  color: z.string().min(1).max(32).default(WORKSPACE_COLORS[0]),
  permissions: workspacePermissionsSchema.default(
    DEFAULT_WORKSPACE_PERMISSIONS,
  ),
  gatewayEnabled: z.boolean().default(false),
  lastOpenedAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const boardSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  nodeCount: z.number().int().nonnegative(),
});

export const workspaceSummarySchema = workspaceSchema.extend({
  boards: z.array(boardSummarySchema).default([]),
});

/* ------------------------------------------------------------------ */
/* Legacy mapping (v1 → v2). Runtime performs the durable migration;   */
/* these helpers exist so the web app and tests share one source.      */
/* ------------------------------------------------------------------ */

export const LEGACY_NODE_TYPE_MAP: Record<string, (typeof NODE_TYPES)[number]> =
  {
    folder: "context",
  };

export const LEGACY_EDGE_TYPE_MAP: Record<string, (typeof EDGE_TYPES)[number]> =
  {
    context: "ref",
    input: "dispatch",
    output: "produce",
    patches: "write",
    depends_on: "trigger",
    verifies: "link",
  };

export const LEGACY_NODE_STATUS_MAP: Record<
  string,
  (typeof NODE_STATUSES)[number]
> = {
  failed: "error",
};

export function migrateLegacyNodeType(value: string): CanvasNodeType {
  if ((NODE_TYPES as readonly string[]).includes(value)) {
    return value as CanvasNodeType;
  }
  return LEGACY_NODE_TYPE_MAP[value] ?? "note";
}

export function migrateLegacyEdgeType(value: string): CanvasEdgeType {
  if ((EDGE_TYPES as readonly string[]).includes(value)) {
    return value as CanvasEdgeType;
  }
  return LEGACY_EDGE_TYPE_MAP[value] ?? "link";
}

export function migrateLegacyNodeStatus(value: string): NodeStatus {
  if ((NODE_STATUSES as readonly string[]).includes(value)) {
    return value as NodeStatus;
  }
  return LEGACY_NODE_STATUS_MAP[value] ?? "idle";
}

export type CanvasNodeType = (typeof NODE_TYPES)[number];
export type CanvasEdgeType = (typeof EDGE_TYPES)[number];
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type NodeZoom = (typeof NODE_ZOOMS)[number];
export type SyncPolicy = z.infer<typeof syncPolicySchema>;
export type AdapterId = z.infer<typeof adapterIdSchema>;
export type ChecklistItem = z.infer<typeof checklistItemSchema>;
export type ContextChip = z.infer<typeof contextChipSchema>;
export type ContextChipKind = z.infer<typeof contextChipKindSchema>;
export type DiffFile = z.infer<typeof diffFileSchema>;
export type DiffFileStatus = z.infer<typeof diffFileStatusSchema>;
export type DiffFileState = z.infer<typeof diffFileStateSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type CanvasNodeData = z.infer<typeof canvasNodeDataSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type Stroke = z.infer<typeof strokeSchema>;
export type Viewport = z.infer<typeof viewportSchema>;
export type Board = z.infer<typeof boardSchema>;
export type BoardSummary = z.infer<typeof boardSummarySchema>;
export type BoardDocument = z.infer<typeof boardDocumentSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspacePermissions = z.infer<typeof workspacePermissionsSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type Position = z.infer<typeof positionSchema>;
export type Size = z.infer<typeof sizeSchema>;
