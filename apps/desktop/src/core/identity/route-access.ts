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
 * 工作空间，剩下几条全局路由里，成员真正要用的只有两类，逐条写在下面：
 *
 *   * 工作空间列表：放行，答案里只留他看得见的那几块。
 *   * 终端：创建时工作空间在请求体里；已有会话按会话查它属于哪块画布。
 *
 * 其余全局路由（设置、Agent 目录、执行主机、克隆……）要的是全局授权，而共享
 * 只发工作空间上的授权，所以成员在那里一律 403——这正是「共享的最小单位是
 * 工作空间」（设计 S4）。
 *
 * 没有请求身份（桌面壳、core 自己的动作）时整道门放行：那里只有本机 owner。
 */

export interface RouteAccessOptions {
  readonly database: DatabaseSync;
  /** 主体 ∪ 编译出来的授予够不够。owner 的恒真在调用方之前就判掉了。 */
  readonly permits: (
    subject: AuthorizationSubject,
    required: readonly Scope[],
  ) => boolean;
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

const TERMINAL_SESSION = /^\/api\/terminals\/([^/]+)(\/[^/]+)?(\/[^/]+)?$/;

export function createRouteGuard(options: RouteAccessOptions): RouteGuard & {
  /** 测试与诊断：这个进程记下的成员终端创建者。 */
  readonly creators: ReadonlyMap<string, string>;
} {
  /**
   * 成员开的终端 → 开它的人。
   *
   * 设计 S5：往**自己**开的终端里写只要 `terminal:create`（operator），往别人
   * 的里写要 `terminal:drive`（driver）。路由看不见会话的创建者，所以创建成功
   * 的那一刻在这里记下；重启之后这张表是空的，于是所有旧会话都按「别人的」
   * 判——宁可让 operator 重开一个，也不让他写进一个说不清是谁的终端。
   */
  const creators = new Map<string, string>();

  const workspaceOfSession = (sessionId: string): string => {
    try {
      const row = options.database
        .prepare("SELECT workspace_id FROM terminal_sessions WHERE id = ?")
        .get(sessionId) as { workspace_id?: unknown } | undefined;
      return typeof row?.workspace_id === "string" ? row.workspace_id : "";
    } catch {
      // 终端域没装（没有这张表）时，会话属于哪块画布无从回答：按全局判。
      return "";
    }
  };

  const allowed = (
    subject: AuthorizationSubject,
    permission: string,
    workspaceId: string,
  ): boolean => options.permits(subject, [scope(permission, workspaceId)]);

  const guard = ((
    request: CoreRequest,
    requirement: RouteScopeRequirement | undefined,
  ): RouteVerdict => {
    const identity = requestIdentity();
    if (identity === undefined) return ALLOW;
    const subject = identity.subject;
    if (isOwner(subject)) return ALLOW;
    const path = request.path;
    if (selfGuarded(path)) return ALLOW;
    // 表外的路由对成员一律不放：「没写要求」在单机上意味着「只有 owner 会来」，
    // 到了多账号的服务器上它不能悄悄变成「谁都能来」。
    if (requirement === undefined) return DENY;
    const method = request.method.toUpperCase();

    if (path === "/api/workspaces" && method === "GET") {
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
      if (workspaceId === "") return DENY;
      if (!allowed(subject, "terminal:create", workspaceId)) return DENY;
      return {
        allowed: true,
        filter: (body) => {
          const id = (body as { id?: unknown } | null)?.id;
          if (typeof id === "string") creators.set(id, subject.principalId);
          return body;
        },
      };
    }

    const session = TERMINAL_SESSION.exec(path);
    if (session !== null && path !== "/api/terminals/backend") {
      const sessionId = decodeURIComponent(session[1] as string);
      const workspaceId = workspaceOfSession(sessionId);
      if (workspaceId === "") return DENY;
      if (requirement.permission === "terminal:read") {
        // 附着到终端的 socket 能写：`…/ws` 虽是 GET，按写入判。
        if (!path.endsWith("/ws")) {
          return allowed(subject, "terminal:read", workspaceId) ? ALLOW : DENY;
        }
      }
      if (requirement.permission === "credential:use") return DENY;
      const own = creators.get(sessionId) === subject.principalId;
      return allowed(
        subject,
        own ? "terminal:create" : "terminal:drive",
        workspaceId,
      )
        ? ALLOW
        : DENY;
    }

    return allowed(subject, requirement.permission, requirement.workspaceId)
      ? ALLOW
      : DENY;
  }) as RouteGuard & { creators: ReadonlyMap<string, string> };
  Object.defineProperty(guard, "creators", { value: creators });
  return guard;
}

function bodyWorkspace(request: CoreRequest): string {
  try {
    const body = request.json<{ workspaceId?: unknown }>();
    return typeof body?.workspaceId === "string" ? body.workspaceId : "";
  } catch {
    return "";
  }
}
