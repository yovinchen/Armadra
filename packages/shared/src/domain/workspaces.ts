import { z } from "zod";

import { timestampSchema } from "./internal.js";

export const workspacePermissionsSchema = z.object({
  read: z.boolean().default(true),
  write: z.boolean().default(true),
  execute: z.boolean().default(true),
});

export const DEFAULT_WORKSPACE_PERMISSIONS = {
  read: true,
  write: true,
  execute: true,
} as const;

export const WORKSPACE_COLORS = [
  "#5B5BD6",
  "#2E7CF6",
  "#1F9D64",
  "#D18F0F",
  "#8A4FD6",
  "#0E9AA7",
  "#E0762E",
  "#DC4C4A",
] as const;

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  rootPath: z.string().min(1),
  color: z.string().min(1).max(32).default(WORKSPACE_COLORS[0]),
  permissions: workspacePermissionsSchema.default(
    DEFAULT_WORKSPACE_PERMISSIONS,
  ),
  /**
   * Where this workspace's files, search and Git run (H02). Empty — and the
   * runtime omits the field entirely for a local workspace — means the machine
   * the Runtime is on. Anything else is an SSH execution host id, and then
   * `rootPath` is a path on *that* host.
   */
  executionHostId: z.string().max(64).default(""),
  lastOpenedAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const boardSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  nodeCount: z.number().int().nonnegative(),
});

export const workspaceSummarySchema = workspaceSchema.extend({
  boards: z.array(boardSummarySchema).default([]),
});

export type BoardSummary = z.infer<typeof boardSummarySchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspacePermissions = z.infer<typeof workspacePermissionsSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
