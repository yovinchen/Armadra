import type { GrantSubjectKind, GroupRole } from "./accounts-store";
import type { AccountsService } from "./accounts";
import type { AuthorizationSubject } from "./authorize";
import { IdentityError } from "./errors";
import type { CoreRequest } from "../http/router";
import { SHARE_ROLES } from "./roles";
import type { Principal } from "./service";

/**
 * 账号 / 组 / 共享的 JSON 面，挂在身份域已有的 `/api/identity/` 前缀下。
 *
 * 形状照 `docs/design/server-accounts-and-sharing.md` §3，**路径有一处偏差**：
 * 设计把组写作 `/api/groups`、共享写作 `/api/workspaces/{id}/grants`、审计写作
 * `/api/audit`；这里全部落在 `/api/identity/` 下（`identity/groups`、
 * `identity/grants?workspaceId=`、`identity/audit`）。理由是 `/api/workspaces/*`
 * 属于那张与 Rust Runtime 逐条对账的路由表（`core/http/routes.ts`，契约到
 * R7），往里加一条 Rust 没有的路由就是让两边对不上；而身份域这个前缀本来就是
 * core 自己的面，加路径不影响任何对账。R6 的服务器壳要改成设计里的写法时，改
 * 的是这一个文件的分发表。
 *
 * 做不到的按设计要求**返回 501 且形状一致**：passkey 的注册与断言、OAuth 绑定
 * 的 start / callback、开放注册。它们都不引入新依赖，也不给出半个实现——一个
 * 半通的 WebAuthn 比一个诚实的 501 难拆得多。
 */

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export interface AccountsHttpContext {
  readonly accounts: AccountsService;
  /** 已认证的调用方；未认证时抛 `unauthenticated`。 */
  readonly authenticate: () => Principal;
  /** 口令登录，落在同一张会话表上。 */
  readonly login: (input: {
    principalId: string;
    password: string;
    deviceName: string;
  }) => unknown;
}

/** 501 的统一形状：`{ code, message }`，和其余失败同一个信封。 */
export function notImplemented(feature: string): Answer {
  return {
    status: 501,
    body: {
      code: "NOT_IMPLEMENTED",
      message: `${feature} 尚未实现（服务器账号 R8）`,
    },
  };
}

/**
 * 分发一条 `/api/identity/…` 请求；不是这个面的路径返回 `undefined`，由调用方
 * 继续它自己的 404。
 */
export function handleAccounts(
  action: string,
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  const method = request.method.toUpperCase();
  const segments = action.split("/").filter((part) => part !== "");
  const head = segments[0] ?? "";
  switch (head) {
    case "principals":
      return principals(method, segments, request, context);
    case "credentials":
      return credentials(method, segments, request, context);
    case "login":
      return login(method, request, context);
    case "register":
      return method === "POST" ? register(request, context) : undefined;
    case "invitations":
      return invitations(method, segments, request, context);
    case "groups":
      return groups(method, segments, request, context);
    case "grants":
      return grants(method, segments, request, context);
    case "audit":
      return audit(method, request, context);
    default:
      return undefined;
  }
}

function principals(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  const accounts = context.accounts;
  if (segments.length === 1 && method === "GET") {
    return {
      status: 200,
      body: { principals: accounts.listPrincipals(subject(context)) },
    };
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    return {
      status: 201,
      body: accounts.createPrincipal(subject(context), {
        displayName: text(body.displayName),
        ...(body.kind === "service" ? { kind: "service" as const } : {}),
      }),
    };
  }
  if (segments.length === 3 && segments[2] === "disable" && method === "POST") {
    accounts.disablePrincipal(subject(context), segments[1] as string);
    return { status: 200, body: { disabled: true } };
  }
  return undefined;
}

function credentials(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  const accounts = context.accounts;
  // passkey 与 OAuth 的形状现在就在表里，答案是 501：WebAuthn 要一个这一批不
  // 引入的依赖，OAuth 要一次外呼。页面因此能分清「没有这个接口」和「还没做」。
  if (segments[1] === "passkey" && method === "POST") {
    return notImplemented(`passkey ${segments[2] ?? ""}`.trim());
  }
  if (segments[1] === "oauth" && method === "POST") {
    return notImplemented(`OAuth 绑定 ${segments[2] ?? ""}`.trim());
  }
  if (segments.length === 1 && method === "GET") {
    const principalId = request.query.get("principalId") ?? "";
    return {
      status: 200,
      body: {
        credentials: accounts.listCredentials(subject(context), principalId),
      },
    };
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    const kind = text(body.kind === undefined ? "password" : body.kind);
    if (kind !== "password") return notImplemented(`${kind} 凭据`);
    return {
      status: 201,
      body: accounts.setPassword(
        subject(context),
        text(body.principalId),
        text(body.password),
      ),
    };
  }
  if (segments.length === 2 && method === "DELETE") {
    accounts.revokeCredential(subject(context), segments[1] as string);
    return { status: 200, body: { revoked: true } };
  }
  return undefined;
}

function login(
  method: string,
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  if (method !== "POST") return undefined;
  const body = object(request);
  if (body.passkey !== undefined) return notImplemented("passkey 登录");
  return {
    status: 200,
    body: context.login({
      principalId: text(body.principalId),
      password: text(body.password),
      deviceName:
        body.deviceName === undefined ? "Armadra" : text(body.deviceName),
    }),
  };
}

/**
 * 注册。持邀请的那一半做实了：新来的人手里只有邀请链接，这一步替他建账号、
 * 兑换邀请、再照口令登录发会话。不带邀请的开放注册仍是 501——它要一个
 * `allowRegistration` 设置，而那是一个「谁都能进这台服务器」的决定，不该默认。
 */
function register(request: CoreRequest, context: AccountsHttpContext): Answer {
  const body = object(request);
  if (body.token === undefined) {
    return notImplemented("开放注册（需要 allowRegistration 设置）");
  }
  const token = text(body.token);
  const password = text(body.password);
  const registered = context.accounts.registerWithInvitation({
    invitationId: token.split(".")[0] ?? "",
    token,
    displayName: text(body.displayName),
    password,
  });
  const session = context.login({
    principalId: registered.principalId,
    password,
    deviceName:
      body.deviceName === undefined ? "Armadra" : text(body.deviceName),
  }) as Record<string, unknown>;
  return {
    status: 201,
    body: {
      ...session,
      invitation: {
        role: registered.role,
        groupId: registered.groupId,
        workspaceId: registered.workspaceId,
      },
    },
  };
}

function invitations(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  const accounts = context.accounts;
  if (segments.length === 1 && method === "GET") {
    return {
      status: 200,
      body: { invitations: accounts.listInvitations(subject(context)) },
    };
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    return {
      status: 201,
      body: accounts.issueInvitation(subject(context), {
        role: body.role,
        targetGroupId: optional(body.targetGroupId),
        targetWorkspaceId: optional(body.targetWorkspaceId),
        ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
      }),
    };
  }
  if (segments.length === 2 && method === "DELETE") {
    accounts.revokeInvitation(subject(context), segments[1] as string);
    return { status: 200, body: { revoked: true } };
  }
  if (segments.length === 3 && segments[2] === "accept" && method === "POST") {
    const body = object(request);
    return {
      status: 200,
      body: accounts.acceptInvitation(subject(context), {
        invitationId: segments[1] as string,
        token: text(body.token),
      }),
    };
  }
  return undefined;
}

function groups(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  const accounts = context.accounts;
  if (segments.length === 1 && method === "GET") {
    return {
      status: 200,
      body: { groups: accounts.listGroups(subject(context)) },
    };
  }
  if (segments.length === 1 && method === "POST") {
    return {
      status: 201,
      body: accounts.createGroup(subject(context), text(object(request).name)),
    };
  }
  const groupId = segments[1] ?? "";
  if (segments.length === 2 && method === "PATCH") {
    accounts.renameGroup(subject(context), groupId, text(object(request).name));
    return { status: 200, body: { groupId, renamed: true } };
  }
  if (segments.length === 2 && method === "DELETE") {
    accounts.deleteGroup(subject(context), groupId);
    return { status: 200, body: { groupId, deleted: true } };
  }
  if (segments.length === 4 && segments[2] === "members") {
    const principalId = segments[3] as string;
    if (method === "PUT") {
      const role = object(request).role;
      accounts.putGroupMember(
        subject(context),
        groupId,
        principalId,
        (role === undefined ? "member" : text(role)) as GroupRole,
      );
      return { status: 200, body: { groupId, principalId } };
    }
    if (method === "DELETE") {
      accounts.removeGroupMember(subject(context), groupId, principalId);
      return { status: 200, body: { groupId, principalId, removed: true } };
    }
  }
  return undefined;
}

function grants(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  if (segments.length !== 1) return undefined;
  const accounts = context.accounts;
  if (method === "GET") {
    const workspaceId = request.query.get("workspaceId") ?? "";
    return {
      status: 200,
      body: {
        workspaceId,
        grants: accounts.listGrants(subject(context), workspaceId),
        // 角色 → 权限的编译表，界面拿它画共享对话框里的那四个单选项。
        roles: SHARE_ROLES,
      },
    };
  }
  if (method === "PUT") {
    const body = object(request);
    return {
      status: 200,
      body: accounts.putGrant(subject(context), {
        workspaceId: text(body.workspaceId),
        subjectKind: text(body.subjectKind) as GrantSubjectKind,
        subjectId: text(body.subjectId),
        role: body.role,
      }),
    };
  }
  if (method === "DELETE") {
    const body = object(request);
    accounts.revokeGrant(subject(context), {
      workspaceId: text(body.workspaceId),
      subjectKind: text(body.subjectKind) as GrantSubjectKind,
      subjectId: text(body.subjectId),
    });
    return { status: 200, body: { revoked: true } };
  }
  return undefined;
}

function audit(
  method: string,
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  if (method !== "GET") return undefined;
  const limit = Number(request.query.get("limit") ?? 100);
  return {
    status: 200,
    body: {
      entries: context.accounts.readAudit(subject(context), {
        ...(request.query.get("principalId")
          ? { principalId: request.query.get("principalId") as string }
          : {}),
        ...(request.query.get("workspaceId")
          ? { workspaceId: request.query.get("workspaceId") as string }
          : {}),
        limit:
          Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100,
      }),
    },
  };
}

/** 调用方是谁。认证失败在这里抛，于是每条路由都不必自己写那个 401。 */
function subject(context: AccountsHttpContext): AuthorizationSubject {
  const principal = context.authenticate();
  return {
    principalId: principal.principalId,
    kind: principal.role === "member" ? "member" : "owner",
    scopes: principal.scopes,
  };
}

function object(request: CoreRequest): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = request.json();
  } catch {
    throw new IdentityError("invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IdentityError("invalid");
  }
  return parsed as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new IdentityError("invalid");
  return value;
}

function optional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value);
}
