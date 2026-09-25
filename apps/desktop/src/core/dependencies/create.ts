import type { DatabaseSync } from "node:sqlite";
import { getAgentStatus } from "../agent/status";
import { loadNode } from "../collab/nodes";
import { DomainError } from "../workspaces/support";
import { baselineFor } from "./evaluate";
import {
  DEFAULT_TTL_SECONDS,
  type DependencyCondition,
  type DependencyRow,
  type LaunchRow,
  insertLaunch,
  upstreamsOf,
} from "./store";

/**
 * 建一组依赖：一个下游、若干上游（设计 §6 的第三条——检测环、跨工作空间的
 * 无效引用、普通终端没有状态来源）。
 *
 * 校验与写入分成两步导出：`open-agent` 要在**建节点之前**就把不成立的
 * `--after` 拒掉，否则画布上会多出一个永远不会启动、也没有任何边在等的节点。
 */

export interface DependencyRequest {
  readonly workspaceId: string;
  readonly boardId: string;
  readonly downstreamNodeId: string;
  readonly after: readonly string[];
  readonly condition: DependencyCondition;
  readonly ttlSeconds?: number | undefined;
  readonly task?:
    | {
        readonly body: string;
        readonly sourceNodeId: string;
        readonly hops: number;
        readonly trail: readonly string[];
      }
    | undefined;
  /** 秒。 */
  readonly now: number;
}

function invalid(message: string): DomainError {
  return new DomainError(400, "bad_request", message);
}

/**
 * 上游是否可以被等。`downstreamNodeId` 在节点还没建出来时传 `undefined`：那
 * 时它不可能出现在任何环里。
 */
export function validateUpstreams(
  database: DatabaseSync,
  scope: { readonly workspaceId: string; readonly boardId: string },
  after: readonly string[],
  downstreamNodeId?: string,
): void {
  if (after.length === 0) throw invalid("没有要等的节点。");
  const seen = new Set<string>();
  for (const id of after) {
    if (seen.has(id)) throw invalid(`\`${id}\` 重复出现在依赖里。`);
    seen.add(id);
    if (id === downstreamNodeId) throw invalid("节点不能等它自己。");
    const node = loadNode(database, id);
    if (node === undefined || node.boardId !== scope.boardId) {
      // 跨画布、跨工作空间都算：依赖只在同一块画布上有意义，另一块画布上的
      // 节点对这里的人是看不见的。
      throw invalid(`\`${id}\` 不是这块画布上的节点。`);
    }
    if (node.workspaceId !== scope.workspaceId) {
      throw invalid(`\`${id}\` 不在这个工作空间里。`);
    }
    if (node.agentId === null) {
      // 普通终端从不报状态：等它「做完」就是永远等下去。
      throw invalid(
        `「${node.title}」不是 Agent 节点，没有状态来源，不能作为依赖。`,
      );
    }
    if (
      downstreamNodeId !== undefined &&
      reaches(database, id, downstreamNodeId)
    ) {
      throw invalid(`等「${node.title}」会形成一个环。`);
    }
  }
}

/** `from` 是否（经由还在等的边）等着 `target`。 */
function reaches(
  database: DatabaseSync,
  from: string,
  target: string,
): boolean {
  const stack = [from];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...upstreamsOf(database, current));
  }
  return false;
}

export function createDependencies(
  database: DatabaseSync,
  request: DependencyRequest,
): { readonly launch: LaunchRow; readonly dependencies: DependencyRow[] } {
  validateUpstreams(database, request, request.after, request.downstreamNodeId);
  const ttl = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  return insertLaunch(
    database,
    {
      nodeId: request.downstreamNodeId,
      workspaceId: request.workspaceId,
      boardId: request.boardId,
      task: request.task,
      now: request.now,
    },
    request.after.map((upstreamNodeId) => ({
      upstreamNodeId,
      condition: request.condition,
      ...baselineFor(
        request.condition,
        getAgentStatus(database, upstreamNodeId),
      ),
      expiresAt: request.now + ttl,
    })),
  );
}
