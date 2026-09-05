import { z } from "zod";
import { gitExpectedStateSchema } from "./git-repository.js";

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
export const gitConflictSideSchema = z.object({
  oid,
  mode: z.enum(["100644", "100755", "120000", "160000"]),
  size: z.number().int().nonnegative().safe(),
  preview: z.string(),
  binary: z.boolean().nullable(),
  truncated: z.boolean(),
});
export const gitConflictFileSchema = z.object({
  path: z.string().min(1),
  base: gitConflictSideSchema.nullable(),
  ours: gitConflictSideSchema.nullable(),
  theirs: gitConflictSideSchema.nullable(),
});
export const gitIntegrationSnapshotSchema = z.object({
  repositoryId: z.string().min(1),
  repositoryPath: z.string(),
  head: gitExpectedStateSchema,
  stateToken: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum([
    "none",
    "merge",
    "rebase",
    "cherryPick",
    "revert",
    "bisect",
    "unknown",
  ]),
  owned: z.boolean(),
  sessionId: z.string().uuid().nullable(),
  originalHead: oid.nullable(),
  targetOid: oid.nullable(),
  message: z.string().nullable(),
  dirty: z.boolean(),
  canContinue: z.boolean(),
  conflicts: z.array(gitConflictFileSchema),
});
export type GitConflictSide = z.infer<typeof gitConflictSideSchema>;
export type GitConflictFile = z.infer<typeof gitConflictFileSchema>;
export type GitIntegrationSnapshot = z.infer<
  typeof gitIntegrationSnapshotSchema
>;
