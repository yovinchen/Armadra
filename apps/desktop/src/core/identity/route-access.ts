import type { DatabaseSync } from "node:sqlite";
import type { CoreRequest } from "../http/router";
import type { RouteScopeRequirement } from "../http/route-scopes";
import { type AuthorizationSubject, isOwner } from "./authorize";
import { type RouteGuard, type RouteVerdict, requestIdentity } from "./gate";
import { type Scope, scope } from "./scopes";

/**
 * 服务器壳上的路由门：把路由表声明的 scope 按这次请求的主体判掉。
 *
 * 判定仍然只有一条路径（`permits`，设计 S3）；这里做的是**把一条路由要求的
 * 权限落到一个具体的工作空间上**。路由表对 `/api/workspaces/{id}/…` 已经带着
 * 工作空间，剩下的全局路由逐条归进三类（权限表见设计
 * `docs/design/server-accounts-and-sharing.md` §6）：
 *
 *   * **按对象落到工作空间**：工作空间列表（答案过滤）、终端（创建看请求体，
 *     已有会话看会话行）、Agent 状态与「被读取」（看节点）、审批与关闭确认
 *     （看那条待答的请求）。对象属于哪块画布，就按那块画布上的授权判。
 *   * **无害的全局读**：Agent 目录、模型目录、终端后端、公开状态页。新建菜单、
 *     节点头、终端面板都要它们，而它们不带任何人的数据；只要这个成员至少被
 *     共享了一块画布就放行。
 *   * **本机管理**：设置、执行主机、SSH、数据与备份、用量与账号、对话索引、
 *     克隆、电源、浏览器、GitHub 与自动化。要的是全局授权，而共享只发工作空间
 *     上的授权，所以成员在那里一律 403——这正是「共享的最小单位是工作空间」
 *     （设计 S4）。
 *
 * 没有请求身份（桌面壳、core 自己的动作）时整道门放行：那里只有本机 owner。
 */

/**
 * 路由门要问的几件「这个对象属于哪块画布」。缺省按库回答；测试可以逐条替换。
 * 答不出来一律是空串，而空串对成员就是拒绝。
 */
export interface RouteAccessLookups {
  /** 终端会话 → 工作空间。 */
  sessionWorkspace(sessionId: string): string;
  /** 终端会话 → 开它的 principal；本机 owner 与 core 自己开的是空串。 */
  sessionCreator(sessionId: string): string;
  /** 成员开终端成功之后记下创建者（迁移 0028 的那一列）。 */
  recordCreator(sessionId: string, principalId: string): void;
  /** 画布节点 → 工作空间。 */
  nodeWorkspace(nodeId: string): string;
  /** 待答的审批 → 工作空间。 */
  approvalWorkspace(pendingId: string): string;
  /** 待确认的关闭请求 → 工作空间（只在内存里）。 */
  confirmWorkspace(requestId: string): string;
}

export interface RouteAccessOptions {
  readonly database: DatabaseSync;
  /** 主体 ∪ 编译出来的授予够不够。owner 的恒真在调用方之前就判掉了。 */
  readonly permits: (
    subject: AuthorizationSubject,
    required: readonly Scope[],
  ) => boolean;
  /**
   * 主体今天的全部授权（快照 ∪ 编译出来的授予）。「无害的全局读」要知道他
   * 是不是至少被共享了一块画布；不给时这一类对成员一律不放。
   */
  readonly effectiveScopes?: (
    subject: AuthorizationSubject,
  ) => readonly Scope[];
  readonly lookups?: Partial<RouteAccessLookups>;
}

const ALLOW: RouteVerdict = { allowed: true };
const DENY: RouteVerdict = { allowed: false };

/** 不经路由门的面：健康检查，以及自己认证、自己判定的身份域。 */
function selfGuarded(path: string): boolean {
  return (
    path === "/health" ||
    path === "/api/health" ||
    path.startsWith("/api/identity/")
  );
}

/**
 * 无害的全局读：不带任何人的数据，画布上的日常操作离不开。只有 GET。
 *
 * Agent 目录带的是本机装了哪些 CLI、启动参数与集成版本，没有环境变量也没有
 * 凭据；operator 要按它启动 Agent，viewer 要按它画节点头。集成的安装 / 修复
 * 会改 CLI 的配置目录，那是本机管理，不在这里。
 */
const SHARED_READS: readonly RegExp[] = [
  /^\/api\/agents$/,
  /^\/api\/agents\/[^/]+\/models$/,
  /^\/api\/models\/catalog$/,
  /^\/api\/terminals\/backend$/,
  /^\/api\/usage\/status$/,
];

const TERMINAL_SESSION = /^\/api\/terminals\/([^/]+)(\/[^/]+)?(\/[^/]+)?$/;
const AGENT_STATUS =
  /^\/api\/agent-status\/([^/]+)\/(read|transcript|suggest-title)$/;
const CONTEXT_READS = /^\/api\/nodes\/([^/]+)\/context-reads$/;
const APPROVAL = /^\/api\/approvals\/([^/]+)\/answer$/;
const CONFIRM = /^\/api\/control\/confirm\/([^/]+)$/;

/** Agent 状态的三条路由各要什么。 */
const AGENT_STATUS_PERMISSION: Readonly<Record<string, string>> = {
  // 标已读只是清掉节点头上的未读点，看得见这块画布的人都会做。
  read: "canvas:read",
  // 转录就是终端画面的文字版：和读终端画面同一档。
  transcript: "terminal:read",
  // 建议标题最终是一次改名，和编辑画布同一档。
  "suggest-title": "canvas:write",
};

export function createRouteGuard(options: RouteAccessOptions): RouteGuard {
  const lookups: RouteAccessLookups = {
    ...databaseLookups(options.database),
    ...options.lookups,
  };

  const allowed = (
    subject: AuthorizationSubject,
    permission: string,
    workspaceId: string,
  ): boolean =>
    workspaceId !== "" &&
    options.permits(subject, [scope(permission, workspaceId)]);

  const onWorkspace = (
    subject: AuthorizationSubject,
    permission: string,
    workspaceId: string,
  ): RouteVerdict => (allowed(subject, permission, workspaceId) ? ALLOW : DENY);

  /** 至少在一块画布上有 `canvas:read`。 */
  const sharedSomewhere = (subject: AuthorizationSubject): boolean =>
    (options.effectiveScopes?.(subject) ?? []).some(
      (value) => value.Permission === "canvas:read",
    );

  return (request, requirement) => {
    const identity = requestIdentity();
    if (identity === undefined) return ALLOW;
    const subject = identity.subject;
    if (isOwner(subject)) return ALLOW;
    const path = request.path;
    if (selfGuarded(path)) return ALLOW;
    const method = request.method.toUpperCase();
    const reading = method === "GET" || method === "HEAD";

    if (reading && SHARED_READS.some((pattern) => pattern.test(path))) {
      return sharedSomewhere(subject) ? ALLOW : DENY;
    }

    // 表外的路由对成员一律不放：「没写要求」在单机上意味着「只有 owner 会来」，
    // 到了多账号的服务器上它不能悄悄变成「谁都能来」。
    if (requirement === undefined) return DENY;

    if (path === "/api/workspaces" && reading) {
      return {
        allowed: true,
        filter: (body) =>
          Array.isArray(body)
            ? body.filter(
                (item: unknown) =>
                  typeof (item as { id?: unknown })?.id === "string" &&
                  allowed(subject, "canvas:read", (item as { id: string }).id),
              )
            : body,
      };
    }

    if (path === "/api/terminals" && method === "POST") {
      const workspaceId = bodyWorkspace(request);
      if (!allowed(subject, "terminal:create", workspaceId)) return DENY;
      return {
        allowed: true,
        filter: (body) => {
          const id = (body as { id?: unknown } | null)?.id;
          if (typeof id === "string") {
            lookups.recordCreator(id, subject.principalId);
          }
          return body;
        },
      };
    }

    const session = TERMINAL_SESSION.exec(path);
    if (session !== null && path !== "/api/terminals/backend") {
      const sessionId = decodeURIComponent(session[1] as string);
      const workspaceId = lookups.sessionWorkspace(sessionId);
      if (workspaceId === "") return DENY;
      if (requirement.permission === "credential:use") return DENY;
      // 附着到终端的 socket 能写：`…/ws` 虽是 GET，按写入判。
      if (requirement.permission === "terminal:read" && !path.endsWith("/ws")) {
        return onWorkspace(subject, "terminal:read", workspaceId);
      }
      // 设计 S5：往自己开的终端里写只要 `terminal:create`，往别人的要
      // `terminal:drive`。「自己的」按会话行上记的创建者判，重启之后照旧。
      const own =
        subject.principalId !== "" &&
        lookups.sessionCreator(sessionId) === subject.principalId;
      return onWorkspace(
        subject,
        own ? "terminal:create" : "terminal:drive",
        workspaceId,
      );
    }

    const status = AGENT_STATUS.exec(path);
    if (status !== null) {
      return onWorkspace(
        subject,
        AGENT_STATUS_PERMISSION[status[2] as string] as string,
        lookups.nodeWorkspace(decodeURIComponent(status[1] as string)),
      );
    }
    const reads = CONTEXT_READS.exec(path);
    if (reads !== null) {
      return onWorkspace(
        subject,
        "canvas:read",
        lookups.nodeWorkspace(decodeURIComponent(reads[1] as string)),
      );
    }
    // 审批答复与关闭确认都是替 Agent 代答（设计 S5），和 `terminal:drive`
    // 同一档：只有那块画布上的 driver 答得了。
    const approval = APPROVAL.exec(path);
    if (approval !== null) {
      return onWorkspace(
        subject,
        "approval:answer",
        lookups.approvalWorkspace(decodeURIComponent(approval[1] as string)),
      );
    }
    const confirm = CONFIRM.exec(path);
    if (confirm !== null) {
      return onWorkspace(
        subject,
        "approval:answer",
        lookups.confirmWorkspace(decodeURIComponent(confirm[1] as string)),
      );
    }

    return requirement.workspaceId === ""
      ? DENY
      : onWorkspace(subject, requirement.permission, requirement.workspaceId);
  };
}

/** 缺省的查询：都读库，表或列不在（身份域比终端域先装、旧库）时答空串。 */
function databaseLookups(database: DatabaseSync): RouteAccessLookups {
  const text = (sql: string, id: string, column: string): string => {
    try {
      const row = database.prepare(sql).get(id) as
        | Record<string, unknown>
        | undefined;
      const value = row?.[column];
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  return {
    sessionWorkspace: (id) =>
      text(
        "SELECT workspace_id FROM terminal_sessions WHERE id = ?",
        id,
        "workspace_id",
      ),
    sessionCreator: (id) =>
      text(
        "SELECT creator_principal_id FROM terminal_sessions WHERE id = ?",
        id,
        "creator_principal_id",
      ),
    recordCreator: (id, principalId) => {
      try {
        database
          .prepare(
            "UPDATE terminal_sessions SET creator_principal_id = ? WHERE id = ?",
          )
          .run(principalId, id);
      } catch {
        // 记不下来的后果是这个终端按「别人的」判：少一份权限，不多一份。
      }
    },
    // 节点在画布文档里，没有一张「节点 → 画布」的总表。按最常见的几处依次
    // 找：报过状态的 Agent 节点、起过终端的节点、有名字的节点（在哪块板上）。
    nodeWorkspace: (id) =>
      text(
        "SELECT workspace_id FROM agent_status WHERE node_id = ?",
        id,
        "workspace_id",
      ) ||
      text(
        "SELECT workspace_id FROM terminal_sessions WHERE owner_node_id = ? " +
          "ORDER BY created_at DESC LIMIT 1",
        id,
        "workspace_id",
      ) ||
      text(
        "SELECT b.workspace_id AS workspace_id FROM node_handles h " +
          "JOIN boards b ON b.id = h.board_id WHERE h.node_id = ?",
        id,
        "workspace_id",
      ),
    approvalWorkspace: (id) =>
      text(
        "SELECT workspace_id FROM agent_approvals WHERE id = ?",
        id,
        "workspace_id",
      ),
    confirmWorkspace: () => "",
  };
}

function bodyWorkspace(request: CoreRequest): string {
  try {
    const body = request.json<{ workspaceId?: unknown }>();
    return typeof body?.workspaceId === "string" ? body.workspaceId : "";
  } catch {
    return "";
  }
}
