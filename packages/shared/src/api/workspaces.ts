import { z } from "zod";

import {
  workspacePermissionsSchema,
  workspaceSummarySchema,
} from "../domain/index.js";

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

export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;
export type UpdateWorkspaceRequest = z.infer<
  typeof updateWorkspaceRequestSchema
>;
