import { z } from "zod";

import { agentProbeSchema } from "./agent-capabilities.js";
import { AGENT_CAPABILITIES, AGENT_IDS, PROMPT_MODES } from "./agents.js";
import {
  agentEventSchema,
  agentIdSchema,
  agentStateSchema,
  agentStatusSchema,
  boardDocumentSchema,
  boardSchema,
  canvasEdgeSchema,
  canvasNodeSchema,
  diffScopeSchema,
  permissionModeSchema,
  sshTargetSchema,
  viewportSchema,
  workspacePermissionsSchema,
  workspaceSchema,
  workspaceSummarySchema,
  MAX_WHITEBOARD_BYTES,
} from "./domain.js";

/**
 * Runtime API v3 — see docs/v3-agent-terminal-plan.md §7.
 *
 * The ACP surface (`/api/agents/run`, `/api/agents/{id}/ws`,
 * `/api/agents/context-preview`) and `/api/gateway` are gone: agents are CLIs
 * running inside terminal nodes and report through hooks.
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
  /**
   * `rootPath` does not exist yet and the runtime must `mkdir` it (plan §20,
   * 新建文件夹). The parent has to exist and the leaf must not.
   */
  createDirectory: z.boolean().optional(),
});

export const updateWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: z.string().min(1).max(32).optional(),
  permissions: workspacePermissionsSchema.optional(),
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
  }),
);

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

/** How a file's lines end. `mixed` cannot round-trip and is reported as such. */
export const fileEolSchema = z.enum(["lf", "crlf", "mixed", "none"]);

/** `unknown` means the bytes are not valid UTF-8, so the file is read-only. */
export const fileEncodingSchema = z.enum(["utf-8", "unknown"]);

export const fileContentSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  /**
   * The content version for the next save. Absent for a file that is not valid
   * UTF-8: the editor is showing a lossy reading and must not write it back.
   */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** Older runtimes answer without these; the editor then shows no badge. */
  encoding: fileEncodingSchema.optional(),
  /** A UTF-8 BOM was stripped from `content`; a save passes it back. */
  bom: z.boolean().optional(),
  eol: fileEolSchema.optional(),
  /** The file itself cannot be written, whatever the workspace allows. */
  readonly: z.boolean().optional(),
});

export const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_IMPORT_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_FILES = 256;
export const fileInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  preview: z.enum(["text", "image", "download"]),
});
export const importFilesResponseSchema = z.object({
  path: z.string(),
  files: z.array(fileInfoSchema),
});
export type ImportedFileInfo = z.infer<typeof fileInfoSchema>;
export type ImportFilesResponse = z.infer<typeof importFilesResponseSchema>;

/** Runtime ceiling for `PUT /api/workspaces/{id}/file`. */
export const MAX_WRITE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * `PUT /api/workspaces/{id}/file` — the editor node's save.
 *
 * Existing files require their observed SHA-256. Omitting it creates only a
 * new file; the legacy size field alone cannot authorize an overwrite.
 */
export const writeFileRequestSchema = z.object({
  path: z.string().min(1).max(4_000),
  content: z.string().max(MAX_WRITE_FILE_BYTES),
  expectedSize: z.number().int().nonnegative().optional(),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /**
   * Re-emit the UTF-8 BOM the read stripped, so a file that arrived with one
   * keeps it. Omitted means no BOM, which is what a new file wants.
   */
  bom: z.boolean().optional(),
});

export const writeFileResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/* ------------------------------ file watching ---------------------------- */

/**
 * `GET /api/workspaces/{id}/file-version?path=` — what is on disk right now.
 *
 * A missing file answers `exists: false` rather than 404: the editor keeps the
 * draft of a deleted file. `sha256` is absent for a file above the write
 * limit, which the editor refuses to open anyway.
 */
export const fileVersionSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish(),
  size: z.number().int().nonnegative().nullish(),
  /** RFC 3339 when the platform reports one. */
  mtime: z.string().nullish(),
});

/** `POST /api/workspaces/{id}/file-watch` — an editor node opens a file. */
export const watchFileRequestSchema = z.object({
  path: z.string().min(1).max(4_000),
  nodeId: z.string().min(1).max(128),
});

/**
 * `watching` = changes arrive as `file.changed`. `unsupported` = no platform
 * watcher (backend missing, descriptor or queue limit); the client falls back
 * to asking `file-version` on demand.
 */
export const watchStatusSchema = z.enum(["watching", "unsupported"]);

export const watchRegistrationSchema = z.object({
  status: watchStatusSchema,
  reason: z.string().nullish(),
  version: fileVersionSchema,
});

/** How the file on disk differs from what the editor last read. */
export const fileChangeKindSchema = z.enum(["modified", "removed", "replaced"]);

/* --------------------------- search and file work ------------------------ */

/**
 * `GET /api/workspaces/{id}/file-index?query=&limit=` — 快速打开.
 *
 * A fuzzy filename match with build folders skipped. `truncated` says the list
 * was cut: either more files matched than `limit`, or the walk hit its own
 * ceiling. The client shows that rather than implying a complete answer.
 */
export const fileIndexEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
});

export const fileIndexSchema = z.object({
  entries: z.array(fileIndexEntrySchema),
  truncated: z.boolean(),
  scanned: z.number().int().nonnegative(),
});

/** `POST /api/workspaces/{id}/file-search` — 项目搜索. */
export const fileSearchRequestSchema = z.object({
  query: z.string().min(1).max(1_000),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  /** Comma-separated globs; empty means every file. */
  include: z.string().max(500).optional(),
  exclude: z.string().max(500).optional(),
  maxMatchesPerFile: z.number().int().positive().optional(),
  /** How many *files* one page carries. */
  limit: z.number().int().positive().optional(),
  /** `nextOffset` from the previous page. */
  offset: z.number().int().nonnegative().optional(),
});

export const fileSearchMatchSchema = z.object({
  /** 1-based, ready for “open at line”. */
  line: z.number().int().positive(),
  /** 1-based, counted in characters. */
  column: z.number().int().positive(),
  length: z.number().int().nonnegative(),
  preview: z.string(),
  previewTruncated: z.boolean(),
});

export const fileSearchFileSchema = z.object({
  path: z.string(),
  matches: z.array(fileSearchMatchSchema),
  /** The file had more matches than the per-file ceiling allowed. */
  truncated: z.boolean(),
});

export const fileSearchResultSchema = z.object({
  files: z.array(fileSearchFileSchema),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** The runtime's wall-clock budget ran out before the walk finished. */
  timedOut: z.boolean(),
  /** Files not read: above the size limit, or binary. */
  skipped: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullish(),
});

export const fileEntryKindSchema = z.enum(["file", "directory"]);

/** `POST /api/workspaces/{id}/file-entries` — 新建文件 / 新建文件夹. */
export const createFileEntryRequestSchema = z.object({
  path: z.string().min(1).max(4_000),
  kind: fileEntryKindSchema,
});

/** `POST …/file-entries/rename` — 重命名 and 移动 are one operation. */
export const renameFileEntryRequestSchema = z.object({
  from: z.string().min(1).max(4_000),
  to: z.string().min(1).max(4_000),
});

export const fileEntryResultSchema = z.object({
  path: z.string(),
  kind: fileEntryKindSchema,
});

/**
 * One entry in `<workspace>/.armadra/trash/`. Deleting moves bytes there and
 * `POST …/file-entries/restore` puts them back; nothing deletes permanently.
 */
export const trashEntrySchema = z.object({
  id: z.string(),
  originalPath: z.string(),
  name: z.string(),
  kind: fileEntryKindSchema,
  deletedAt: z.string(),
});

export const trashListSchema = z.array(trashEntrySchema);

/**
 * `GET /api/workspaces/{id}/language-service` — capability probe.
 *
 * Armadra has no LSP yet, so `unavailable` is the only answer the runtime
 * gives. The editor shows no completion affordances rather than an empty list
 * pretending to be one (editor design §2, §4).
 */
export const languageServiceStatusSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.string().optional(),
});

/* ---------------------------------- terminals ---------------------------- */

/** Agent block on `POST /api/terminals`; drives the injected `ARMADRA_*` env. */
export const createTerminalAgentSchema = z.object({
  id: agentIdSchema,
  accountId: z.string().max(120).optional(),
  permissionMode: permissionModeSchema.optional(),
  model: z.string().max(120).optional(),
  sessionId: z.string().max(200).optional(),
});

/* ------------------------------------ SSH -------------------------------- */

/**
 * One entry of `settings.ssh.hosts[]` (plan §21).
 *
 * The rules below are the same ones `apps/runtime/src/terminal/ssh.rs`
 * enforces: the runtime drops entries that fail them, so validating here means
 * the settings form refuses a host instead of losing it silently. The command
 * is always argv, never a shell string — hence "no whitespace, no
 * metacharacter" rather than quoting.
 */
export const SSH_HOSTNAME_PATTERN = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/;
export const SSH_USER_PATTERN = /^[A-Za-z0-9._-]+$/;
/** Anything a shell would look at twice, plus whitespace and control chars. */
export const SSH_UNSAFE_PATTERN = /[\s;&|$`<>(){}*?!\\'"]/;
/** `-o ProxyCommand=…` and friends run a local program; not storable. */
const SSH_FORBIDDEN_OPTIONS = [
  "proxycommand",
  "localcommand",
  "permitlocalcommand",
];

export const sshExtraArgSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.startsWith("-"), { message: "Must start with -" })
  .refine((value) => !SSH_UNSAFE_PATTERN.test(value), {
    message: "Unsafe character",
  })
  .refine(
    (value) =>
      !SSH_FORBIDDEN_OPTIONS.some((option) =>
        value.toLowerCase().includes(option),
      ),
    { message: "Option is not allowed" },
  );

export const sshHostSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(64),
  host: z.string().max(255).regex(SSH_HOSTNAME_PATTERN),
  user: z.string().max(64).regex(SSH_USER_PATTERN).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  identityFile: z
    .string()
    .max(4_096)
    .refine((value) => value.startsWith("/"), { message: "Must be absolute" })
    .refine((value) => !SSH_UNSAFE_PATTERN.test(value), {
      message: "Unsafe character",
    })
    .optional(),
  extraArgs: z.array(sshExtraArgSchema).max(16).optional(),
});

/** `POST /api/ssh/hosts/{id}/test` — one `ssh … true` probe. */
export const sshTestResultSchema = z.object({
  ok: z.boolean(),
  /** Tail of ssh's diagnostics, redacted by the runtime. May be empty. */
  output: z.string(),
});

export const createTerminalRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  cwd: z.string(),
  shell: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  /** Terminal node that owns this session; required for hook attribution. */
  nodeId: z.string().uuid().optional(),
  agent: createTerminalAgentSchema.optional(),
  /**
   * Runs `ssh …` instead of a shell. Only the id travels; the runtime builds
   * the argv from its own settings and refuses an id it does not know.
   */
  ssh: sshTargetSchema.optional(),
});

// The runtime also emits `kind` and `ownerNodeId` on this payload.
// A non-strict z.object drops unknown keys silently. Do NOT add `.strict()`:
// it would turn every terminal fetch into a parse error.
export const TERMINAL_BACKENDS = ["direct", "tmux"] as const;
export const terminalBackendKindSchema = z.enum(TERMINAL_BACKENDS);
export const TERMINAL_ATTACH_STATES = ["detached", "live", "exited"] as const;
export const terminalAttachStateSchema = z.enum(TERMINAL_ATTACH_STATES);

export const terminalSessionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  cwd: z.string(),
  shell: z.string(),
  agentId: z.string().nullable().optional(),
  command: z.string().nullable(),
  status: z.enum(["running", "exited", "failed", "terminated"]),
  exitCode: z.number().int().nullable(),
  pid: z.number().int().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  /* plan §15.2 — absent on runtimes older than migration 0005 */
  sessionKey: z.string().optional(),
  backend: terminalBackendKindSchema.optional(),
  generation: z.number().int().nonnegative().optional(),
  attachState: terminalAttachStateSchema.optional(),
  lastOutputAt: z.string().datetime({ offset: true }).nullable().optional(),
});

/** `GET /api/terminals/backend` — which backend is in effect (plan §15.1). */
export const terminalBackendInfoSchema = z.object({
  effective: terminalBackendKindSchema,
  configured: z.enum(["auto", "tmux", "direct"]),
  tmuxVersion: z.string().nullable(),
  tmuxSocket: z.string().nullable(),
  reason: z.string().nullable(),
});

/** `GET /api/terminals/{id}/capture?lines=&escapes=` */
export const terminalCaptureResponseSchema = z.object({
  generation: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  data: z.string(),
});

/** `POST /api/terminals/{id}/paste` — bracketed paste, optional Enter. */
export const terminalPasteRequestSchema = z.object({
  text: z.string().max(200_000),
  enter: z.boolean().default(false),
});

export const TERMINATE_MODES = ["interrupt", "process", "session"] as const;
export const terminateModeSchema = z.enum(TERMINATE_MODES);
/** `POST /api/terminals/{id}/terminate` */
export const terminalTerminateRequestSchema = z.object({
  mode: terminateModeSchema.default("process"),
});

/** `GET /api/workspaces/{id}/sessions` — the sessions sidebar payload. */
export const sessionSummarySchema = z.object({
  nodeId: z.string(),
  boardId: z.string(),
  sessionId: z.string(),
  kind: z.literal("terminal"),
  title: z.string(),
  cwd: z.string(),
  agentId: agentIdSchema.optional(),
  state: agentStateSchema.optional(),
  unread: z.boolean().default(false),
  pendingId: z.string().optional(),
  updatedAt: z.string().datetime({ offset: true }),
  /** The PTY is still running in this runtime instance. */
  alive: z.boolean(),
});

export const sessionsResponseSchema = z.array(sessionSummarySchema);

/* -------------------------------- conversations -------------------------- */

/** Which CLI wrote the transcript a conversation row was read from. */
export const CONVERSATION_PROVIDERS = ["claude", "codex", "gemini"] as const;
export const conversationProviderSchema = z.enum(CONVERSATION_PROVIDERS);

/**
 * `GET /api/conversations?q=&limit=` — one row per transcript found on this
 * machine, newest first (plan §16/§17).
 *
 * `path` is deliberately not exposed: the palette shows a title, a directory
 * and a time, and resuming needs only `provider` + `sessionId`. Keeping the
 * absolute transcript path out of the response keeps the browser side of the
 * app from growing an opinion about the user's disk.
 */
export const conversationSchema = z.object({
  provider: conversationProviderSchema,
  sessionId: z.string().min(1),
  title: z.string(),
  /** Working directory the session ran in; empty when the CLI does not record one. */
  cwd: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
  bytes: z.number().int().nonnegative(),
});

export const conversationsResponseSchema = z.array(conversationSchema);

/** `POST /api/conversations/refresh` — what the forced rescan did. */
export const conversationRefreshResponseSchema = z.object({
  /** Transcript files looked at, across all providers. */
  scanned: z.number().int().nonnegative(),
  /** Rows inserted or updated because the file was new or its mtime moved. */
  indexed: z.number().int().nonnegative(),
  /** Rows dropped because their file is gone. */
  removed: z.number().int().nonnegative(),
  /** Rows in the index afterwards. */
  total: z.number().int().nonnegative(),
});

/* ----------------------------------- agents ------------------------------ */

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
 * What a linked whiteboard shape reads as (tldraw plan §6.3). Only present
 * when `kind === "shape"`: text shapes carry their text, everything else is
 * rasterised by the client and referenced by a workspace-relative PNG path.
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
  /** Node id, or the uuid part of a whiteboard shape id (`shape:<uuid>`). */
  id: z.string().uuid(),
  title: z.string().max(160),
  /** A node type, or `"shape"` for whiteboard content (tldraw plan §6.3). */
  kind: z.string().max(40),
  content: contextLinkContentSchema.optional(),
});

/* --------------------------- deliveries / control ------------------------- */

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

/* ------------------------------- node exports ----------------------------- */

/**
 * `POST /api/workspaces/{id}/exports/{exportId}/png` — tldraw plan §6.3.
 *
 * Whatever is being exported — ink, a geo shape or a whole frame — only exists
 * as vectors inside the browser, so the web app is the only party that can
 * rasterise it. It uploads a `data:image/png;base64,…` URL and the runtime
 * drops the bytes into `<workspace>/.armadra/exports/<exportId>.png`, where a
 * linked agent reads them with its own file tools. The id only has to be a
 * uuid: it is not looked up as a node, which is what lets a whiteboard shape
 * be exported at all.
 */
export const MAX_EXPORT_PNG_BYTES = 8 * 1024 * 1024;

export const exportPngRequestSchema = z.object({
  dataUrl: z
    .string()
    .max(MAX_EXPORT_PNG_BYTES)
    .refine((value) => value.startsWith("data:image/png;base64,"), {
      message: "Only base64 PNG data URLs may be exported",
    }),
});

export const exportPngResponseSchema = z.object({
  /** Absolute path — what an agent is told to open. */
  path: z.string(),
  /** The same file relative to the workspace root — `ContextLink.content.pngPath`. */
  relativePath: z.string(),
  bytes: z.number().int().nonnegative(),
});

/* --------------------------------- assets -------------------------------- */

/**
 * `POST /api/workspaces/{id}/assets` — tldraw plan §6.2.
 *
 * Backs `TLAssetStore.upload`. Two body shapes, because the client has two
 * kinds of source:
 *
 *   - a `File` / `Blob` is posted **raw** with its own `Content-Type`;
 *   - an already-decoded data URL (a paste, say) is posted as `{ dataUrl }`
 *     with `Content-Type: application/json`.
 *
 * The stored name is the content hash, so the same picture uploaded twice is
 * one file. Only the eight image types below are accepted — the extension ends
 * up in a file name and the type is echoed back as a `Content-Type`, so neither
 * may come from the client.
 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export const ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "image/bmp",
] as const;

export const uploadAssetRequestSchema = z.object({
  dataUrl: z.string().max(MAX_ASSET_BYTES * 2),
});

export const uploadAssetResponseSchema = z.object({
  /** `<sha256[..16]>.<ext>`; also the last segment of `url` and `path`. */
  id: z.string(),
  /** Workspace-relative path (`.armadra/assets/<id>`) — what an agent is handed. */
  path: z.string(),
  /**
   * Runtime-**relative** URL path. The client prefixes its own runtime origin:
   * the runtime does not know which port it was actually bound to.
   */
  url: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
});

/**
 * `POST /api/workspaces/{id}/assets/import` — tldraw plan §8, Phase 3.
 *
 * The desktop shell only learns a *path* when the OS drops a file on it, never
 * the bytes, so the runtime reads the file and stores it exactly as an upload
 * would — same content-addressed name, same `uploadAssetResponseSchema` back.
 * An absolute path may sit outside the workspace (a Finder drag usually comes
 * from `~/Downloads`); a relative one is resolved against the workspace root.
 */
export const importAssetRequestSchema = z.object({
  path: z.string().min(1).max(4_096),
});

export const contextLinksRequestSchema = z.object({
  links: z.array(contextLinkSchema).max(64).default([]),
});

export const contextLinksResponseSchema = z.object({
  nodeId: z.string(),
  links: z.array(contextLinkSchema).default([]),
  updatedAt: z.string().datetime({ offset: true }),
});

/* ------------------------------------- git ------------------------------- */

export const diffFileStatusSchema = z.enum(["M", "A", "D", "R", "?"]);

/**
 * One row of `git status --porcelain=v1 -z`: `staged` is the `X` column (index
 * vs HEAD), `unstaged` the `Y` column (working tree vs index). Both can be true
 * for a file edited again after staging.
 *
 * This is the only source for the file-tree badges — they must not fetch a
 * diff, which is orders of magnitude more expensive.
 */
export const gitFileStatusSchema = z.object({
  path: z.string(),
  status: diffFileStatusSchema,
  staged: z.boolean(),
  unstaged: z.boolean(),
});

export const gitStatusSchema = z.object({
  repository: z.boolean(),
  branch: z.string().nullable(),
  changedCount: z.number().int().nonnegative(),
  // `null` is meaningful here (detached HEAD / no upstream => distance unknown)
  // and it is also what serde emits for `Option::None`, so accept both null and
  // an omitted key rather than making every git-status fetch throw.
  ahead: z.number().int().nonnegative().nullish(),
  behind: z.number().int().nonnegative().nullish(),
  /** Absent on runtimes older than this version, hence the default. */
  files: z.array(gitFileStatusSchema).default([]),
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
  /** The patch is `git diff --cached`, i.e. it came from the `staged` scope. */
  staged: z.boolean().default(false),
});

/** Query for `GET /api/workspaces/{id}/git/diff`. */
export const gitDiffRequestSchema = z.object({
  /** Directory the diff is scoped to; the repository root by default. */
  path: z.string().min(1).max(4_000).optional(),
  scope: diffScopeSchema.default("worktree"),
  /** When present only these files are diffed, `path` is ignored. */
  paths: z.array(z.string().min(1).max(4_000)).max(200).optional(),
  /**
   * Display option (`--ignore-all-space`): whitespace-only differences drop
   * out of the patch and its line counts. The file list is unaffected, so a
   * whitespace-only edit still shows up — with an empty patch and 0/0. Nothing
   * is ever staged, applied, or committed from a whitespace-ignoring diff.
   */
  ignoreWhitespace: z.boolean().default(false),
});

export const gitDiffSchema = z.object({
  repository: z.boolean(),
  clean: z.boolean(),
  files: z.array(gitFileDiffSchema),
});

/**
 * `POST /api/workspaces/{id}/git/init` — only offered once a read reported
 * `repository: false`. A workspace that already belongs to any repository is
 * refused rather than nested, so this response always describes a new one.
 */
export const gitInitResponseSchema = z.object({
  repository: z.literal(true),
  /** The unborn branch Git selected; null when it left HEAD detached. */
  branch: z.string().nullable(),
  path: z.string(),
});

export const gitPathsRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

/**
 * Which version a restore takes a tracked file back to. `index` keeps the
 * staged change and drops only the unstaged edit on top of it; `head` also
 * discards the staged change and unstages the file. They lose different work,
 * so the UI offers them as two separate actions rather than one “revert”.
 */
export const gitRestoreSourceSchema = z.enum(["index", "head"]);

/**
 * `POST /api/workspaces/{id}/git/resolve` — stage a conflicted path. Saving a
 * merged file never marks it resolved on its own; the service re-reads the
 * file and refuses while any Git conflict marker is still in it.
 */
export const gitResolveResponseSchema = z.object({
  resolved: z.array(z.string()),
});

export const gitRevertRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  source: gitRestoreSourceSchema.default("index"),
});

export const gitStageResponseSchema = z.object({
  staged: z.array(z.string()),
});

export const gitRevertResponseSchema = z.object({
  reverted: z.array(z.string()),
});

/**
 * `POST /api/workspaces/{id}/git/unstage` — `git restore --staged`. The working
 * tree is untouched, so this is not a destructive action and needs no
 * confirmation dialog (unlike revert).
 */
export const gitUnstageResponseSchema = z.object({
  unstaged: z.array(z.string()),
});

/**
 * `GET /api/workspaces/{id}/git/head-commit` — the commit an amend would
 * rewrite, or null on an unborn branch. `published` means a remote-tracking
 * ref already contains it, so rewriting it rewrites shared history.
 */
export const gitHeadCommitSchema = z
  .object({
    oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    subject: z.string(),
    /** Full message so an amend can start from it; empty when truncated. */
    message: z.string(),
    /** The stored message is too large to resend; amending is refused. */
    truncated: z.boolean(),
    published: z.boolean(),
  })
  .nullable();

export const gitCommitRequestSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  /** When present only these paths are committed (they are staged first). */
  paths: z.array(z.string().min(1)).max(200).optional(),
  /**
   * Rewriting the current commit. Never implied: the composer sends the OID
   * it displayed, and a published commit additionally needs the explicit
   * acknowledgement. An amend never pushes anything.
   */
  amend: z
    .object({
      expectedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
      allowPublished: z.boolean(),
    })
    .strict()
    .optional(),
});

export const gitCommitResponseSchema = z.object({
  commit: z.string(),
  committed: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

/* ------------------------------- git clone ------------------------------- */

/**
 * `POST /api/git/clone` (plan §20, 克隆仓库). Only `https://`, `ssh://` and
 * `user@host:path` are accepted; `parent` must be an existing directory and
 * `name` defaults to the repository basename without `.git`.
 */
export const gitCloneRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  parent: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});

/** The clone runs in the background; the dialog polls the job. */
export const gitCloneStartedSchema = z.object({
  jobId: z.string(),
});

export const gitCloneStateSchema = z.enum(["running", "done", "error"]);

/**
 * `GET /api/git/clone/{jobId}`. `lines` is the tail of `git clone --progress`
 * stderr (at most 20 lines); `workspace` only appears once the clone finished
 * and the runtime registered the directory as a workspace.
 */
export const gitCloneStatusSchema = z.object({
  state: gitCloneStateSchema,
  lines: z.array(z.string()).default([]),
  workspace: workspaceSchema.nullish(),
  error: z.string().nullish(),
});

/* ------------------------------- terminal WS ----------------------------- */

/** Client → runtime on `WS /api/terminals/{id}/ws` (mirrors pty.rs ClientMessage). */
export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  /** Three-level semantics (plan §15.5); `mode` defaults to `process`. */
  z.object({
    type: z.literal("terminate"),
    mode: terminateModeSchema.optional(),
  }),
]);

/**
 * Runtime → client. `status` carries the terminal lifecycle
 * (`running` / `exited` / `failed` / `terminated`); an exit is a
 * `status` frame with `exitCode` set, and is mirrored workspace-wide as
 * `terminal.exit` on the workspace event socket.
 */
export const terminalServerMessageSchema = z.discriminatedUnion("type", [
  /** First frame after connect = attach (plan §15.5). */
  z.object({
    type: z.literal("hello"),
    sessionId: z.string(),
    generation: z.number().int().nonnegative(),
    backend: terminalBackendKindSchema,
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
    alive: z.boolean(),
  }),
  /** Replay/screen snapshot; direct backend only (tmux client redraws). */
  z.object({ type: z.literal("snapshot"), data: z.string() }),
  /** The generation the client attached with is gone; clear and rebuild. */
  z.object({
    type: z.literal("stale"),
    generation: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({
    type: z.literal("status"),
    status: z.enum(["running", "exited", "failed", "terminated"]),
    exitCode: z.number().int().nullable().optional(),
  }),
  z.object({ type: z.literal("warning"), message: z.string() }),
]);

/* --------------------------------- 资源面板 ------------------------------- */

/**
 * Host / session resources and wake leases (T02, terminal host design §8/§9).
 *
 * Every metric is `.nullable()` on purpose. The runtime sends `null` for
 * anything this machine cannot answer, and the panel renders that as an em
 * dash — a `0` would read as "idle", which is a different and wrong statement.
 * A schema that defaulted the nulls away would erase exactly that distinction.
 */
export const resourceLocationSchema = z.enum(["local", "remote"]);

export const resourceMemorySchema = z.object({
  totalBytes: z.number().int().nonnegative().nullable(),
  usedBytes: z.number().int().nonnegative().nullable(),
  availableBytes: z.number().int().nonnegative().nullable(),
  swapTotalBytes: z.number().int().nonnegative().nullable(),
  swapUsedBytes: z.number().int().nonnegative().nullable(),
});

export const resourceLoadAverageSchema = z.object({
  one: z.number(),
  five: z.number(),
  fifteen: z.number(),
});

export const resourceDiskSchema = z.object({
  mountPoint: z.string(),
  totalBytes: z.number().int().nonnegative().nullable(),
  availableBytes: z.number().int().nonnegative().nullable(),
});

/**
 * Mains / battery. A desktop reports `source: "ac"` with a null percentage —
 * "on mains, no battery" — which is not the same as `source: null`, "we could
 * not tell".
 */
export const resourcePowerSourceSchema = z.object({
  source: z.enum(["ac", "battery"]).nullable(),
  batteryPercent: z.number().min(0).max(100).nullable(),
  charging: z.boolean().nullable(),
});

export const hostResourcesSchema = z.object({
  hostId: z.string(),
  location: resourceLocationSchema,
  platform: z.string(),
  cpuPercent: z.number().nonnegative().nullable(),
  cpuCores: z.number().int().positive().nullable(),
  memory: resourceMemorySchema,
  loadAverage: resourceLoadAverageSchema.nullable(),
  disk: resourceDiskSchema.nullable(),
  power: resourcePowerSourceSchema,
  uptimeSeconds: z.number().int().nonnegative().nullable(),
  sampledAt: z.string(),
});

/** Why a session carries no numbers. */
export const resourceUnknownReasonSchema = z.enum([
  "remote",
  "exited",
  "no-pid",
  "not-found",
  "warming-up",
]);

/**
 * One process the runtime measured.
 *
 * Identity is the pair `(pid, startTimeUnixMs)`: operating systems reuse pids,
 * so a pid on its own would let a process that died merge with an unrelated
 * one that inherited its number (design §8 "按 PID + startTime 去重").
 * `name` is the executable's file name — never a command line.
 */
export const processSampleSchema = z.object({
  pid: z.number().int(),
  startTimeUnixMs: z.number().int().nullable(),
  name: z.string(),
  parentPid: z.number().int().nullable(),
  memoryBytes: z.number().int().nonnegative().nullable(),
  cpuPercent: z.number().nonnegative().nullable(),
});

export const sessionResourcesSchema = z.object({
  sessionId: z.string(),
  sessionKey: z.string(),
  workspaceId: z.string(),
  nodeId: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  backend: terminalBackendKindSchema,
  location: resourceLocationSchema,
  cwd: z.string(),
  pid: z.number().int().nullable(),
  alive: z.boolean(),
  cpuPercent: z.number().nonnegative().nullable(),
  /**
   * An RSS sum over the process tree. `memoryEstimated` is always true when a
   * figure is present: processes that share pages have those pages counted
   * once per process, so this is not exclusive memory and must not be shown
   * as such (design §8).
   */
  memoryBytes: z.number().int().nonnegative().nullable(),
  memoryEstimated: z.boolean(),
  childCount: z.number().int().nonnegative().nullable(),
  state: z.string().nullable(),
  /** The leader's start time, so a restarted session is not a reused pid. */
  startTimeUnixMs: z.number().int().nullable(),
  /**
   * The tree under the leader, heaviest first and capped by the runtime. An
   * empty list next to a non-zero `childCount` means "not listed", not "none".
   */
  children: z.array(processSampleSchema),
  unknownReason: resourceUnknownReasonSchema.nullable(),
});

/**
 * One of Armadra's own processes, reported apart from the user's sessions
 * (design §8 "平台组件"). The runtime row is measured on its own — `tree` is
 * false — because its children are the sessions, which have their own rows and
 * would otherwise be counted twice.
 */
export const platformComponentSchema = z.object({
  kind: z.enum(["runtime", "host", "commandWorker"]),
  process: processSampleSchema,
  tree: z.boolean(),
  childCount: z.number().int().nonnegative().nullable(),
  children: z.array(processSampleSchema),
  unknownReason: resourceUnknownReasonSchema.nullable(),
});

/**
 * A persistent session nothing on the canvas points at.
 *
 * `no-node` still has its row, so it can be given a node again (`adoptable`);
 * `no-row` is a backend session with nothing on record and can only be ended.
 */
export const orphanSessionSchema = z.object({
  id: z.string(),
  reason: z.enum(["no-node", "no-row"]),
  sessionId: z.string().nullable(),
  backendRef: z.string().nullable(),
  workspaceId: z.string().nullable(),
  nodeId: z.string().nullable(),
  sessionKey: z.string().nullable(),
  cwd: z.string().nullable(),
  agentId: z.string().nullable(),
  createdAt: z.string().nullable(),
  lastOutputAt: z.string().nullable(),
  adoptable: z.boolean(),
});

/** `POST …/resources/orphans/{sessionId}/adopt`. */
export const adoptedSessionSchema = z.object({
  sessionId: z.string(),
  /** The id the new canvas node must be created with. */
  nodeId: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  shell: z.string(),
  agentId: z.string().nullable(),
  generation: z.number().int(),
});

export const powerPolicySchema = z.enum([
  "never",
  "agentSessions",
  "automation",
  "manual",
]);
export const powerLeaseSourceSchema = z.enum([
  "session",
  "automation",
  "manual",
]);

/**
 * One claim on the machine staying awake. `active` is whether it is holding
 * anything; `blockedBy` says why not — `policy` (the setting forbids this
 * source) or `unavailable` (this platform has no mechanism). A blocked claim
 * is still listed, because "why did my machine sleep during a long run" is
 * what the panel exists to answer.
 */
export const powerLeaseSchema = z.object({
  id: z.string(),
  source: powerLeaseSourceSchema,
  reason: z.string(),
  sessionId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  createdAt: z.string(),
  renewedAt: z.string(),
  expiresAt: z.string(),
  active: z.boolean(),
  blockedBy: z.enum(["policy", "unavailable"]).nullable(),
});

export const powerInhibitorSchema = z.object({
  platform: z.string(),
  kind: z.string().nullable(),
  available: z.boolean(),
  detail: z.string().nullable(),
});

export const powerStateSchema = z.object({
  policy: powerPolicySchema,
  holding: z.boolean(),
  mechanism: z.string().nullable(),
  inhibitor: powerInhibitorSchema,
  leases: z.array(powerLeaseSchema),
});

export const resourceSnapshotSchema = z.object({
  workspaceId: z.string(),
  host: hostResourcesSchema,
  sessions: z.array(sessionResourcesSchema),
  /** Armadra's own processes, never mixed into the session rows. */
  components: z.array(platformComponentSchema),
  orphans: z.array(orphanSessionSchema),
  power: powerStateSchema,
  /** The cadence the runtime is actually sampling at right now. */
  intervalMs: z.number().int().positive(),
  sampledAt: z.string(),
});

/**
 * `POST …/resources/subscription` — sampling only runs while this is live.
 *
 * `intervalMs` is this subscriber's own cadence and is what it should renew
 * at; an offscreen node badge asks for a slow one. `effectiveIntervalMs` is
 * what the runtime is running at given every live subscription, which may be
 * faster because somebody else asked for it.
 */
export const resourceSubscriptionSchema = z.object({
  subscriptionId: z.string(),
  workspaceId: z.string(),
  intervalMs: z.number().int().positive(),
  effectiveIntervalMs: z.number().int().positive(),
  expiresAt: z.string(),
});

export const powerLeaseRequestSchema = z.object({
  source: powerLeaseSourceSchema,
  reason: z.string().min(1),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

/* ------------------------------ workspace WS ----------------------------- */

/** `WS /api/workspaces/{id}/events` — plan §5.4 / §7. */
export const workspaceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.context"),
    nodeId: z.string(),
    sessionId: z.string(),
    generation: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("agent.status"), status: agentStatusSchema }),
  z.object({ type: z.literal("agent.subagent"), event: agentEventSchema }),
  z.object({
    type: z.literal("agent.approval"),
    nodeId: z.string(),
    pendingId: z.string(),
    request: z.unknown(),
  }),
  z.object({
    type: z.literal("agent.delivery"),
    traceId: z.string(),
    sourceNodeId: z.string(),
    targetNodeId: z.string(),
    outcome: z.string(),
  }),
  z.object({
    type: z.literal("terminal.exit"),
    sessionId: z.string(),
    nodeId: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
  }),
  z.object({
    type: z.literal("board.changed"),
    boardId: z.string(),
    updatedAt: z.string(),
  }),
  /**
   * A control verb that must not run without a human (plan §5.8: `close`).
   * The runtime is blocked on `POST /api/control/confirm/{requestId}` while
   * this frame is on the wire, and gives up after 130 seconds.
   */
  z.object({
    type: z.literal("control.confirm"),
    requestId: z.string(),
    verb: z.string(),
    nodeId: z.string(),
    summary: z.string(),
  }),
  /**
   * A file an editor node registered through `POST …/file-watch` changed on
   * disk outside the app. `sha256` / `size` / `mtime` are null for a removal.
   */
  /**
   * A host / session resource sample (T02). Only sent while a client holds a
   * subscription for this workspace, so a closed panel produces no traffic.
   */
  z.object({
    type: z.literal("resource.sample"),
    snapshot: resourceSnapshotSchema,
  }),
  z.object({
    type: z.literal("file.changed"),
    workspaceId: z.string(),
    path: z.string(),
    kind: fileChangeKindSchema,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullish(),
    size: z.number().int().nonnegative().nullish(),
    mtime: z.string().nullish(),
  }),
]);

/* ------------------------------------ 用量 ------------------------------- */

/**
 * 用量胶囊（plan §19）。
 *
 * The runtime reads each provider's own credentials, calls the provider's
 * usage endpoint and maps the answer down to this shape. Tokens, account ids,
 * e-mail addresses and plan names never cross the wire — a window is a
 * percentage and a reset time, nothing else.
 */
// 模型额度有独立 key（例如 seven_day_sonnet、codex_other:primary）。
export const usageWindowKeySchema = z.string().min(1);

export const usageWindowSchema = z.object({
  key: usageWindowKeySchema,
  /** 单位缩写（`5h` / `7d`）；前端过一层 i18n，认不出就原样显示。 */
  label: z.string(),
  group: z.string().optional(),
  usedPercent: z.number().min(0).max(100),
  /**
   * 没有上限的额度桶（Copilot 的 chat / completions）。此时 `usedPercent`
   * 是 0 但不代表「没用」，界面显示「无限制」而不是空进度条。
   */
  unlimited: z.boolean().optional(),
  /** RFC 3339，`null` 表示 provider 没给重置时间。 */
  resetsAt: z.string().nullable(),
});

export const usageProviderIdSchema = z.enum([
  "claude",
  "codex",
  "gemini",
  "copilot",
]);

/**
 * `unavailable` = 本机没有该 provider 的凭据；`error` = 有凭据但取不到
 * （401 / 网络 / 字段不符）。两者在界面上都不弹提示（§19「刷新」）。
 */
export const usageProviderStatusSchema = z.enum(["ok", "unavailable", "error"]);

/**
 * 凭据**放在哪**——不是凭据本身。设置页的「账号与用量」用它显示
 * 钥匙串 / 文件 / 未找到；旧 Runtime 没有这个字段，所以给了默认值。
 */
export const usageCredentialSourceSchema = z
  .enum(["keychain", "file", "none"])
  .optional();

/** 预付余额（Codex credits）。只有数字，没有账户信息。 */
export const usageCreditsSchema = z.object({ balance: z.number() });

export const usageProviderSchema = z.object({
  id: usageProviderIdSchema,
  status: usageProviderStatusSchema,
  credentialSource: usageCredentialSourceSchema,
  windows: z.array(usageWindowSchema),
  credits: usageCreditsSchema.optional(),
  /** 数字来自本地 CLI 回退而不是 provider 自己的 OAuth 接口。 */
  viaCli: z.boolean().optional(),
  fetchedAt: z.string().nullable(),
});

export const usageSchema = z.object({
  providers: z.array(usageProviderSchema),
  refreshAvailableAt: z.string().nullable().optional(),
});

/* ------------------------------ 托盘迷你条 -------------------------------- */

/**
 * `GET /api/usage/mini`（§4.2「托盘迷你条」）。会话（≤ 24h）与周（> 24h）
 * 两条进度，取所有 provider 中占用最高的那条；没有可用窗口时是 `null`，
 * 不是 0。
 */
export const usageMiniBarSchema = z.object({
  provider: z.string(),
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});

export const usageMiniSchema = z.object({
  session: usageMiniBarSchema.nullable().optional(),
  week: usageMiniBarSchema.nullable().optional(),
  fetchedAt: z.string().nullable().optional(),
});

/* -------------------------------- 本地成本 -------------------------------- */

/**
 * 本地成本统计（§4.2）。Runtime 扫描本机 Claude / Codex 的 JSONL 转录，
 * 只汇总 token 计数；转录正文、会话 id、项目路径都不会出现在这里。
 */
export const costTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheCreation: z.number(),
});

export const costModelSchema = z.object({
  model: z.string(),
  tokens: costTokensSchema,
  /** `null` = 价格表里没有这个模型，只显示 token，不显示估算费用。 */
  costUsd: z.number().nullable(),
});

export const costWindowSchema = z.object({
  tokens: costTokensSchema,
  costUsd: z.number(),
  /** false = 窗口里至少有一个模型没有价格，总额偏低。 */
  complete: z.boolean(),
  models: z.array(costModelSchema),
});

export const costDaySchema = costWindowSchema.extend({
  /** 本地日期 `YYYY-MM-DD`。 */
  date: z.string(),
});

export const costSessionSchema = z.object({
  provider: z.string(),
  models: z.array(z.string()),
  tokens: costTokensSchema,
  costUsd: z.number(),
  complete: z.boolean(),
  updatedAt: z.string(),
});

/** `disabled` = 设置里关掉了扫描；`unavailable` = 本机没有可读的转录。 */
export const costStatusSchema = z.enum(["ok", "disabled", "unavailable"]);

export const costSummarySchema = z.object({
  status: costStatusSchema,
  today: costWindowSchema,
  last30Days: costWindowSchema,
  currentSession: costSessionSchema.optional(),
  /** 由旧到新，含当天，固定 30 项；没有活动的那天也在，值为 0。 */
  daily: z.array(costDaySchema),
  unpricedModels: z.array(z.string()),
  files: z.record(z.string(), z.number()),
  truncated: z.boolean(),
  scannedAt: z.string().nullable().optional(),
  refreshAvailableAt: z.string().nullable().optional(),
});

/* ------------------------------ Copilot 登录 ------------------------------ */

/**
 * GitHub device flow（§4.2）。`deviceCode` 不在这里——它等价于凭据，
 * 只留在 Runtime 内存里。
 */
export const copilotLoginPromptSchema = z.object({
  userCode: z.string(),
  verificationUri: z.string(),
  intervalSeconds: z.number(),
  expiresAt: z.string(),
});

/** token 存在哪：`keychain` 是 OS 钥匙串，`file` 是带 0600 的降级方案。 */
export const copilotBackendSchema = z.enum(["keychain", "file"]);

export const copilotAuthSchema = z.object({
  signedIn: z.boolean(),
  backend: copilotBackendSchema,
  pending: copilotLoginPromptSchema.optional(),
});

/** `pending` 之外都是终态，前端停止轮询。 */
export const copilotLoginProgressSchema = z.enum([
  "pending",
  "authorized",
  "expired",
  "denied",
  "error",
]);

export const copilotPollSchema = copilotAuthSchema.extend({
  progress: copilotLoginProgressSchema,
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
export type WriteFileRequest = z.infer<typeof writeFileRequestSchema>;
export type WriteFileResponse = z.infer<typeof writeFileResponseSchema>;
export type FileVersion = z.infer<typeof fileVersionSchema>;
export type WatchFileRequest = z.infer<typeof watchFileRequestSchema>;
export type WatchStatus = z.infer<typeof watchStatusSchema>;
export type WatchRegistration = z.infer<typeof watchRegistrationSchema>;
export type FileChangeKind = z.infer<typeof fileChangeKindSchema>;
export type FileEol = z.infer<typeof fileEolSchema>;
export type FileEncoding = z.infer<typeof fileEncodingSchema>;
export type FileIndexEntry = z.infer<typeof fileIndexEntrySchema>;
export type FileIndex = z.infer<typeof fileIndexSchema>;
export type FileSearchRequest = z.infer<typeof fileSearchRequestSchema>;
export type FileSearchMatch = z.infer<typeof fileSearchMatchSchema>;
export type FileSearchFile = z.infer<typeof fileSearchFileSchema>;
export type FileSearchResult = z.infer<typeof fileSearchResultSchema>;
export type FileEntryKind = z.infer<typeof fileEntryKindSchema>;
export type FileEntryResult = z.infer<typeof fileEntryResultSchema>;
export type TrashEntry = z.infer<typeof trashEntrySchema>;
export type LanguageServiceStatus = z.infer<typeof languageServiceStatusSchema>;
export type FileChangedEvent = Extract<
  WorkspaceEvent,
  { type: "file.changed" }
>;
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>;
export type CreateTerminalAgent = z.infer<typeof createTerminalAgentSchema>;
export type SshHost = z.infer<typeof sshHostSchema>;
export type SshTestResult = z.infer<typeof sshTestResultSchema>;
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type ConversationProvider = z.infer<typeof conversationProviderSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationRefreshResponse = z.infer<
  typeof conversationRefreshResponseSchema
>;
export type SuggestTitleResponse = z.infer<typeof suggestTitleResponseSchema>;
export type AgentInfo = z.infer<typeof agentInfoSchema>;
export type HookInstallReport = z.infer<typeof hookInstallReportSchema>;
export type AnswerApprovalRequest = z.infer<typeof answerApprovalRequestSchema>;
export type ContextLink = z.infer<typeof contextLinkSchema>;
export type ContextLinkContent = z.infer<typeof contextLinkContentSchema>;
export type AgentDelivery = z.infer<typeof agentDeliverySchema>;
export type ControlConfirmRequest = z.infer<typeof controlConfirmRequestSchema>;
export type ControlConfirmResponse = z.infer<
  typeof controlConfirmResponseSchema
>;
export type ContextLinksRequest = z.infer<typeof contextLinksRequestSchema>;
export type ExportPngRequest = z.infer<typeof exportPngRequestSchema>;
export type ExportPngResponse = z.infer<typeof exportPngResponseSchema>;
export type ExportNodePngRequest = ExportPngRequest;
export type ExportNodePngResponse = ExportPngResponse;
export type UploadAssetRequest = z.infer<typeof uploadAssetRequestSchema>;
export type ImportAssetRequest = z.infer<typeof importAssetRequestSchema>;
export type UploadAssetResponse = z.infer<typeof uploadAssetResponseSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;
export type GitDiff = z.infer<typeof gitDiffSchema>;
export type GitDiffRequest = z.infer<typeof gitDiffRequestSchema>;
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>;
export type GitUnstageResponse = z.infer<typeof gitUnstageResponseSchema>;
export type GitInitResponse = z.infer<typeof gitInitResponseSchema>;
export type GitHeadCommit = z.infer<typeof gitHeadCommitSchema>;
export type GitRestoreSource = z.infer<typeof gitRestoreSourceSchema>;
export type GitResolveResponse = z.infer<typeof gitResolveResponseSchema>;
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;
export type GitCommitResponse = z.infer<typeof gitCommitResponseSchema>;
export type GitCloneRequest = z.infer<typeof gitCloneRequestSchema>;
export type GitCloneStarted = z.infer<typeof gitCloneStartedSchema>;
export type GitCloneState = z.infer<typeof gitCloneStateSchema>;
export type GitCloneStatus = z.infer<typeof gitCloneStatusSchema>;
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalBackendKind = z.infer<typeof terminalBackendKindSchema>;
export type TerminalBackendInfo = z.infer<typeof terminalBackendInfoSchema>;
export type TerminalCaptureResponse = z.infer<
  typeof terminalCaptureResponseSchema
>;
export type TerminalPasteRequest = z.infer<typeof terminalPasteRequestSchema>;
export type TerminateMode = z.infer<typeof terminateModeSchema>;
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
export type ResourceLocation = z.infer<typeof resourceLocationSchema>;
export type HostResources = z.infer<typeof hostResourcesSchema>;
export type SessionResources = z.infer<typeof sessionResourcesSchema>;
export type ProcessSample = z.infer<typeof processSampleSchema>;
export type PlatformComponent = z.infer<typeof platformComponentSchema>;
export type PlatformComponentKind = PlatformComponent["kind"];
export type ResourceUnknownReason = z.infer<typeof resourceUnknownReasonSchema>;
export type OrphanSession = z.infer<typeof orphanSessionSchema>;
export type AdoptedSession = z.infer<typeof adoptedSessionSchema>;
export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>;
export type ResourceSubscription = z.infer<typeof resourceSubscriptionSchema>;
export type ResourceSampleEvent = Extract<
  WorkspaceEvent,
  { type: "resource.sample" }
>;
export type PowerPolicy = z.infer<typeof powerPolicySchema>;
export type PowerLease = z.infer<typeof powerLeaseSchema>;
export type PowerLeaseSource = z.infer<typeof powerLeaseSourceSchema>;
export type PowerLeaseRequest = z.infer<typeof powerLeaseRequestSchema>;
export type PowerState = z.infer<typeof powerStateSchema>;
export type PowerInhibitor = z.infer<typeof powerInhibitorSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type UsageProvider = z.infer<typeof usageProviderSchema>;
export type UsageProviderId = z.infer<typeof usageProviderIdSchema>;
export type UsageProviderStatus = z.infer<typeof usageProviderStatusSchema>;
export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type UsageWindowKey = z.infer<typeof usageWindowKeySchema>;
export type UsageCredentialSource = z.infer<typeof usageCredentialSourceSchema>;
export type UsageCredits = z.infer<typeof usageCreditsSchema>;
export type UsageMini = z.infer<typeof usageMiniSchema>;
export type UsageMiniBar = z.infer<typeof usageMiniBarSchema>;
export type CostTokens = z.infer<typeof costTokensSchema>;
export type CostModel = z.infer<typeof costModelSchema>;
export type CostWindow = z.infer<typeof costWindowSchema>;
export type CostDay = z.infer<typeof costDaySchema>;
export type CostSession = z.infer<typeof costSessionSchema>;
export type CostStatus = z.infer<typeof costStatusSchema>;
export type CostSummary = z.infer<typeof costSummarySchema>;
export type CopilotAuth = z.infer<typeof copilotAuthSchema>;
export type CopilotBackend = z.infer<typeof copilotBackendSchema>;
export type CopilotLoginPrompt = z.infer<typeof copilotLoginPromptSchema>;
export type CopilotLoginProgress = z.infer<typeof copilotLoginProgressSchema>;
export type CopilotPoll = z.infer<typeof copilotPollSchema>;
