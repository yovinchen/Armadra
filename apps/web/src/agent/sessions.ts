/**
 * 会话读模型（§3.5 / §13.4）。
 *
 * `GET /api/workspaces/{id}/sessions` 给出「有哪些会话」，
 * `agent.status` 事件给出「它们现在怎么样」，两者在这里合流成 `SessionRow`。
 * 分桶与排序都是纯函数，侧栏只负责渲染。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentState, AgentStatus, SessionSummary } from "@armadra/shared";

import { runtimeApi } from "../api/client";
import { isAttention, useAgentStatusStore } from "./status-store";

export interface SessionRow {
  nodeId: string;
  boardId: string;
  sessionId: string;
  title: string;
  cwd: string;
  agentId?: string;
  state?: AgentState;
  unread: boolean;
  pendingId?: string;
  updatedAt: string;
  /** 该 Runtime 实例里进程还活着。 */
  alive: boolean;
  /** 停留在当前状态多久（毫秒）。 */
  sinceMs: number;
}

export const SESSION_BUCKETS = [
  "attention",
  "unread",
  "working",
  "idle",
  "unknown",
] as const;
export type SessionBucket = (typeof SESSION_BUCKETS)[number];

export interface SessionSection {
  bucket: SessionBucket;
  rows: SessionRow[];
}

function millis(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? 0 : value;
}

/** 状态模式的分区归属，顺序即优先级（§3.5）。 */
export function sessionBucket(row: SessionRow): SessionBucket {
  if (isAttention(row)) return "attention";
  // 正在运行的节点按当前状态归类（与 MiniMap 一致）；未读只在行内显示标记。
  if (row.state === "working") return "working";
  if (row.unread) return "unread";
  if (row.state) return "idle";
  return "unknown";
}

/** 会话摘要 + 状态镜像 → 列表行。状态镜像更新时它比摘要新，因此优先。 */
export function mergeSessions(
  summaries: readonly SessionSummary[],
  statuses: Record<string, AgentStatus>,
  now: number = Date.now(),
): SessionRow[] {
  return summaries
    .map((summary) => {
      const status = statuses[summary.nodeId];
      const fresher =
        status !== undefined &&
        millis(status.updatedAt) >= millis(summary.updatedAt);
      const updatedAt = fresher ? status.updatedAt : summary.updatedAt;
      return {
        nodeId: summary.nodeId,
        boardId: summary.boardId,
        sessionId: summary.sessionId,
        title: summary.title,
        cwd: summary.cwd,
        agentId: status?.agentId ?? summary.agentId,
        state: fresher ? status.state : summary.state,
        unread: fresher ? status.unread : summary.unread,
        pendingId: fresher ? status.pendingId : summary.pendingId,
        updatedAt,
        alive: summary.alive,
        sinceMs: Math.max(0, now - millis(updatedAt)),
      } satisfies SessionRow;
    })
    .sort(byRecency);
}

/** 最近变更在前；时间相同再按标题稳定排序。 */
export function byRecency(a: SessionRow, b: SessionRow): number {
  const diff = millis(b.updatedAt) - millis(a.updatedAt);
  return diff !== 0 ? diff : a.title.localeCompare(b.title);
}

/** 状态模式分区：固定顺序，空区不返回。 */
export function groupSessionsByStatus(
  rows: readonly SessionRow[],
): SessionSection[] {
  const sections = new Map<SessionBucket, SessionRow[]>();
  for (const row of rows) {
    const bucket = sessionBucket(row);
    const list = sections.get(bucket) ?? [];
    list.push(row);
    sections.set(bucket, list);
  }
  return SESSION_BUCKETS.filter((bucket) => sections.has(bucket)).map(
    (bucket) => ({
      bucket,
      rows: [...sections.get(bucket)!].sort(byRecency),
    }),
  );
}

/** 过滤框：标题与目录，大小写不敏感。 */
export function filterSessions(
  rows: readonly SessionRow[],
  query: string,
): SessionRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(needle) ||
      row.cwd.toLowerCase().includes(needle),
  );
}

/** 目录名，会话行第二行用。 */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** 只为了让「处于该状态多久」跟着走的重渲染节拍。 */
function useTick(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

export interface UseSessionsResult {
  sessions: SessionRow[];
  isPending: boolean;
  refresh: () => void;
}

export function useSessions(workspaceId: string | null): UseSessionsResult {
  const query = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => runtimeApi.sessions(workspaceId!),
    enabled: Boolean(workspaceId),
    retry: false,
  });
  const statuses = useAgentStatusStore((state) => state.statuses);
  const tick = useTick(5_000);

  // 镜像补齐不在这里。它跟着应用挂载走（`useAgentStatusHydration`），
  // 否则画布上的节点徽标会取决于侧栏挂没挂。
  const sessions = useMemo(
    () => mergeSessions(query.data ?? [], statuses, Date.now()),
    // `tick` 只是节拍源，故意进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.data, statuses, tick],
  );

  return {
    sessions,
    isPending: query.isPending && Boolean(workspaceId),
    refresh: () => void query.refetch(),
  };
}
