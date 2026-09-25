import { z } from "zod";

import {
  ensureCsrf,
  forgetCsrf,
  IdentityRequestError,
  IdentityTransportError,
  identitySessionSchema,
  rememberCsrf,
  type IdentitySession,
} from "./identity";
import { RUNTIME_URL } from "./request";

/**
 * 账号、组、邀请与共享的客户端 —— core 的 `/api/identity/*` 管理面
 * （`docs/design/server-accounts-and-sharing.md` §3，契约
 * `docs/contracts/core-json-api.md` §10）。
 *
 * 只在服务器壳托管的页面上用：那里的会话是 HttpOnly Cookie + 双提交 CSRF，
 * 所以这里不碰 Bearer，写请求带 `X-Armadra-CSRF`。桌面单机只有一个 owner，
 * 没有可管理的人，这一面不出现。
 */

const PREFIX = "/api/identity/";

export const SHARE_ROLES = ["viewer", "editor", "operator", "driver"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

const shareRoleSchema = z.enum(SHARE_ROLES);

const principalSchema = z.object({
  principalId: z.string(),
  kind: z.enum(["owner", "member", "service"]),
  displayName: z.string().default(""),
  createdAtMs: z.number().default(0),
  disabledAtMs: z.number().default(0),
  hasPassword: z.boolean().default(false),
});
export type Principal = z.infer<typeof principalSchema>;

const groupSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string().default(""),
  createdAtMs: z.number().default(0),
  members: z
    .array(
      z.object({
        principalId: z.string(),
        role: z.enum(["admin", "member"]),
        joinedAtMs: z.number().default(0),
      }),
    )
    .default([]),
});
export type Group = z.infer<typeof groupSchema>;
export type GroupRole = Group["members"][number]["role"];

const invitationSchema = z.object({
  invitationId: z.string(),
  issuedBy: z.string().default(""),
  role: shareRoleSchema,
  targetGroupId: z.string().default(""),
  targetWorkspaceId: z.string().default(""),
  createdAtMs: z.number().default(0),
  expiresAtMs: z.number().default(0),
  consumedBy: z.string().default(""),
  consumedAtMs: z.number().default(0),
});
export type Invitation = z.infer<typeof invitationSchema>;

const issuedInvitationSchema = z.object({
  invitationId: z.string(),
  token: z.string(),
  expiresAtMs: z.number(),
  role: shareRoleSchema,
  targetGroupId: z.string().default(""),
  targetWorkspaceId: z.string().default(""),
});
export type IssuedInvitation = z.infer<typeof issuedInvitationSchema>;

const grantSchema = z.object({
  grantId: z.string(),
  subjectKind: z.enum(["principal", "group"]),
  subjectId: z.string(),
  workspaceId: z.string(),
  role: shareRoleSchema,
  grantedBy: z.string().default(""),
  createdAtMs: z.number().default(0),
  permissions: z.array(z.string()).default([]),
});
export type Grant = z.infer<typeof grantSchema>;

const okSchema = z.object({}).passthrough();

async function call<T>(
  action: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    const csrf = await ensureCsrf();
    if (csrf) headers["X-Armadra-CSRF"] = csrf;
  }
  let response: Response;
  try {
    response = await fetch(`${RUNTIME_URL}${PREFIX}${action}`, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    });
  } catch (cause) {
    throw new IdentityTransportError(cause);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // 403 可能是 CSRF 过期：作废本地这枚，下一次写请求重新取。
    if (response.status === 403) forgetCsrf();
    const body = (payload ?? {}) as { code?: unknown; message?: unknown };
    throw new IdentityRequestError(
      response.status,
      typeof body.code === "string" ? body.code : "UNKNOWN",
      typeof body.message === "string" ? body.message : "",
    );
  }
  return schema.parse(payload);
}

/* --------------------------------- 成员 ---------------------------------- */

export async function listPrincipals(): Promise<Principal[]> {
  return (
    await call("principals", z.object({ principals: z.array(principalSchema) }))
  ).principals;
}

/** 管理员直接建一个成员并给他设初始口令。 */
export async function createMember(
  displayName: string,
  password: string,
): Promise<Principal> {
  const created = await call("principals", principalSchema, {
    method: "POST",
    body: { displayName },
  });
  await setPassword(created.principalId, password);
  return created;
}

export async function disablePrincipal(principalId: string): Promise<void> {
  await call(`principals/${principalId}/disable`, okSchema, {
    method: "POST",
  });
}

export async function setPassword(
  principalId: string,
  password: string,
): Promise<void> {
  await call("credentials", okSchema, {
    method: "POST",
    body: { kind: "password", principalId, password },
  });
}

/* ---------------------------------- 组 ----------------------------------- */

export async function listGroups(): Promise<Group[]> {
  return (await call("groups", z.object({ groups: z.array(groupSchema) })))
    .groups;
}

export async function createGroup(name: string): Promise<void> {
  await call("groups", okSchema, { method: "POST", body: { name } });
}

export async function deleteGroup(groupId: string): Promise<void> {
  await call(`groups/${groupId}`, okSchema, { method: "DELETE" });
}

export async function putGroupMember(
  groupId: string,
  principalId: string,
  role: GroupRole,
): Promise<void> {
  await call(`groups/${groupId}/members/${principalId}`, okSchema, {
    method: "PUT",
    body: { role },
  });
}

export async function removeGroupMember(
  groupId: string,
  principalId: string,
): Promise<void> {
  await call(`groups/${groupId}/members/${principalId}`, okSchema, {
    method: "DELETE",
  });
}

/* --------------------------------- 邀请 ---------------------------------- */

export async function listInvitations(): Promise<Invitation[]> {
  return (
    await call(
      "invitations",
      z.object({ invitations: z.array(invitationSchema) }),
    )
  ).invitations;
}

export function issueInvitation(input: {
  role: ShareRole;
  targetWorkspaceId?: string;
  targetGroupId?: string;
}): Promise<IssuedInvitation> {
  return call("invitations", issuedInvitationSchema, {
    method: "POST",
    body: input,
  });
}

export async function revokeInvitation(invitationId: string): Promise<void> {
  await call(`invitations/${invitationId}`, okSchema, { method: "DELETE" });
}

/**
 * 邀请链接：页面根上的 `#invite=<令牌>`，和服务器壳 `invitationUrl` 同一个
 * 拼法。令牌只在片段里，不上请求行。
 */
export function invitationLink(token: string, origin = location.origin) {
  return `${origin}/#invite=${token}`;
}

/** 地址栏里有没有一张待兑换的邀请（不取走）。 */
export function hasInvitationFragment(): boolean {
  return /^#invite=[A-Za-z0-9._~-]+$/.test(globalThis.location?.hash ?? "");
}

/** 取走地址栏里的邀请令牌并把片段抹掉，免得它留在分享出去的链接里。 */
export function takeInvitationToken(): string {
  const location = globalThis.location;
  const found = /^#invite=([A-Za-z0-9._~-]+)$/.exec(location?.hash ?? "");
  if (!found) return "";
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  } catch {
    /* 抹不掉地址栏不该让兑换失败。 */
  }
  return found[1] as string;
}

/** 拿着邀请注册：建账号、兑换邀请、登录，一次请求。 */
export async function redeemInvitation(input: {
  token: string;
  displayName: string;
  password: string;
}): Promise<IdentitySession> {
  const session = await call("register", identitySessionSchema, {
    method: "POST",
    body: { ...input, deviceName: deviceName() },
  });
  rememberCsrf(session.csrfToken ?? "");
  return session;
}

/** 口令登录。账号标识是注册之后页面上给出的那一串。 */
export async function loginWithPassword(
  principalId: string,
  password: string,
): Promise<IdentitySession> {
  const session = await call("login", identitySessionSchema, {
    method: "POST",
    body: { principalId, password, deviceName: deviceName() },
  });
  rememberCsrf(session.csrfToken ?? "");
  return session;
}

function deviceName(): string {
  const agent = globalThis.navigator?.userAgent ?? "";
  const browser = /Firefox\//.test(agent)
    ? "Firefox"
    : /Edg\//.test(agent)
      ? "Edge"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  return `Armadra · ${browser}`;
}

/* --------------------------------- 共享 ---------------------------------- */

export async function listGrants(workspaceId: string): Promise<Grant[]> {
  return (
    await call(
      `grants?${new URLSearchParams({ workspaceId }).toString()}`,
      z.object({ grants: z.array(grantSchema) }),
    )
  ).grants;
}

export async function putGrant(input: {
  workspaceId: string;
  subjectKind: Grant["subjectKind"];
  subjectId: string;
  role: ShareRole;
}): Promise<void> {
  await call("grants", okSchema, { method: "PUT", body: input });
}

export async function revokeGrant(input: {
  workspaceId: string;
  subjectKind: Grant["subjectKind"];
  subjectId: string;
}): Promise<void> {
  await call("grants", okSchema, { method: "DELETE", body: input });
}
