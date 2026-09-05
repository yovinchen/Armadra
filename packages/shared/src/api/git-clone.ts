import { z } from "zod";

import { workspaceSchema } from "../domain/index.js";

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

export type GitCloneRequest = z.infer<typeof gitCloneRequestSchema>;
export type GitCloneStarted = z.infer<typeof gitCloneStartedSchema>;
export type GitCloneState = z.infer<typeof gitCloneStateSchema>;
export type GitCloneStatus = z.infer<typeof gitCloneStatusSchema>;
