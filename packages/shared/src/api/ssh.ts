import { z } from "zod";

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

/**
 * A path on the far end of an `ssh` command line. The remote login shell word
 * splits what `ssh` sends it, so anything with whitespace or a shell
 * metacharacter would arrive as several arguments, not one path.
 */
export const sshRemotePathSchema = z
  .string()
  .max(4_096)
  .refine((value) => value.startsWith("/"), { message: "Must be absolute" })
  .refine((value) => !SSH_UNSAFE_PATTERN.test(value), {
    message: "Unsafe character",
  });

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
  /**
   * Where the Armadra Worker lives on this host (H02). Absent means the host
   * runs terminals only: a workspace cannot execute on it, and the runtime
   * says so rather than reading local files instead.
   *
   * `ssh` joins the remote command with spaces and the login shell splits it
   * again, so these paths are held to the same rule as `identityFile`:
   * absolute, no whitespace, no shell metacharacter.
   */
  worker: z
    .object({
      path: sshRemotePathSchema,
      stateDir: sshRemotePathSchema.optional(),
    })
    .optional(),
});

/** `POST /api/ssh/hosts/{id}/test` — one `ssh … true` probe. */
export const sshTestResultSchema = z.object({
  ok: z.boolean(),
  /** Tail of ssh's diagnostics, redacted by the runtime. May be empty. */
  output: z.string(),
});

/**
 * `POST /api/ssh/hosts/{id}/worker/test` — the Worker's own handshake.
 *
 * A separate question from reachability: `ssh` can work perfectly while the
 * Worker binary is missing or is a different Armadra build.
 */
export const remoteWorkerProbeSchema = z.object({
  platform: z.string(),
  architecture: z.string(),
  runtimeVersion: z.string(),
  capabilities: z.array(z.string()).default([]),
});

/** `POST /api/workspaces/remote` — open a project on an execution host. */
export const openRemoteWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  executionHostId: z.string().min(1).max(64),
  /** Absolute path **on that host**; nothing about it is resolved locally. */
  rootPath: sshRemotePathSchema,
});

/* ------------------------------- host keys -------------------------------- */

/**
 * One key `ssh-keyscan` offered for a host (remote completion design §3.6).
 *
 * `line` travels back to the runtime verbatim on a trust, so what is written
 * to `known_hosts` is the same bytes whose fingerprint the person compared.
 */
export const sshHostKeySchema = z.object({
  keyType: z.string().min(1).max(64),
  /** `SHA256:…`, exactly as OpenSSH prints it. */
  fingerprint: z.string().min(1).max(128),
  line: z.string().min(1).max(8_192),
  trusted: z.boolean(),
});

/**
 * `POST /api/ssh/hosts/{id}/host-keys/scan`, and the answer to a trust.
 *
 * `changed` means a key is already on record and none of the scanned keys
 * match it: either the host was reinstalled or somebody is in the middle. The
 * client shows `known` beside the new fingerprints so a person decides.
 */
export const sshHostKeyScanSchema = z.object({
  keys: z.array(sshHostKeySchema),
  changed: z.boolean(),
  known: z.array(z.string()).default([]),
});

/** `POST /api/ssh/hosts/{id}/host-keys` — record one scanned key as trusted. */
export const trustSshHostKeyRequestSchema = z.object({
  line: z.string().min(1).max(8_192),
  /**
   * Overwrite the entry already on record. A first trust must never set this:
   * replacing a known key is a decision only the person can make.
   */
  replace: z.boolean().optional(),
});

/* -------------------------------- prompts --------------------------------- */

/** `ssh` phrases the two differently, and the dialog must not have to guess. */
export const sshPromptKindSchema = z.enum(["password", "passphrase"]);

/**
 * One authentication prompt waiting for a person. There is no answer field:
 * this shape only ever travels outward.
 */
export const sshPromptSchema = z.object({
  promptId: z.string().min(1).max(64),
  hostId: z.string().min(1).max(64),
  kind: sshPromptKindSchema,
  /** The server's own text, redacted by the runtime before it is sent. */
  prompt: z.string().max(1_024),
});

/** `GET /api/ssh/prompts` — what is waiting right now, for a fresh client. */
export const sshPromptListSchema = z.array(sshPromptSchema);

/** `POST /api/ssh/hosts/{hostId}/prompts/{promptId}` — a person answers. */
export const answerSshPromptRequestSchema = z.object({ answer: z.string() });

/* --------------------------- execution host switch ------------------------ */

/**
 * A root path on whichever machine will execute. Deliberately not
 * `sshRemotePathSchema`: an empty `executionHostId` means this machine, whose
 * paths may legitimately contain spaces — the runtime only requires absolute
 * and under 4 KiB.
 */
const executionRootPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/"), { message: "Must be absolute" });

/** `PATCH /api/workspaces/{id}/execution-host` — rebind, never a file move. */
export const switchExecutionHostRequestSchema = z.object({
  /** A `settings.ssh.hosts[].id`, or empty for this machine. */
  executionHostId: z.string().max(64),
  rootPath: executionRootPathSchema,
  /** Rebind even when the two roots do not look like the same project. */
  force: z.boolean().optional(),
  /**
   * Always refused by the runtime. Modelled so the refusal can name what was
   * asked instead of the request being silently reinterpreted.
   */
  migrateFiles: z.boolean().optional(),
});

/** What a root looks like, cheaply enough to compare across machines. */
export const rootFingerprintSchema = z.object({
  head: z.string(),
  entries: z.string(),
  entryCount: z.number().int().nonnegative(),
});

/** One thing still bound to the old host. `kind` is a key the UI translates. */
export const executionHostBlockerSchema = z.object({
  kind: z.string(),
  detail: z.string(),
});

/**
 * The 409 body of a refused switch. Structured rather than a sentence: a
 * person can only act on *which* directories differ, or on *what* is still
 * open.
 */
export const executionHostRefusalSchema = z.object({
  code: z.enum(["root_mismatch", "switch_blocked"]),
  message: z.string(),
  from: rootFingerprintSchema.optional(),
  to: rootFingerprintSchema.optional(),
  blockers: z.array(executionHostBlockerSchema).default([]),
});

export type SshHost = z.infer<typeof sshHostSchema>;
export type RemoteWorkerProbe = z.infer<typeof remoteWorkerProbeSchema>;
export type OpenRemoteWorkspaceRequest = z.infer<
  typeof openRemoteWorkspaceRequestSchema
>;
export type SshTestResult = z.infer<typeof sshTestResultSchema>;
export type SshHostKey = z.infer<typeof sshHostKeySchema>;
export type SshHostKeyScan = z.infer<typeof sshHostKeyScanSchema>;
export type TrustSshHostKeyRequest = z.infer<
  typeof trustSshHostKeyRequestSchema
>;
export type SshPromptKind = z.infer<typeof sshPromptKindSchema>;
export type SshPrompt = z.infer<typeof sshPromptSchema>;
export type SwitchExecutionHostRequest = z.infer<
  typeof switchExecutionHostRequestSchema
>;
export type RootFingerprint = z.infer<typeof rootFingerprintSchema>;
export type ExecutionHostBlocker = z.infer<typeof executionHostBlockerSchema>;
export type ExecutionHostRefusal = z.infer<typeof executionHostRefusalSchema>;
