import { z } from "zod";

/**
 * Domain model v3 — see docs/v3-agent-terminal-plan.md §3.4, §5 and §6.
 *
 * Seven node types, a single
 * persisted edge kind, no per-node `status` (agent
 * state lives in the `agent_status` table and is pushed over the workspace
 * event socket) and no `zoom` tri-state (collapse / resize / maximize replace
 * it). The enumerations are exported as plain arrays so the UI can iterate
 * them without re-deriving the list from the zod schema.
 */

export const NODE_TYPES = [
  "terminal",
  "sticky",
  "group",
  "editor",
  "diff",
  "files",
  "browser",
] as const;

/** Only one edge kind is persisted; rope/subagent edges are derived per frame. */
export const EDGE_KINDS = ["link"] as const;

/** Node colour palette — plan §3.4. */
export const NODE_COLORS = [
  "#0a84ff",
  "#32d74b",
  "#ffd60a",
  "#ff453a",
  "#bf5af2",
  "#6ac4dc",
  "#ff9f0a",
] as const;

export const DEFAULT_NODE_COLOR = NODE_COLORS[0];

export const AGENT_STATES = ["working", "waiting", "blocked", "done"] as const;

export const PERMISSION_MODES = [
  "default",
  "auto-edit",
  "full-auto",
  "plan",
] as const;

export const nodeTypeSchema = z.enum(NODE_TYPES);
export const edgeKindSchema = z.enum(EDGE_KINDS);
export const nodeColorSchema = z.enum(NODE_COLORS);
export const agentStateSchema = z.enum(AGENT_STATES);
export const permissionModeSchema = z.enum(PERMISSION_MODES);

const timestampSchema = z.string().datetime({ offset: true });

/* --------------------------------- node data ----------------------------- */

/**
 * Built-in agent ids plus `custom:<id>` for user-defined CLIs. Kept here (and
 * not in `agents.ts`) so the node schema does not depend on the registry.
 */
export const agentIdSchema = z
  .string()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      [
        "claude",
        "codex",
        "gemini",
        "opencode",
        "pi",
        "omp",
        "copilot",
      ].includes(value) || /^custom:[A-Za-z0-9._:-]{1,64}$/.test(value),
    { message: "Unknown agent id" },
  );

/** A launch armed by `open-agent --after A,B`; the PTY stays a plain shell until every dependency is done. */
export const pendingLaunchSchema = z.object({
  command: z.string().max(4_000),
  after: z.array(z.string().uuid()).max(32).default([]),
});

export const terminalAgentSchema = z.object({
  id: agentIdSchema,
  accountId: z.string().max(120).optional(),
  permissionMode: permissionModeSchema.optional(),
  model: z.string().max(120).optional(),
  /** Session id reported by the CLI (via hooks) or pre-minted by us. */
  sessionId: z.string().max(200).optional(),
  /** Launch line written into the shell once it is ready. */
  initialCommand: z.string().max(4_000).optional(),
  pendingLaunch: pendingLaunchSchema.optional(),
});

/**
 * The SSH host a terminal node connects to (plan §21). Only the id is stored:
 * host, user, port and key live in `settings.ssh.hosts[]`, so editing a host
 * changes every node that points at it and a board file never carries a
 * command line.
 */
export const sshTargetSchema = z.object({
  hostId: z.string().min(1).max(64),
});

export const terminalNodeDataSchema = z.object({
  kind: z.literal("terminal"),
  sessionId: z.string().uuid().optional(),
  cwd: z.string().max(4_000).optional(),
  shell: z.string().max(1_024).optional(),
  ssh: sshTargetSchema.optional(),
  agent: terminalAgentSchema.optional(),
  lastExitCode: z.number().int().nullable().optional(),
});

export const MAX_STICKY_CONTENT = 20_000;

export const stickyNodeDataSchema = z.object({
  kind: z.literal("sticky"),
  content: z.string().max(MAX_STICKY_CONTENT).default(""),
});

/** The group label is `node.title` and its tint is `node.color`. */
export const groupNodeDataSchema = z.object({
  kind: z.literal("group"),
});

export const editorNodeDataSchema = z.object({
  kind: z.literal("editor"),
  path: z.string().min(1).max(4_000),
  language: z.string().max(40).optional(),
  readonly: z.boolean().optional(),
});

export const DIFF_SCOPES = ["worktree", "staged"] as const;
export const diffScopeSchema = z.enum(DIFF_SCOPES);

export const diffNodeDataSchema = z.object({
  kind: z.literal("diff"),
  repoPath: z.string().min(1).max(4_000),
  scope: diffScopeSchema.default("worktree"),
  paths: z.array(z.string().max(4_000)).max(1_000).optional(),
});

export const filesNodeDataSchema = z.object({
  kind: z.literal("files"),
  path: z.string().min(1).max(4_000),
});

export const browserNodeDataSchema = z.object({
  kind: z.literal("browser"),
  url: z.string().max(4_000).default(""),
});

export const canvasNodeDataSchema = z.discriminatedUnion("kind", [
  terminalNodeDataSchema,
  stickyNodeDataSchema,
  groupNodeDataSchema,
  editorNodeDataSchema,
  diffNodeDataSchema,
  filesNodeDataSchema,
  browserNodeDataSchema,
]);

/* ---------------------------------- geometry ----------------------------- */

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

/* ---------------------------------- boards ------------------------------- */

export const viewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().positive(),
});

export const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;

/** Opaque retirement records. No update request schema or canvas state owns them. */
export const legacyKanbanArchiveSummarySchema = z.object({
  canvasId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  canvasName: z.string(),
  archivedAt: z.string(),
  kanbanBytes: z.number().int().nonnegative().safe(),
  labelCount: z.number().int().nonnegative().safe(),
});
export const legacyNodeLabelArchiveSchema = z.object({
  nodeId: z.string(),
  canvasId: z.string(),
  workspaceId: z.string().nullable(),
  nodeTitle: z.string(),
  nodeType: z.string(),
  labelsJson: z.string(),
  note: z.string(),
  nodeCreatedAt: z.string(),
  nodeUpdatedAt: z.string(),
  archivedAt: z.string(),
});
export const legacyKanbanArchiveSchema =
  legacyKanbanArchiveSummarySchema.extend({
    kanbanJson: z.string(),
    kanbanSha256: z.string().regex(/^[a-f0-9]{64}$/),
    canvasCreatedAt: z.string(),
    canvasUpdatedAt: z.string(),
    labels: z.array(legacyNodeLabelArchiveSchema),
  });
export const legacyKanbanArchivePageSchema = z.object({
  archives: z.array(legacyKanbanArchiveSummarySchema),
  nextCursor: z.string().nullable(),
});
export const legacyKanbanArchiveExportSchema = z.object({
  formatVersion: z.literal(1),
  archive: legacyKanbanArchiveSchema,
});
export type LegacyKanbanArchiveSummary = Readonly<
  z.infer<typeof legacyKanbanArchiveSummarySchema>
>;
export type LegacyNodeLabelArchive = Readonly<
  z.infer<typeof legacyNodeLabelArchiveSchema>
>;
export type LegacyKanbanArchive = Readonly<
  z.infer<typeof legacyKanbanArchiveSchema>
>;

/**
 * Whiteboard snapshot cap — tldraw plan §6.1. Images never live inside the
 * snapshot (they go through the asset endpoint), so this is only ink, shapes
 * and text; 8 MiB is far beyond anything a hand can draw.
 */
export const MAX_WHITEBOARD_BYTES = 8 * 1024 * 1024;

export const boardSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  sortOrder: z.number().int().default(0),
  viewport: viewportSchema.default(DEFAULT_VIEWPORT),
  /**
   * Opaque tldraw store snapshot (JSON string) holding the whiteboard-native
   * records only — tldraw plan §6.1. Empty string = no whiteboard content.
   * Defaulted so a document written before migration 0009 still parses.
   */
  whiteboard: z.string().max(MAX_WHITEBOARD_BYTES).default(""),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const boardDocumentSchema = z.object({
  board: boardSchema,
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
});

/* -------------------------------- workspaces ----------------------------- */

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

/* ------------------------------- agent status ---------------------------- */

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

export type CanvasNodeType = (typeof NODE_TYPES)[number];
export type CanvasEdgeKind = (typeof EDGE_KINDS)[number];
export type NodeColor = (typeof NODE_COLORS)[number];
export type AgentState = (typeof AGENT_STATES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type DiffScope = (typeof DIFF_SCOPES)[number];
export type TerminalAgent = z.infer<typeof terminalAgentSchema>;
export type SshTarget = z.infer<typeof sshTargetSchema>;
export type PendingLaunch = z.infer<typeof pendingLaunchSchema>;
export type CanvasNodeData = z.infer<typeof canvasNodeDataSchema>;
export type TerminalNodeData = z.infer<typeof terminalNodeDataSchema>;
export type StickyNodeData = z.infer<typeof stickyNodeDataSchema>;
export type GroupNodeData = z.infer<typeof groupNodeDataSchema>;
export type EditorNodeData = z.infer<typeof editorNodeDataSchema>;
export type DiffNodeData = z.infer<typeof diffNodeDataSchema>;
export type FilesNodeData = z.infer<typeof filesNodeDataSchema>;
export type BrowserNodeData = z.infer<typeof browserNodeDataSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type Viewport = z.infer<typeof viewportSchema>;
export type Board = z.infer<typeof boardSchema>;
export type BoardSummary = z.infer<typeof boardSummarySchema>;
export type BoardDocument = z.infer<typeof boardDocumentSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspacePermissions = z.infer<typeof workspacePermissionsSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type Position = z.infer<typeof positionSchema>;
export type Size = z.infer<typeof sizeSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
