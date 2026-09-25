import type { DatabaseSync } from "node:sqlite";
import { collab } from "../agent";
import { loadNode } from "../collab/nodes";
import type {
  CoreRequest,
  HandlerResult,
  RouteMatch,
  Router,
} from "../http/router";
import type { CoreContext } from "../main";
import { DomainError } from "../workspaces/support";
import { createDependencies } from "./create";
import { dependencyService, setDependencyService } from "./registry";
import { DependencyService } from "./service";
import {
  type DependencyRow,
  type LaunchRow,
  dependenciesOf,
  launchFor,
  listForWorkspace,
} from "./store";

/**
 * 依赖编排域的装配点：服务与三条路由（设计 §6）。
 *
 * 在终端与调度之后装配：启动要借终端域交回来的桥（`collab().terminals`），
 * 而那座桥是终端域装好之后才有的。桥每次现取，所以装配顺序只决定「第一次扫
 * 描时有没有」，不决定对不对。
 */

export { dependencyService } from "./registry";

export function install(context: CoreContext): DependencyService {
  const database = context.db.database;
  const service = new DependencyService({
    database,
    collab: () => collab(),
    bus: context.bus,
    log: (message, fields) => context.log.info(message, fields),
  });
  setDependencyService(service);
  installRoutes(context.server.router, database);
  service.start();
  return service;
}

/* ---------------------------------- JSON ---------------------------------- */

function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

export function dependencyJson(
  database: DatabaseSync,
  row: DependencyRow,
): Record<string, unknown> {
  const upstream = loadNode(database, row.upstreamNodeId);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    downstreamNodeId: row.downstreamNodeId,
    upstreamNodeId: row.upstreamNodeId,
    upstreamTitle: upstream?.title ?? null,
    condition: row.condition,
    state: row.state,
    reason: row.reason,
    baseline: { state: row.baselineState, eventAt: row.baselineEventAt },
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    expiresAt: iso(row.expiresAt),
    resolvedAt: iso(row.resolvedAt),
  };
}

export function launchJson(
  database: DatabaseSync,
  launch: LaunchRow,
  dependencies: readonly DependencyRow[],
): Record<string, unknown> {
  return {
    nodeId: launch.nodeId,
    workspaceId: launch.workspaceId,
    boardId: launch.boardId,
    state: launch.state,
    reason: launch.reason,
    attempts: launch.attempts,
    hasTask: launch.taskBody !== null,
    sessionId: launch.sessionId,
    createdAt: iso(launch.createdAt),
    launchedAt: iso(launch.launchedAt),
    dependencies: dependencies.map((row) => dependencyJson(database, row)),
  };
}

/* --------------------------------- 路由 ---------------------------------- */

export function installRoutes(router: Router, database: DatabaseSync): void {
  // 一个工作空间里还没了结的等待，按下游分组。节点头「等待 X」与 rope 边都
  // 读它：界面上的等待关系由服务的状态派生，不再从节点数据里猜。
  router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/dependencies",
    answered((match, request) => {
      const workspaceId = param(match, "workspaceId");
      const nodeId = request.query.get("nodeId") ?? undefined;
      const all = request.query.get("all") === "true";
      const launches = listForWorkspace(database, workspaceId, {
        ...(nodeId === undefined || nodeId === "" ? {} : { nodeId }),
        all,
      }).filter(
        (entry) => loadNode(database, entry.launch.nodeId) !== undefined,
      );
      return {
        status: 200,
        body: {
          launches: launches.map((entry) =>
            launchJson(database, entry.launch, entry.dependencies),
          ),
        },
      };
    }),
  );

  // 不等这条边了。其余的边都已满足时，下游就在这一次取消里启动。
  router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/dependencies/{dependencyId}",
    answered((match) => {
      const service = requireService();
      const cancelled = service.cancel(
        param(match, "workspaceId"),
        param(match, "dependencyId"),
      );
      if (cancelled === undefined) {
        throw new DomainError(404, "not_found", "没有这条依赖。");
      }
      return {
        status: 200,
        body: { dependency: dependencyJson(database, cancelled) },
      };
    }),
  );

  // 旧数据迁入：页面挂载时发现节点数据里还躺着一份带依赖的 `pendingLaunch`，
  // 就交给这里建成依赖行，然后自己把那份数据清掉。core 从此只读不写它。新
  // 的依赖只由 `canvas open-agent --after` 建，这条路径只收旧数据，所以条件
  // 固定是 `current`——旧实现等的就是「上游做完手上这一轮」。
  router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/dependencies",
    answered((match, request) => {
      const workspaceId = param(match, "workspaceId");
      const body = jsonObject(request);
      const nodeId = body.nodeId;
      const after = body.after;
      if (typeof nodeId !== "string" || nodeId === "") {
        throw badRequest("nodeId is required");
      }
      if (
        !Array.isArray(after) ||
        after.some((item) => typeof item !== "string")
      ) {
        throw badRequest("after must be an array of node ids");
      }
      const node = loadNode(database, nodeId);
      if (node === undefined || node.workspaceId !== workspaceId) {
        throw new DomainError(404, "not_found", "这个工作空间里没有这个节点。");
      }
      if (node.agentId === null) throw badRequest("不是 Agent 节点。");
      const existing = launchFor(database, nodeId);
      if (existing !== undefined) {
        return {
          status: 200,
          body: {
            launch: launchJson(
              database,
              existing,
              dependenciesOf(database, nodeId),
            ),
          },
        };
      }
      // 旧实现把「上游已被删」当作满足、把普通终端当作永远等不到。迁入时两
      // 种都不建边：前者保持旧语义，后者建出来也只会是一条永远不结束的等待。
      const upstreams = [...new Set(after as string[])].filter((id) => {
        if (id === nodeId) return false;
        const upstream = loadNode(database, id);
        return (
          upstream !== undefined &&
          upstream.boardId === node.boardId &&
          upstream.agentId !== null
        );
      });
      const created =
        upstreams.length === 0
          ? createEmpty(database, node)
          : createDependencies(database, {
              workspaceId,
              boardId: node.boardId,
              downstreamNodeId: nodeId,
              after: upstreams,
              condition: "current",
              now: Math.floor(Date.now() / 1000),
            });
      void dependencyService()?.created(nodeId);
      return {
        status: 200,
        body: {
          launch: launchJson(database, created.launch, created.dependencies),
        },
      };
    }),
  );
}

/** 一条边也没剩下的旧等待：建一个空的启动，服务会立刻把它启动。 */
function createEmpty(
  database: DatabaseSync,
  node: {
    readonly id: string;
    readonly workspaceId: string;
    readonly boardId: string;
  },
): { launch: LaunchRow; dependencies: DependencyRow[] } {
  const now = Math.floor(Date.now() / 1000);
  database
    .prepare(
      "INSERT OR IGNORE INTO agent_dependency_launches (node_id, workspace_id, board_id, " +
        "state, created_at, updated_at) VALUES (?, ?, ?, 'waiting', ?, ?)",
    )
    .run(node.id, node.workspaceId, node.boardId, now, now);
  return {
    launch: launchFor(database, node.id) as LaunchRow,
    dependencies: [],
  };
}

function requireService(): DependencyService {
  const service = dependencyService();
  if (service === undefined) {
    throw new DomainError(503, "unavailable", "依赖编排没有装配。");
  }
  return service;
}

function badRequest(message: string): DomainError {
  return new DomainError(400, "bad_request", message);
}

function param(match: RouteMatch, name: string): string {
  const value = match.params[name];
  if (value === undefined) {
    throw new DomainError(500, "internal_error", `${name} is not in the path`);
  }
  return value;
}

function jsonObject(request: CoreRequest): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = request.json<unknown>();
  } catch {
    throw badRequest("Request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function answered(
  handle: (match: RouteMatch, request: CoreRequest) => HandlerResult,
): (match: RouteMatch, request: CoreRequest) => HandlerResult {
  return (match, request) => {
    try {
      return handle(match, request);
    } catch (error) {
      if (error instanceof DomainError) {
        const { status, body } = error.response();
        return { status, body };
      }
      throw error;
    }
  };
}
