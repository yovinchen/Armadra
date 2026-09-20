import { z } from "zod";

import { permissionModeSchema } from "./primitives.js";

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
      ["claude", "codex", "opencode", "pi", "omp", "copilot"].includes(value) ||
      /^custom:[A-Za-z0-9._:-]{1,64}$/.test(value),
    { message: "Unknown agent id" },
  );

/** The longest a handle may be — mirrors `MAX_HANDLE_CHARS` in the runtime. */
export const MAX_HANDLE_CHARS = 24;

/**
 * A short alias an agent can address a node by, instead of quoting its title.
 *
 * 1–{@link MAX_HANDLE_CHARS} characters: a leading ASCII letter or digit, then
 * letters, digits, `-` or `_`, all lowercase. The narrow charset is what keeps
 * a handle unambiguous on a command line — nothing to quote and nothing that
 * looks like an id.
 *
 * This is a mirror of `normalize_handle` in
 * the pre-merge implementation, which stays the authority: the
 * runtime re-validates every handle it reads, so a board written by hand can
 * never register one this schema would reject.
 */
export const handleSchema = z
  .string()
  .min(1)
  .max(MAX_HANDLE_CHARS)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "A handle is lowercase letters, digits, - or _, starting with a letter or digit",
  );

/**
 * Spread into every node data variant. Addressing is a property of the node,
 * not of what it runs: a sticky can be handed a handle for the same reason a
 * terminal can, and a variant that dropped the key would have the canvas strip
 * a handle the runtime had just written.
 */
const addressable = { handle: handleSchema.optional() };

/** A launch armed by `open-agent --after A,B`; the PTY stays a plain shell until every dependency is done. */
export const pendingLaunchSchema = z.object({
  command: z.string().max(4_000),
  after: z.array(z.string().uuid()).max(32).default([]),
});

/**
 * Which account a node runs as — the domain mirror of `AccountRef` and
 * `CredentialBinding` in `proto/armadra/v1/account.proto` (S02).
 *
 * Reserved: absent on every node today, and the runtime still refuses any
 * `accountId` other than `default`. `credentialRef` is a **name** in the
 * execution host's credential store — never a token, key or password. Nothing
 * in this object may be treated as authorization: the Host re-checks the
 * binding against the authenticated principal when it is eventually honoured.
 */
export const accountRefSchema = z.object({
  accountId: z.string().min(1).max(120),
  /** CLI/vendor namespace the account belongs to (`claude`, `codex`, …). */
  providerId: z.string().max(120).optional(),
  /** Display text only; a label never decides what a session may do. */
  label: z.string().max(200).optional(),
  credentialRef: z.string().max(200).optional(),
});

export type AccountRef = z.infer<typeof accountRefSchema>;

/** The three settings of the inbox wake (docs/design/agent-delivery.md §5). */
export const INBOX_WAKE_MODES = ["off", "notify", "deliver"] as const;

export type InboxWake = (typeof INBOX_WAKE_MODES)[number];

export const terminalAgentSchema = z.object({
  id: agentIdSchema,
  accountId: z.string().max(120).optional(),
  /** Reserved account binding (S02); absent until multi-account ships. */
  account: accountRefSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  model: z.string().max(120).optional(),
  /** Session id reported by the CLI (via hooks) or pre-minted by us. */
  sessionId: z.string().max(200).optional(),
  /** Launch line written into the shell once it is ready. */
  initialCommand: z.string().max(4_000).optional(),
  pendingLaunch: pendingLaunchSchema.optional(),
  /**
   * What happens when this node goes idle with unread canvas mail
   * (docs/design/agent-delivery.md §5): nothing, a one-line notice, or the
   * earliest unread message itself. Absent means the core's default.
   */
  inboxWake: z.enum(INBOX_WAKE_MODES).optional(),
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
  ...addressable,
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
  ...addressable,
  content: z.string().max(MAX_STICKY_CONTENT).default(""),
});

/**
 * A Frame bound to a worktree (G03). The binding is a *record of* a checkout
 * that already exists, never the checkout itself: unbinding clears these fields
 * and leaves the directory on disk untouched, and removing the checkout goes
 * through the repository service's safe removal.
 *
 * `worktreePath` is workspace-relative — the same value every repository
 * request takes as its `path` — so a bound Frame and the repository switcher
 * name the same checkout. `repositoryId` is the discovery record's id.
 */
export const frameBindingSchema = z.object({
  worktreePath: z.string().min(1).max(4096),
  branch: z.string().min(1).max(1024),
  repositoryId: z.string().min(1),
  /**
   * A one-shot setup command run inside the checkout when the binding is
   * created. It is never re-run on its own: `pending` and `running` are states
   * a user action moved through, and a `failed` script leaves the binding in
   * place so the output stays readable.
   */
  initScript: z.string().max(4096).nullable().default(null),
  initScriptState: z
    .enum(["none", "pending", "running", "succeeded", "failed"])
    .default("none"),
  /** The terminal node the init script's output went to, when there is one. */
  initScriptNodeId: z.string().nullable().default(null),
});

/** The group label is `node.title` and its tint is `node.color`. */
export const groupNodeDataSchema = z.object({
  kind: z.literal("group"),
  ...addressable,
  /** Absent for an ordinary Frame; present once one is bound to a checkout. */
  binding: frameBindingSchema.nullish(),
});

/**
 * The editor's language tooling as the node last saw it (language service
 * design §2.9).
 *
 * Only the status summary is stored. Diagnostics, shadow documents and server
 * capabilities are process state on the execution host: persisting them would
 * let a reopened board show findings for a file that has since changed.
 */
export const languageServiceSchema = z.object({
  status: z
    .enum([
      "available",
      "unavailable",
      "starting",
      "running",
      "idleStopped",
      "crashed",
      "stopped",
      "disconnected",
    ])
    .default("unavailable"),
  /** Stable reason key for the status line; never shown as a capability. */
  reason: z.string().max(200).optional(),
});

export const editorNodeDataSchema = z.object({
  kind: z.literal("editor"),
  ...addressable,
  path: z.string().min(1).max(4_000),
  language: z.string().max(40).optional(),
  readonly: z.boolean().optional(),
  /** Absent until a session has been opened for this node. */
  languageService: languageServiceSchema.optional(),
});

export const DIFF_SCOPES = ["worktree", "staged"] as const;
export const diffScopeSchema = z.enum(DIFF_SCOPES);

export const diffNodeDataSchema = z.object({
  kind: z.literal("diff"),
  ...addressable,
  repoPath: z.string().min(1).max(4_000),
  scope: diffScopeSchema.default("worktree"),
  paths: z.array(z.string().max(4_000)).max(1_000).optional(),
});

export const filesNodeDataSchema = z.object({
  kind: z.literal("files"),
  ...addressable,
  path: z.string().min(1).max(4_000),
});

export const browserNodeDataSchema = z.object({
  kind: z.literal("browser"),
  ...addressable,
  url: z.string().max(4_000).default(""),
});

/**
 * Platform automation (design §3 / §4). The Host owns the plan; the node only
 * references it, so closing a board never cancels a schedule and a plan with no
 * node is still reachable from the automation panel.
 */
export const AUTOMATION_SCHEDULE_KINDS = [
  "once",
  "interval",
  "cron",
  "loop",
] as const;
export const automationScheduleKindSchema = z.enum(AUTOMATION_SCHEDULE_KINDS);

export const automationNodeDataSchema = z.object({
  kind: z.literal("automation"),
  ...addressable,
  /** `AutomationPlan.id` on the execution Host — the only durable binding. */
  planId: z.string().min(1).max(200),
  /** The Host workspace scope the plan lives in, not the local board id. */
  planWorkspaceId: z.string().min(1).max(200),
  executionHostId: z.string().min(1).max(200),
  /**
   * Cached for display only, so a card still reads as itself while the Host is
   * unreachable. State, next run and results always come from the Host.
   */
  scheduleKind: automationScheduleKindSchema.optional(),
  timezone: z.string().max(64).optional(),
});

/**
 * A read-only observation of a CLI's own loop/subagent activity (design §3).
 * A separate entity from `automation` on purpose: hiding this card never
 * cancels the native job, and neither type converts into the other.
 */
export const AGENT_ACTIVITY_SOURCES = ["loop", "subagent"] as const;
export const agentActivitySourceSchema = z.enum(AGENT_ACTIVITY_SOURCES);

/**
 * Which scheduler wrote the repeat rule a card observed. `cron` is a crontab
 * line, `launchd` a job's `StartCalendarInterval` / `StartInterval`.
 */
export const NATIVE_RECURRENCE_DIALECTS = ["cron", "launchd"] as const;
export const nativeRecurrenceDialectSchema = z.enum(NATIVE_RECURRENCE_DIALECTS);

/**
 * The repeat rule a native activity card observed, kept verbatim.
 *
 * `rule` is the scheduler's own text — a crontab expression, or the JSON of a
 * launchd `StartCalendarInterval` / `StartInterval`. It is stored unparsed
 * because it is *evidence*: the panel translates it into a platform schedule
 * where it can (`panels/automation/native-recurrence.ts`) and shows the
 * original where it cannot, and a normalized copy would quietly lose the parts
 * that made it untranslatable.
 *
 * A timezone belongs with it: a crontab line means nothing without one, and
 * guessing the reader's device zone is how a plan ends up running at the wrong
 * hour. Empty means the source did not say.
 */
export const nativeRecurrenceSchema = z.object({
  dialect: nativeRecurrenceDialectSchema,
  rule: z.string().min(1).max(2_000),
  timezone: z.string().max(64).default(""),
});

export const agentActivityNodeDataSchema = z.object({
  kind: z.literal("agentActivity"),
  ...addressable,
  /** The observed terminal node on this board. */
  sourceNodeId: z.string().uuid(),
  source: agentActivitySourceSchema.default("loop"),
  /**
   * Identity of the observed job is executionHost/session/generation/nativeJobId
   * — never its title. Unknown parts stay empty rather than being guessed.
   */
  sessionId: z.string().max(200).default(""),
  executionHostId: z.string().max(200).default(""),
  generation: z
    .number()
    .int()
    .nonnegative()
    .max(2 ** 53 - 1)
    .default(0),
  nativeJobId: z.string().max(200).default(""),
  /**
   * The repeat rule the discovery read, when it read one. Absent for a card
   * built from Hook events, which report iterations rather than a schedule —
   * an activity without a readable rule must not be given an invented one.
   */
  nativeRecurrence: nativeRecurrenceSchema.optional(),
});

export const canvasNodeDataSchema = z.discriminatedUnion("kind", [
  terminalNodeDataSchema,
  stickyNodeDataSchema,
  groupNodeDataSchema,
  editorNodeDataSchema,
  diffNodeDataSchema,
  filesNodeDataSchema,
  browserNodeDataSchema,
  automationNodeDataSchema,
  agentActivityNodeDataSchema,
]);

export type DiffScope = (typeof DIFF_SCOPES)[number];
export type TerminalAgent = z.infer<typeof terminalAgentSchema>;
export type SshTarget = z.infer<typeof sshTargetSchema>;
export type PendingLaunch = z.infer<typeof pendingLaunchSchema>;
export type CanvasNodeData = z.infer<typeof canvasNodeDataSchema>;
export type TerminalNodeData = z.infer<typeof terminalNodeDataSchema>;
export type StickyNodeData = z.infer<typeof stickyNodeDataSchema>;
export type GroupNodeData = z.infer<typeof groupNodeDataSchema>;
export type FrameBinding = z.infer<typeof frameBindingSchema>;
export type EditorNodeData = z.infer<typeof editorNodeDataSchema>;
export type LanguageService = z.infer<typeof languageServiceSchema>;
export type DiffNodeData = z.infer<typeof diffNodeDataSchema>;
export type FilesNodeData = z.infer<typeof filesNodeDataSchema>;
export type BrowserNodeData = z.infer<typeof browserNodeDataSchema>;
export type AutomationNodeData = z.infer<typeof automationNodeDataSchema>;
export type AgentActivityNodeData = z.infer<typeof agentActivityNodeDataSchema>;
export type AutomationScheduleKind = (typeof AUTOMATION_SCHEDULE_KINDS)[number];
export type AgentActivitySource = (typeof AGENT_ACTIVITY_SOURCES)[number];
export type NativeRecurrence = z.infer<typeof nativeRecurrenceSchema>;
export type NativeRecurrenceDialect =
  (typeof NATIVE_RECURRENCE_DIALECTS)[number];
