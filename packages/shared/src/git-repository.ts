import { z } from "zod";

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const count = z.number().int().nonnegative().safe();
export const gitExpectedStateSchema = z.object({
  headOid: oid.nullable(),
  branch: z.string().nullable(),
});
export const gitBranchRecordSchema = z.object({
  name: z.string(),
  fullRef: z.string(),
  oid,
  remote: z.boolean(),
  current: z.boolean(),
  upstream: z.string().nullable(),
  ahead: count.nullable(),
  behind: count.nullable(),
  upstreamMissing: z.boolean(),
  symbolicTarget: z.string().nullable(),
});
export const gitBranchSnapshotSchema = z.object({
  repositoryId: z.string().min(1),
  repositoryPath: z.string(),
  head: gitExpectedStateSchema,
  branches: z.array(gitBranchRecordSchema),
  remotes: z.array(z.string()),
  observedAt: z.string(),
});
export const gitCommitRecordSchema = z.object({
  oid,
  parents: z.array(oid),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authorTime: z.string(),
  committerTime: z.string(),
  refs: z.array(z.string()),
});
export const gitHistoryPageSchema = z.object({
  reference: z.string(),
  anchorOid: oid.nullable(),
  commits: z.array(gitCommitRecordSchema),
  nextCursor: z.string().nullable(),
  shallow: z.boolean(),
});
export const gitWorktreeRecordSchema = z.object({
  path: z.string(),
  headOid: oid.nullable(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  bare: z.boolean(),
  isMain: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().nullable(),
  prunable: z.boolean(),
  pruneReason: z.string().nullable(),
  accessible: z.boolean(),
  dirty: z.boolean().nullable(),
});
export const gitWorktreesSchema = z.array(gitWorktreeRecordSchema);
export const gitRepositoryActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("createBranch"),
      name: z.string().min(1),
      startPoint: z.string().nullable(),
      switch: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("switchBranch"),
      name: z.string().min(1),
      expectedOid: oid,
    })
    .strict(),
  z
    .object({
      kind: z.literal("deleteBranch"),
      name: z.string().min(1),
      expectedOid: oid,
    })
    .strict(),
  z
    .object({
      kind: z.literal("fetch"),
      remote: z.string().min(1),
      prune: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull"),
      remote: z.string().min(1),
      branch: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("push"),
      remote: z.string().min(1),
      branch: z.string().min(1),
      setUpstream: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("createWorktree"),
      expectedOid: oid.nullable(),
      path: z.string().min(1),
      branch: z.string().min(1),
      createBranch: z.boolean(),
      startPoint: z.string().nullable(),
    })
    .strict()
    .refine(
      (action) =>
        action.createBranch
          ? action.expectedOid === null
          : action.expectedOid !== null,
      {
        path: ["expectedOid"],
        message: "Existing worktree branches require their observed object ID",
      },
    ),
  z
    .object({
      kind: z.literal("removeWorktree"),
      path: z.string().min(1),
      expectedOid: oid,
      allowUnpublished: z.boolean(),
    })
    .strict(),
]);
export const gitRepositoryOperationSchema = z.object({
  id: z.string().min(1),
  repositoryId: z.string().min(1),
  workspaceRoot: z.string(),
  repositoryPath: z.string(),
  action: gitRepositoryActionSchema,
  state: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknownOutcome",
  ]),
  cancellationRequested: z.boolean(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string().nullable(),
});
export type GitExpectedState = z.infer<typeof gitExpectedStateSchema>;
export type GitBranchSnapshot = z.infer<typeof gitBranchSnapshotSchema>;
export type GitBranchRecord = z.infer<typeof gitBranchRecordSchema>;
export type GitCommitRecord = z.infer<typeof gitCommitRecordSchema>;
export type GitHistoryPage = z.infer<typeof gitHistoryPageSchema>;
export type GitWorktreeRecord = z.infer<typeof gitWorktreeRecordSchema>;
export type GitRepositoryAction = z.infer<typeof gitRepositoryActionSchema>;
export type GitRepositoryOperation = z.infer<
  typeof gitRepositoryOperationSchema
>;
