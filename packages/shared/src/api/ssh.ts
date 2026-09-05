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

export type SshHost = z.infer<typeof sshHostSchema>;
export type RemoteWorkerProbe = z.infer<typeof remoteWorkerProbeSchema>;
export type OpenRemoteWorkspaceRequest = z.infer<
  typeof openRemoteWorkspaceRequestSchema
>;
export type SshTestResult = z.infer<typeof sshTestResultSchema>;
