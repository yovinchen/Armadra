import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { AccountsService } from "./accounts";
import { type AuthorizationSubject, Authorizer } from "./authorize";
import { IdentityError } from "./errors";
import { onAccessChanged } from "./gate";
import { scope } from "./scopes";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";

/**
 * 账号、组、授予、邀请与审计，跑在真库上。
 *
 * 这些用例回答的是设计 §2 与 §4 的三个「必须现在就成立」：
 *
 *   * 判定入口对 owner 恒真，对一个 viewer 只放行 viewer 那几条；
 *   * 邀请一次性、会过期；
 *   * 每一次授予变更都在 `audit_log` 里查得到。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) {
    try {
      close();
    } catch {
      // 已经关过了。
    }
  }
});

let clock = 1_800_000_000_000;

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "armadra-accounts-"));
  const opened = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  clock = 1_800_000_000_000;
  const store = new IdentityStore(opened.database);
  const service = new IdentityService(store, INSTANCE, () => clock);
  const accounts = new AccountsService({ store, clock: () => clock });
  const authorizer = new Authorizer(store);
  // owner 行由第一次配对产生，所以这里走一遍真链条：签票、换会话。
  const ticket = service.issueBootstrap({
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: "http://127.0.0.1:1420",
    deviceName: "本机桌面",
    scopes: [scope("identity:manage"), scope("identity:read")],
  });
  const paired = service.consumeBootstrap({
    ticket: ticket.ticket,
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: "http://127.0.0.1:1420",
  });
  const owner: AuthorizationSubject = {
    principalId: paired.principal.principalId,
    kind: "owner",
    scopes: paired.principal.scopes,
  };
  return {
    store,
    service,
    accounts,
    authorizer,
    owner,
    database: opened.database,
  };
}

describe("principal 与授予", () => {
  it("owner 行就是配对时那一个，列表里看得到", () => {
    const { accounts, owner } = harness();
    const list = accounts.listPrincipals(owner);
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe("owner");
    expect(list[0]?.principalId).toBe(owner.principalId);
    expect(list[0]?.hasPassword).toBe(false);
  });

  it("判定入口：owner 恒真，viewer 只放行 viewer 那几条", () => {
    const { accounts, authorizer, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    const viewer: AuthorizationSubject = {
      principalId: member.principalId,
      kind: "member",
      scopes: [],
    };
    // 授予之前，一个成员什么也做不了。
    expect(authorizer.permits(viewer, [scope("canvas:read", "w1")])).toBe(
      false,
    );
    accounts.putGrant(owner, {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "viewer",
    });
    expect(authorizer.permits(viewer, [scope("canvas:read", "w1")])).toBe(true);
    expect(authorizer.permits(viewer, [scope("canvas:write", "w1")])).toBe(
      false,
    );
    // 授予绑在一块画布上：另一块画布上什么也不成立。
    expect(authorizer.permits(viewer, [scope("canvas:read", "w2")])).toBe(
      false,
    );
    // owner 恒真，哪怕会话快照里根本没有这条权限。
    expect(
      authorizer.permits({ ...owner, scopes: [] }, [
        scope("canvas:write", "w1"),
      ]),
    ).toBe(true);
  });

  it("组授予按成员关系编译，退组之后立刻失效", () => {
    const { accounts, authorizer, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    const group = accounts.createGroup(owner, "后端组");
    accounts.putGroupMember(owner, group.groupId, member.principalId, "member");
    accounts.putGrant(owner, {
      workspaceId: "w1",
      subjectKind: "group",
      subjectId: group.groupId,
      role: "editor",
    });
    const subject: AuthorizationSubject = {
      principalId: member.principalId,
      kind: "member",
      scopes: [],
    };
    expect(authorizer.permits(subject, [scope("canvas:write", "w1")])).toBe(
      true,
    );
    accounts.removeGroupMember(owner, group.groupId, member.principalId);
    expect(authorizer.permits(subject, [scope("canvas:write", "w1")])).toBe(
      false,
    );
  });

  it("改角色是撤旧立新：一个主体只有一条有效授予", () => {
    const { accounts, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    accounts.putGrant(owner, {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "viewer",
    });
    accounts.putGrant(owner, {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "driver",
    });
    const grants = accounts.listGrants(owner, "w1");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.role).toBe("driver");
    expect(grants[0]?.permissions).toContain("terminal:drive");
    accounts.revokeGrant(owner, {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
    });
    expect(accounts.listGrants(owner, "w1")).toEqual([]);
  });
});

describe("邀请", () => {
  it("接受一次就用掉了，第二次是 401", () => {
    const { accounts, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    const other = accounts.createPrincipal(owner, { displayName: "另一位" });
    const invitation = accounts.issueInvitation(owner, {
      role: "editor",
      targetWorkspaceId: "w1",
    });
    const accepted = accounts.acceptInvitation(
      { principalId: member.principalId, kind: "member", scopes: [] },
      { invitationId: invitation.invitationId, token: invitation.token },
    );
    expect(accepted.role).toBe("editor");
    expect(accounts.listGrants(owner, "w1")).toHaveLength(1);
    expect(() =>
      accounts.acceptInvitation(
        { principalId: other.principalId, kind: "member", scopes: [] },
        { invitationId: invitation.invitationId, token: invitation.token },
      ),
    ).toThrow(IdentityError);
    // 第二个人什么也没拿到。
    expect(accounts.listGrants(owner, "w1")).toHaveLength(1);
  });

  it("过期的邀请接不了", () => {
    const { accounts, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    const invitation = accounts.issueInvitation(owner, {
      role: "viewer",
      targetWorkspaceId: "w1",
      ttlMs: 60_000,
    });
    clock += 60_001;
    expect(() =>
      accounts.acceptInvitation(
        { principalId: member.principalId, kind: "member", scopes: [] },
        { invitationId: invitation.invitationId, token: invitation.token },
      ),
    ).toThrow(IdentityError);
  });

  it("令牌不对和邀请不存在是同一个答案", () => {
    const { accounts, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    const invitation = accounts.issueInvitation(owner, {
      role: "viewer",
      targetGroupId: accounts.createGroup(owner, "组").groupId,
    });
    const wrong = `${invitation.invitationId}.${"a".repeat(43)}`;
    expect(() =>
      accounts.acceptInvitation(
        { principalId: member.principalId, kind: "member", scopes: [] },
        { invitationId: invitation.invitationId, token: wrong },
      ),
    ).toThrow(IdentityError);
  });

  it("接受一张指向组的邀请就是入组", () => {
    const { accounts, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    const group = accounts.createGroup(owner, "前端组");
    const invitation = accounts.issueInvitation(owner, {
      role: "viewer",
      targetGroupId: group.groupId,
    });
    accounts.acceptInvitation(
      { principalId: member.principalId, kind: "member", scopes: [] },
      { invitationId: invitation.invitationId, token: invitation.token },
    );
    const groups = accounts.listGroups(owner);
    expect(groups[0]?.members.map((value) => value.principalId)).toEqual([
      member.principalId,
    ]);
  });
});

describe("口令与登录", () => {
  it("设了口令就能登录，错口令是 401", () => {
    const { accounts, service, store, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    accounts.setPassword(owner, member.principalId, "correct horse battery");
    const session = service.loginWithPassword({
      principalId: member.principalId,
      password: "correct horse battery",
      hostId: store.hostId(),
      origin: "http://127.0.0.1:1420",
      deviceName: "同事的笔记本",
    });
    expect(session.principal.principalId).toBe(member.principalId);
    expect(session.principal.role).toBe("member");
    // 没有任何共享的成员登录之后仍然看得见自己的设备列表。
    expect(session.principal.scopes.map((value) => value.Permission)).toEqual([
      "identity:read",
    ]);
    expect(() =>
      service.loginWithPassword({
        principalId: member.principalId,
        password: "wrong password",
        hostId: store.hostId(),
        origin: "http://127.0.0.1:1420",
        deviceName: "同事的笔记本",
      }),
    ).toThrow(IdentityError);
  });

  it("登录只快照底线，共享得来的授权每次现编", () => {
    const { accounts, service, store, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    accounts.setPassword(owner, member.principalId, "correct horse battery");
    accounts.putGrant(owner, {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "editor",
    });
    const session = service.loginWithPassword({
      principalId: member.principalId,
      password: "correct horse battery",
      hostId: store.hostId(),
      origin: "http://127.0.0.1:1420",
      deviceName: "同事的笔记本",
    });
    // 进了快照，撤销一条共享就要等这个会话过期才生效。
    expect(session.principal.scopes.map((value) => value.Permission)).toEqual([
      "identity:read",
    ]);
    const permissions = accounts
      .effectiveGrantScopes(member.principalId)
      .map((value) => value.Permission);
    expect(permissions).toContain("canvas:write");
    expect(permissions).not.toContain("terminal:drive");
    // 会话认证走的是同一张表，成员的会话照样认得出来。
    const authenticated = service.authenticate({
      accessToken: session.accessToken,
      hostId: store.hostId(),
      origin: "http://127.0.0.1:1420",
    });
    expect(authenticated.role).toBe("member");
  });

  it("停用的账号登不上，已有会话在下一个请求上失效", () => {
    const { accounts, service, store, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    accounts.setPassword(owner, member.principalId, "correct horse battery");
    const session = service.loginWithPassword({
      principalId: member.principalId,
      password: "correct horse battery",
      hostId: store.hostId(),
      origin: "http://127.0.0.1:1420",
      deviceName: "同事的笔记本",
    });
    accounts.disablePrincipal(owner, member.principalId);
    expect(() =>
      service.authenticate({
        accessToken: session.accessToken,
        hostId: store.hostId(),
        origin: "http://127.0.0.1:1420",
      }),
    ).toThrow(IdentityError);
    expect(() =>
      service.loginWithPassword({
        principalId: member.principalId,
        password: "correct horse battery",
        hostId: store.hostId(),
        origin: "http://127.0.0.1:1420",
        deviceName: "同事的笔记本",
      }),
    ).toThrow(IdentityError);
  });
});

describe("审计", () => {
  it("登录、授予变更、设备撤销都查得到", () => {
    const { accounts, service, store, owner, database } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    accounts.setPassword(owner, member.principalId, "correct horse battery");
    service.loginWithPassword({
      principalId: member.principalId,
      password: "correct horse battery",
      hostId: store.hostId(),
      origin: "http://127.0.0.1:1420",
      deviceName: "同事的笔记本",
    });
    accounts.putGrant(owner, {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "viewer",
    });
    accounts.revokeGrant(owner, {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
    });
    const actions = accounts
      .readAudit(owner, { limit: 50 })
      .map((entry) => entry.action);
    expect(actions).toContain("identity.login");
    expect(actions).toContain("share.grant.set");
    expect(actions).toContain("share.grant.revoke");
    expect(actions).toContain("identity.credential.set");
    // 审计行确实落在库里，而不是只活在服务的返回值里。
    const total = database
      .prepare("SELECT count(*) AS total FROM audit_log")
      .get() as { total: number };
    expect(Number(total.total)).toBe(actions.length);
  });

  it("按工作空间过滤只答那一块画布的记录", () => {
    const { accounts, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    accounts.putGrant(owner, {
      workspaceId: "w1",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "viewer",
    });
    accounts.putGrant(owner, {
      workspaceId: "w2",
      subjectKind: "principal",
      subjectId: member.principalId,
      role: "viewer",
    });
    const entries = accounts.readAudit(owner, { workspaceId: "w1" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.workspaceId).toBe("w1");
    expect(entries[0]?.detail).toMatchObject({ role: "viewer" });
  });
});

describe("R8：注册、组共享与收权通知", () => {
  it("拿着邀请注册：建成员、设口令、拿到授予，一张邀请只用一次", () => {
    const { accounts, service, store, owner } = harness();
    const issued = accounts.issueInvitation(owner, {
      role: "editor",
      targetWorkspaceId: "w1",
    });
    const registered = accounts.registerWithInvitation({
      invitationId: issued.invitationId,
      token: issued.token,
      displayName: "新同事",
      password: "correct horse battery",
    });
    expect(registered).toMatchObject({ role: "editor", workspaceId: "w1" });
    const member = accounts
      .listPrincipals(owner)
      .find((row) => row.principalId === registered.principalId);
    expect(member).toMatchObject({ kind: "member", hasPassword: true });
    expect(
      accounts
        .effectiveGrantScopes(registered.principalId)
        .map((value) => `${value.Permission}@${value.WorkspaceID}`),
    ).toContain("canvas:write@w1");
    // 口令真的能登录。
    expect(
      service.loginWithPassword({
        principalId: registered.principalId,
        password: "correct horse battery",
        hostId: store.hostId(),
        origin: "http://127.0.0.1:1420",
        deviceName: "新同事的电脑",
      }).principal.role,
    ).toBe("member");
    expect(() =>
      accounts.registerWithInvitation({
        invitationId: issued.invitationId,
        token: issued.token,
        displayName: "第二个人",
        password: "correct horse battery",
      }),
    ).toThrow(IdentityError);
    // 失败的那次没有留下空账号。
    expect(accounts.listPrincipals(owner)).toHaveLength(2);
  });

  it("作废的邀请兑换不了", () => {
    const { accounts, owner } = harness();
    const issued = accounts.issueInvitation(owner, {
      role: "viewer",
      targetWorkspaceId: "w1",
    });
    accounts.revokeInvitation(owner, issued.invitationId);
    expect(() =>
      accounts.registerWithInvitation({
        invitationId: issued.invitationId,
        token: issued.token,
        displayName: "迟到",
        password: "correct horse battery",
      }),
    ).toThrow(IdentityError);
  });

  it("组共享：入组就有，移出组立刻没有", () => {
    const { accounts, owner } = harness();
    const member = accounts.createPrincipal(owner, { displayName: "同事" });
    const group = accounts.createGroup(owner, "前端组");
    accounts.putGrant(owner, {
      workspaceId: "w1",
      subjectKind: "group",
      subjectId: group.groupId,
      role: "operator",
    });
    const has = () =>
      accounts
        .effectiveGrantScopes(member.principalId)
        .some((value) => value.Permission === "terminal:create");
    expect(has()).toBe(false);
    accounts.putGroupMember(owner, group.groupId, member.principalId, "member");
    expect(has()).toBe(true);
    accounts.removeGroupMember(owner, group.groupId, member.principalId);
    expect(has()).toBe(false);
  });

  it("每次收权都通知长连接复核；owner 不能被停用", () => {
    const { accounts, owner } = harness();
    let notified = 0;
    const stop = onAccessChanged(() => {
      notified += 1;
    });
    try {
      const member = accounts.createPrincipal(owner, { displayName: "同事" });
      accounts.putGrant(owner, {
        workspaceId: "w1",
        subjectKind: "principal",
        subjectId: member.principalId,
        role: "viewer",
      });
      accounts.revokeGrant(owner, {
        workspaceId: "w1",
        subjectKind: "principal",
        subjectId: member.principalId,
      });
      accounts.disablePrincipal(owner, member.principalId);
      expect(notified).toBe(3);
      expect(() =>
        accounts.disablePrincipal(owner, owner.principalId),
      ).toThrow(IdentityError);
    } finally {
      stop();
    }
  });
});
