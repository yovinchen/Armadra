import { z } from "zod";

/**
 * Editor language services — the Runtime ↔ Web half of
 * `docs/design/language-service.md` §2.9.
 *
 * The shapes mirror `proto/armadra/v1/language.proto` field for field, because
 * a remote workspace answers the same questions over the Worker protocol and
 * the browser must not be able to tell which machine replied.
 *
 * Two rules the schemas encode rather than document:
 *
 *  * **`unsupported` is an answer, not an absence.** Every descriptor that is
 *    not `available` carries a stable `reason` key, so the settings page can
 *    say *what* is missing instead of showing an empty row.
 *  * **The browser never sees an absolute path.** Every uri inside
 *    `serverCapabilities` and inside a `WorkspaceEdit` is `armadra:///<rel>`;
 *    `executable` is the one absolute path here, and it names a program on the
 *    execution host, not a file in the project.
 */

/** Where one server is in its life (design §1.3). */
export const languageServerStateSchema = z.enum([
  "available",
  "unsupported",
  "starting",
  "running",
  "idleStopped",
  "crashed",
  "stopped",
  "disconnected",
]);

/**
 * Why a server is not usable. Stable keys the interface localises; a runtime
 * that grows a new one is rendered as generic text rather than crashing the
 * settings page, which is why this is a string and not an enum.
 */
export const LANGUAGE_UNSUPPORTED_REASONS = [
  "server_not_found",
  "server_probe_failed",
  "execution_not_granted",
  "disabled",
  "language_unknown",
  "too_many_servers",
  "containment_unavailable",
  "resource_exhausted",
  "unsupported_remote",
] as const;

/** What a running server actually answers, from its own capabilities. */
export const languageFeatureSchema = z.enum([
  "completion",
  "diagnostics",
  "hover",
  "definition",
  "references",
  "rename",
  "formatting",
  "documentSymbol",
  "workspaceSymbol",
  "codeAction",
  "signatureHelp",
]);

export const languageServerDescriptorSchema = z.object({
  serverId: z.string(),
  languageId: z.string(),
  fileExtensions: z.array(z.string()),
  /** Absolute path on the execution host; empty when nothing was found. */
  executable: z.string(),
  version: z.string(),
  state: languageServerStateSchema,
  reason: z.string().optional(),
  features: z.array(languageFeatureSchema),
  restartCount: z.number().int().nonnegative(),
  /** Only while the process is running: pid + start time is the identity. */
  pid: z.number().int().nullish(),
  startTimeUnixMs: z.number().int().nullish(),
  openDocuments: z.number().int().nonnegative(),
  probedAtUnixMs: z.number().int().nonnegative(),
});

/**
 * `GET /api/workspaces/{id}/language-service` (`?refresh=1` re-probes).
 *
 * `unavailable` no longer means "Armadra has no LSP": it means this workspace
 * cannot run one right now, and `reason` says why. The per-language rows are
 * listed either way, so the settings page can show what is missing rather than
 * an empty panel.
 */
export const languageServiceStatusSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  reason: z.string().optional(),
  executionHostId: z.string().default("local"),
  servers: z.array(languageServerDescriptorSchema).default([]),
});

export const openLanguageSessionRequestSchema = z.object({
  languageId: z.string().min(1).max(60),
  clientId: z.string().min(1).max(120),
  /** The client's LSP `ClientCapabilities`, intersected on the host. */
  clientCapabilities: z.unknown().optional(),
});

export const openLanguageSessionResponseSchema = z.object({
  sessionId: z.string(),
  generation: z.number().int().nonnegative(),
  serverId: z.string(),
  state: languageServerStateSchema,
  reason: z.string().optional(),
  /** The server's own `InitializeResult.capabilities`, replayed verbatim. */
  serverCapabilities: z.unknown().optional(),
});

/**
 * `POST …/language/sessions/{sessionId}/edits`.
 *
 * A path that is absent from `expectedSha256` must not already exist. An empty
 * string would be a version, and versions are checked; absence is the way to
 * say "create only".
 */
export const applyLanguageEditRequestSchema = z.object({
  edit: z.unknown(),
  expectedSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});

export const languageAppliedFileSchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});

export const languageFailedFileSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

/**
 * Writing stops at the first failure, so a partial application is a real
 * outcome and both lists come back: the dialog says which files changed.
 */
export const applyLanguageEditResultSchema = z.object({
  applied: z.array(languageAppliedFileSchema),
  failed: z.array(languageFailedFileSchema),
});

/** `$/progress` reduced to what a status line can show. */
export const languageProgressSchema = z.object({
  percent: z.number().int().min(0).max(100).nullish(),
  title: z.string(),
});

/** Event `language.session` — the status line and the settings page. */
export const languageSessionEventSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  serverId: z.string(),
  generation: z.number().int().nonnegative(),
  state: languageServerStateSchema,
  reason: z.string().optional(),
  restartCount: z.number().int().nonnegative(),
  progress: languageProgressSchema.nullish(),
});

/** Event `language.server` — pushed on probe and on every state change. */
export const languageServerEventSchema = z.object({
  workspaceId: z.string(),
  executionHostId: z.string(),
  server: languageServerDescriptorSchema,
  /**
   * The tail of the server's stderr, redacted, for a crash the settings page
   * has to explain. Never persisted and never logged.
   */
  stderrTail: z.string().optional(),
});

export type LanguageServerState = z.infer<typeof languageServerStateSchema>;
export type LanguageFeature = z.infer<typeof languageFeatureSchema>;
export type LanguageServerDescriptor = z.infer<
  typeof languageServerDescriptorSchema
>;
export type LanguageServiceStatus = z.infer<typeof languageServiceStatusSchema>;
export type OpenLanguageSessionRequest = z.infer<
  typeof openLanguageSessionRequestSchema
>;
export type OpenLanguageSessionResponse = z.infer<
  typeof openLanguageSessionResponseSchema
>;
export type ApplyLanguageEditRequest = z.infer<
  typeof applyLanguageEditRequestSchema
>;
export type ApplyLanguageEditResult = z.infer<
  typeof applyLanguageEditResultSchema
>;
export type LanguageSessionEvent = z.infer<typeof languageSessionEventSchema>;
export type LanguageServerEvent = z.infer<typeof languageServerEventSchema>;
