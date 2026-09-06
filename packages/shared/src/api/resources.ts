import { z } from "zod";

import { terminalBackendKindSchema } from "./terminals.js";

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
  /**
   * `languageServer` is a server the editor started (language service design
   * §3.3). It is a tree row: `rust-analyzer` runs `cargo check` and `gopls`
   * runs the Go toolchain, and that helper is the work the server exists to
   * do — leaving it out would make a busy server look idle.
   */
  kind: z.enum(["runtime", "host", "commandWorker", "languageServer"]),
  /**
   * Which machine the process is on. A language server for a remote workspace
   * runs on the execution host, so its row is `remote` and carries no numbers:
   * this machine cannot measure another host's memory, and the local `ssh`
   * client's few megabytes are not the server's footprint (language service
   * design §3.3).
   */
  location: resourceLocationSchema.default("local"),
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
export type PowerPolicy = z.infer<typeof powerPolicySchema>;
export type PowerLease = z.infer<typeof powerLeaseSchema>;
export type PowerLeaseSource = z.infer<typeof powerLeaseSourceSchema>;
export type PowerLeaseRequest = z.infer<typeof powerLeaseRequestSchema>;
export type PowerState = z.infer<typeof powerStateSchema>;
export type PowerInhibitor = z.infer<typeof powerInhibitorSchema>;
