import { z } from "zod";

/**
 * 依赖编排（Agent 自动化设计 §6）——`GET /api/workspaces/{id}/dependencies`。
 *
 * 等待关系由 core 持有：`open-agent --after` 写的是依赖表，不再是节点数据里的
 * `pendingLaunch`。节点头的「等待 X」与 rope 边都从这里派生。
 */

export const dependencyStateSchema = z.enum([
  "waiting",
  "satisfied",
  "failed",
  "missing",
  "expired",
  "cancelled",
]);

export const agentDependencySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  downstreamNodeId: z.string(),
  upstreamNodeId: z.string(),
  /** 上游节点现在的标题；节点已被删除时是 `null`。 */
  upstreamTitle: z.string().nullable(),
  condition: z.enum(["current", "next"]),
  state: dependencyStateSchema,
  /** 稳定码（`upstreamFailed` / `upstreamExited` / `ttl` …），不翻译。 */
  reason: z.string().nullable(),
  baseline: z.object({
    state: z.string().nullable(),
    eventAt: z.string().nullable(),
  }),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

export const dependencyLaunchSchema = z.object({
  nodeId: z.string(),
  workspaceId: z.string(),
  boardId: z.string(),
  state: z.enum(["waiting", "launched", "failed"]),
  reason: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  hasTask: z.boolean(),
  sessionId: z.string().nullable(),
  createdAt: z.string().nullable(),
  launchedAt: z.string().nullable(),
  dependencies: z.array(agentDependencySchema),
});

export const dependenciesResponseSchema = z.object({
  launches: z.array(dependencyLaunchSchema),
});

/** 旧 `pendingLaunch` 迁入：`POST /api/workspaces/{id}/dependencies`。 */
export const legacyDependencyRequestSchema = z.object({
  nodeId: z.string(),
  after: z.array(z.string()),
});

export const legacyDependencyResponseSchema = z.object({
  launch: dependencyLaunchSchema,
});

export const dependencyCancelResponseSchema = z.object({
  dependency: agentDependencySchema,
});

export type AgentDependency = z.infer<typeof agentDependencySchema>;
export type DependencyLaunch = z.infer<typeof dependencyLaunchSchema>;
