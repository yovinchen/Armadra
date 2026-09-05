import { z } from "zod";

import {
  agentIdSchema,
  agentStateSchema,
  permissionModeSchema,
  sshTargetSchema,
} from "../domain/index.js";

/** Agent block on `POST /api/terminals`; drives the injected `ARMADRA_*` env. */
export const createTerminalAgentSchema = z.object({
  id: agentIdSchema,
  accountId: z.string().max(120).optional(),
  permissionMode: permissionModeSchema.optional(),
  model: z.string().max(120).optional(),
  sessionId: z.string().max(200).optional(),
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
/**
 * `sessionHost` is the Windows backend of T01: the sessions belong to
 * `armadra-session-host`, which outlives the Worker the way a tmux server
 * does. It is a third value rather than a flavour of `direct`, because the
 * two differ in the one way that matters — whether a terminal survives a
 * restart — and the UI must not imply the wrong answer.
 */
export const TERMINAL_BACKENDS = ["direct", "tmux", "sessionHost"] as const;
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
export const TERMINAL_BACKEND_CHOICES = [
  "auto",
  "tmux",
  "direct",
  "sessionHost",
] as const;

export const terminalBackendInfoSchema = z.object({
  effective: terminalBackendKindSchema,
  configured: z.enum(TERMINAL_BACKEND_CHOICES),
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

/** Client → runtime on `WS /api/terminals/{id}/ws` (mirrors pty.rs ClientMessage). */
export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string(),
    /**
     * Monotonic per writer. The runtime answers each applied input with an
     * `ack`, and reports the highest it already applied in `hello`, so a
     * reconnecting client resends only what never landed instead of replaying
     * keystrokes into a live shell (client platforms, mobile reconnect).
     */
    inputId: z.number().int().positive().optional(),
  }),
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
    /**
     * The highest `inputId` this session already applied for the writer named
     * in the socket's `writer` query. Absent when the client did not name one,
     * and `0` when this session has never seen that writer.
     */
    acknowledgedInput: z.number().int().nonnegative().optional(),
  }),
  /** One applied input. Never sent for an input the session refused. */
  z.object({
    type: z.literal("ack"),
    inputId: z.number().int().positive(),
  }),
  /** Replay/screen snapshot; direct backend only (a tmux client redraws the
   * pane itself, and the session host sends its replay inside the attach). */
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

export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>;
export type CreateTerminalAgent = z.infer<typeof createTerminalAgentSchema>;
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalBackendKind = z.infer<typeof terminalBackendKindSchema>;
export type TerminalBackendInfo = z.infer<typeof terminalBackendInfoSchema>;
export type TerminalCaptureResponse = z.infer<
  typeof terminalCaptureResponseSchema
>;
export type TerminalPasteRequest = z.infer<typeof terminalPasteRequestSchema>;
export type TerminateMode = z.infer<typeof terminateModeSchema>;
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
