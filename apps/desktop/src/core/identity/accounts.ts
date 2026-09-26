import type {
  AccountsTx,
  GrantSubjectKind,
  GroupRole,
  InvitationRow,
  PrincipalKind,
} from "./accounts-store";
import { type AuthorizationSubject, compileGrants } from "./authorize";
import { IdentityError } from "./errors";
import { accessChanged } from "./gate";
import { derivePassword, validPassword } from "./passwords";
import { type ShareRole, parseShareRole, rolePermissions } from "./roles";
import { type Scope, scope } from "./scopes";
import type { IdentityStore } from "./store";
import {
  ID_PATTERN,
  digest,
  matches,
  newId,
  newSecret,
  parseToken,
  validIdentifier,
  validName,
} from "./tokens";

/**
 * 账号、凭据、邀请、组与授予的域服务。
 *
 * 规格是 `docs/design/server-accounts-and-sharing.md` §2 与 §3。这里只做**数据
 * 与判定**：传输、TLS、Cookie、CSRF 是壳的事（服务器壳是并行的另一条线），而
 * 会话仍然由 `service.ts` 那一张 `identity_sessions` 管——登录成功之后走的是同
 * 一条会话路径，唯一的区别是 principal 不再固定为 owner。
 *
 * 每个方法第一件事都是判定，判定走同一个入口（`authorize.ts`），对 owner 恒真。
 * 第二件事是写审计：设计 §4.5 点名的五处里，授予变更与登录在这条链上。
 */

export interface AccountsOptions {
  readonly store: IdentityStore;
  readonly clock?: () => number;
}

export interface PrincipalView {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly createdAtMs: number;
  readonly disabledAtMs: number;
  /** 有没有设过口令。口令本身与哈希都不出这个域。 */
  readonly hasPassword: boolean;
}

export interface GrantView {
  readonly grantId: string;
  readonly subjectKind: GrantSubjectKind;
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly role: ShareRole;
  readonly grantedBy: string;
  readonly createdAtMs: number;
  /** 这条授予编译出来的权限名，界面直接显示，不必自己再编译一遍。 */
  readonly permissions: readonly string[];
}

/** 邀请只在签发那一次返回明文；库里只有哈希。 */
export interface IssuedInvitation {
  readonly invitationId: string;
  readonly token: string;
  readonly expiresAtMs: number;
  readonly role: ShareRole;
  readonly targetGroupId: string;
  readonly targetWorkspaceId: string;
}

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AccountsService {
  private readonly clock: () => number;

  constructor(private readonly options: AccountsOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value <= 0)
      throw new IdentityError("invalid");
    return Math.trunc(value);
  }

  /* ------------------------------- principals ----------------------------- */

  listPrincipals(actor: AuthorizationSubject): PrincipalView[] {
    return this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [scope("identity:read")]);
      return tx.accounts.principals().map((row) => this.view(tx.accounts, row));
    });
  }

  createPrincipal(
    actor: AuthorizationSubject,
    input: { displayName: string; kind?: PrincipalKind },
  ): PrincipalView {
    const kind = input.kind ?? "member";
    if (!validName(input.displayName) || kind === "owner") {
      // owner 只有一个，而且是配对时产生的。想「再建一个 owner」的调用方要的
      // 其实是移交，那不是这一批的事。
      throw new IdentityError("invalid");
    }
    return this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [scope("identity:manage")]);
      const now = this.now();
      const row = {
        principalId: newId(),
        kind,
        displayName: input.displayName,
        createdAtMs: now,
        disabledAtMs: 0,
      };
      tx.accounts.createPrincipal(row);
      this.note(tx.accounts, actor, now, {
        action: "identity.principal.create",
        target: row.principalId,
        detail: { kind },
      });
      return this.view(tx.accounts, row);
    });
  }

  disablePrincipal(actor: AuthorizationSubject, principalId: string): void {
    if (!ID_PATTERN.test(principalId)) throw new IdentityError("invalid");
    this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [scope("identity:manage")]);
      const row = tx.accounts.principal(principalId);
      if (row === undefined) throw new IdentityError("notFound");
      // 停用 owner 等于把这台服务器锁在门外：没有人再能管理它。
      if (row.kind === "owner") throw new IdentityError("invalid");
      const now = this.now();
      tx.accounts.disablePrincipal(principalId, now);
      this.note(tx.accounts, actor, now, {
        action: "identity.principal.disable",
        target: principalId,
      });
    });
    accessChanged();
  }

  /* ------------------------------ credentials ----------------------------- */

  listCredentials(
    actor: AuthorizationSubject,
    principalId: string,
  ): {
    credentialId: string;
    principalId: string;
    kind: string;
    provider: string;
    createdAtMs: number;
    revokedAtMs: number;
  }[] {
    if (!ID_PATTERN.test(principalId)) throw new IdentityError("invalid");
    return this.options.store.transaction((tx) => {
      this.requireSelfOrManage(tx.accounts, actor, principalId);
      // 哈希、盐、KDF 参数、公钥都不出这个域：它们只在校验时被读，而一份能被
      // 列出来的哈希就是一份可以离线爆破的哈希。
      return tx.accounts.credentialsOf(principalId).map((row) => ({
        credentialId: row.credentialId,
        principalId: row.principalId,
        kind: row.kind,
        provider: row.provider,
        createdAtMs: row.createdAtMs,
        revokedAtMs: row.revokedAtMs,
      }));
    });
  }

  /** 设置（或替换）口令。旧的那份撤销而不是删除，撤销记录是审计的一部分。 */
  setPassword(
    actor: AuthorizationSubject,
    principalId: string,
    password: string,
  ): { credentialId: string } {
    if (!ID_PATTERN.test(principalId) || !validPassword(password)) {
      throw new IdentityError("invalid");
    }
    const derived = derivePassword(password);
    return this.options.store.transaction((tx) => {
      this.requireSelfOrManage(tx.accounts, actor, principalId);
      const now = this.now();
      if (tx.accounts.principal(principalId) === undefined) {
        throw new IdentityError("notFound");
      }
      const existing = tx.accounts.livePassword(principalId);
      if (existing !== undefined) {
        tx.accounts.revokeCredential(existing.credentialId, now);
      }
      const credentialId = newId();
      tx.accounts.createCredential({
        credentialId,
        principalId,
        kind: "password",
        provider: "",
        subject: "",
        secretHash: derived.hash,
        salt: derived.salt,
        kdf: derived.parameters.kdf,
        cost: derived.parameters.cost,
        block: derived.parameters.block,
        parallel: derived.parameters.parallel,
        length: derived.parameters.length,
        createdAtMs: now,
        revokedAtMs: 0,
      });
      this.note(tx.accounts, actor, now, {
        action: "identity.credential.set",
        target: credentialId,
        detail: { kind: "password", principalId },
      });
      return { credentialId };
    });
  }

  revokeCredential(actor: AuthorizationSubject, credentialId: string): void {
    if (!ID_PATTERN.test(credentialId)) throw new IdentityError("invalid");
    this.options.store.transaction((tx) => {
      const row = tx.accounts.credential(credentialId);
      if (row === undefined) throw new IdentityError("notFound");
      this.requireSelfOrManage(tx.accounts, actor, row.principalId);
      const now = this.now();
      tx.accounts.revokeCredential(credentialId, now);
      this.note(tx.accounts, actor, now, {
        action: "identity.credential.revoke",
        target: credentialId,
      });
    });
  }

  /* ------------------------------ invitations ----------------------------- */

  issueInvitation(
    actor: AuthorizationSubject,
    input: {
      role: unknown;
      targetGroupId?: string;
      targetWorkspaceId?: string;
      ttlMs?: number;
    },
  ): IssuedInvitation {
    const role = parseShareRole(input.role);
    const targetGroupId = input.targetGroupId ?? "";
    const targetWorkspaceId = input.targetWorkspaceId ?? "";
    if (
      (targetGroupId !== "" && !ID_PATTERN.test(targetGroupId)) ||
      (targetWorkspaceId !== "" && !validIdentifier(targetWorkspaceId)) ||
      (targetGroupId === "" && targetWorkspaceId === "")
    ) {
      // 一张既不指向组也不指向工作空间的邀请接受了什么也不会发生。
      throw new IdentityError("invalid");
    }
    const invitationId = newId();
    const token = `${invitationId}.${newSecret()}`;
    return this.options.store.transaction((tx) => {
      this.requireInvitationRights(
        tx.accounts,
        actor,
        targetGroupId,
        targetWorkspaceId,
      );
      const now = this.now();
      if (
        targetGroupId !== "" &&
        tx.accounts.group(targetGroupId) === undefined
      ) {
        throw new IdentityError("notFound");
      }
      const expiresAtMs = now + (input.ttlMs ?? INVITATION_TTL_MS);
      tx.accounts.createInvitation({
        invitationId,
        issuedBy: actor.principalId,
        targetGroupId,
        targetWorkspaceId,
        role,
        tokenHash: digest("bootstrap", token),
        createdAtMs: now,
        expiresAtMs,
        consumedBy: "",
        consumedAtMs: 0,
      });
      this.note(tx.accounts, actor, now, {
        action: "identity.invitation.issue",
        target: invitationId,
        workspaceId: targetWorkspaceId,
        detail: { role },
      });
      return {
        invitationId,
        token,
        expiresAtMs,
        role,
        targetGroupId,
        targetWorkspaceId,
      };
    });
  }

  listInvitations(actor: AuthorizationSubject): {
    invitationId: string;
    issuedBy: string;
    role: ShareRole;
    targetGroupId: string;
    targetWorkspaceId: string;
    createdAtMs: number;
    expiresAtMs: number;
    consumedBy: string;
    consumedAtMs: number;
  }[] {
    return this.options.store.transaction((tx) => {
      // 管理员看全部；组管理员只看指向自己所管的组、且不带工作空间的那些——
      // 带工作空间的邀请是共享，那是 `workspace:share` 的事，组管理员没有。
      const everything = this.manages(tx.accounts, actor);
      const administered = everything
        ? new Set<string>()
        : this.administeredGroups(tx.accounts, actor);
      if (!everything && administered.size === 0) {
        throw new IdentityError("permission");
      }
      return tx.accounts
        .invitations()
        .filter(
          (row) =>
            everything ||
            (row.targetWorkspaceId === "" &&
              administered.has(row.targetGroupId)),
        )
        .map((row) => ({
          invitationId: row.invitationId,
          issuedBy: row.issuedBy,
          role: row.role,
          targetGroupId: row.targetGroupId,
          targetWorkspaceId: row.targetWorkspaceId,
          createdAtMs: row.createdAtMs,
          expiresAtMs: row.expiresAtMs,
          consumedBy: row.consumedBy,
          consumedAtMs: row.consumedAtMs,
        }));
    });
  }

  /**
   * 接受一张邀请：入组、或拿到一条工作空间授予，两者都有就都做。
   *
   * 一次性与过期都在同一笔事务里判：`consumeInvitation` 的 `consumed_at_ms = 0`
   * 条件让第二次接受改不动任何行，于是整笔回滚——第二个人什么也拿不到，哪怕
   * 两次接受是同时发生的。
   */
  acceptInvitation(
    actor: AuthorizationSubject,
    input: { invitationId: string; token: string },
  ): { role: ShareRole; groupId: string; workspaceId: string } {
    if (!ID_PATTERN.test(actor.principalId)) {
      throw new IdentityError("unauthenticated");
    }
    const accepted = this.options.store.transaction((tx) => {
      const now = this.now();
      const row = this.redeemable(tx.accounts, input, now);
      if (tx.accounts.principal(actor.principalId) === undefined) {
        throw new IdentityError("unauthenticated");
      }
      return this.redeem(tx.accounts, actor, row, now);
    });
    accessChanged();
    return accepted;
  }

  /**
   * 拿着邀请注册：建一个成员、设口令、兑换邀请，一笔事务。
   *
   * 设计 §3 的「注册仅当开放注册或持邀请」里持邀请的那一半。一个新来的人手里
   * 只有邀请链接，还没有账号可以登录，所以「先登录再接受」这条路对他不存在；
   * 三步放在同一笔事务里，是为了不留下一个没兑换到任何东西的空账号，也不让同
   * 一张邀请被两个同时注册的人各用一次。会话由调用方随后照口令登录那条路发。
   */
  registerWithInvitation(input: {
    invitationId: string;
    token: string;
    displayName: string;
    password: string;
  }): {
    principalId: string;
    role: ShareRole;
    groupId: string;
    workspaceId: string;
  } {
    if (!validName(input.displayName) || !validPassword(input.password)) {
      throw new IdentityError("invalid");
    }
    const derived = derivePassword(input.password);
    const registered = this.options.store.transaction((tx) => {
      const now = this.now();
      const row = this.redeemable(tx.accounts, input, now);
      const principalId = newId();
      tx.accounts.createPrincipal({
        principalId,
        kind: "member",
        displayName: input.displayName,
        createdAtMs: now,
        disabledAtMs: 0,
      });
      tx.accounts.createCredential({
        credentialId: newId(),
        principalId,
        kind: "password",
        provider: "",
        subject: "",
        secretHash: derived.hash,
        salt: derived.salt,
        kdf: derived.parameters.kdf,
        cost: derived.parameters.cost,
        block: derived.parameters.block,
        parallel: derived.parameters.parallel,
        length: derived.parameters.length,
        createdAtMs: now,
        revokedAtMs: 0,
      });
      const actor: AuthorizationSubject = {
        principalId,
        kind: "member",
        scopes: [],
      };
      this.note(tx.accounts, actor, now, {
        action: "identity.principal.register",
        target: principalId,
        detail: { invitationId: input.invitationId },
      });
      return { principalId, ...this.redeem(tx.accounts, actor, row, now) };
    });
    accessChanged();
    return registered;
  }

  /** 作废一张还没用掉的邀请。库里记成「被空主体用掉」，一次性的那道闸照旧。 */
  revokeInvitation(actor: AuthorizationSubject, invitationId: string): void {
    if (!ID_PATTERN.test(invitationId)) throw new IdentityError("invalid");
    this.options.store.transaction((tx) => {
      const row = tx.accounts.invitation(invitationId);
      if (row === undefined) throw new IdentityError("notFound");
      this.requireInvitationRights(
        tx.accounts,
        actor,
        row.targetGroupId,
        row.targetWorkspaceId,
      );
      if (row.consumedAtMs !== 0) return;
      const now = this.now();
      tx.accounts.consumeInvitation(invitationId, "", now);
      this.note(tx.accounts, actor, now, {
        action: "identity.invitation.revoke",
        target: invitationId,
        workspaceId: row.targetWorkspaceId,
      });
    });
  }

  /**
   * 这张邀请现在还能不能兑换。
   *
   * 不存在、用过、过期、令牌不对：同一个 401，不泄露是哪一种。
   */
  private redeemable(
    accounts: AccountsTx,
    input: { invitationId: string; token: string },
    now: number,
  ): InvitationRow {
    const parsed = parseToken(input.token);
    if (!ID_PATTERN.test(input.invitationId) || parsed !== input.invitationId) {
      throw new IdentityError("unauthenticated");
    }
    const row = accounts.invitation(input.invitationId);
    if (
      row === undefined ||
      row.consumedAtMs !== 0 ||
      now >= row.expiresAtMs ||
      !matches("bootstrap", input.token, row.tokenHash)
    ) {
      throw new IdentityError("unauthenticated");
    }
    return row;
  }

  /**
   * 兑换：入组、或拿到一条工作空间授予，两者都有就都做。
   *
   * 一次性与过期都在同一笔事务里判：`consumeInvitation` 的 `consumed_at_ms = 0`
   * 条件让第二次接受改不动任何行，于是整笔回滚——第二个人什么也拿不到，哪怕
   * 两次接受是同时发生的。
   */
  private redeem(
    accounts: AccountsTx,
    actor: AuthorizationSubject,
    row: InvitationRow,
    now: number,
  ): { role: ShareRole; groupId: string; workspaceId: string } {
    if (row.targetGroupId !== "") {
      accounts.putGroupMember({
        groupId: row.targetGroupId,
        principalId: actor.principalId,
        role: "member",
        joinedAtMs: now,
      });
    }
    if (row.targetWorkspaceId !== "") {
      this.put(accounts, {
        subjectKind: "principal",
        subjectId: actor.principalId,
        workspaceId: row.targetWorkspaceId,
        role: row.role,
        grantedBy: row.issuedBy,
        nowMs: now,
      });
    }
    accounts.consumeInvitation(row.invitationId, actor.principalId, now);
    this.note(accounts, actor, now, {
      action: "identity.invitation.accept",
      target: row.invitationId,
      workspaceId: row.targetWorkspaceId,
      detail: { role: row.role },
    });
    return {
      role: row.role,
      groupId: row.targetGroupId,
      workspaceId: row.targetWorkspaceId,
    };
  }

  /* --------------------------------- groups ------------------------------- */

  listGroups(actor: AuthorizationSubject): {
    groupId: string;
    name: string;
    ownerPrincipalId: string;
    createdAtMs: number;
    members: { principalId: string; role: GroupRole; joinedAtMs: number }[];
  }[] {
    return this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [scope("identity:read")]);
      return tx.accounts.groups().map((row) => ({
        ...row,
        members: tx.accounts.groupMembers(row.groupId).map((member) => ({
          principalId: member.principalId,
          role: member.role,
          joinedAtMs: member.joinedAtMs,
        })),
      }));
    });
  }

  createGroup(
    actor: AuthorizationSubject,
    name: string,
  ): { groupId: string; name: string; createdAtMs: number } {
    if (!validName(name)) throw new IdentityError("invalid");
    return this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [scope("identity:manage")]);
      const now = this.now();
      const owner = tx.accounts.owner();
      const groupId = newId();
      tx.accounts.createGroup({
        groupId,
        name,
        // 匿名的本机 owner（`principalId` 为空）建组时，组挂在 owner 行上：
        // 组必须有一个存在的主人，外键说的就是这件事。
        ownerPrincipalId:
          actor.principalId !== ""
            ? actor.principalId
            : (owner?.principalId ?? ""),
        createdAtMs: now,
      });
      this.note(tx.accounts, actor, now, {
        action: "identity.group.create",
        target: groupId,
        detail: { name },
      });
      return { groupId, name, createdAtMs: now };
    });
  }

  renameGroup(
    actor: AuthorizationSubject,
    groupId: string,
    name: string,
  ): void {
    if (!ID_PATTERN.test(groupId) || !validName(name)) {
      throw new IdentityError("invalid");
    }
    this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [scope("identity:manage")]);
      tx.accounts.renameGroup(groupId, name);
      this.note(tx.accounts, actor, this.now(), {
        action: "identity.group.rename",
        target: groupId,
        detail: { name },
      });
    });
  }

  deleteGroup(actor: AuthorizationSubject, groupId: string): void {
    if (!ID_PATTERN.test(groupId)) throw new IdentityError("invalid");
    this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [scope("identity:manage")]);
      const now = this.now();
      tx.accounts.deleteGroup(groupId, now);
      this.note(tx.accounts, actor, now, {
        action: "identity.group.delete",
        target: groupId,
      });
    });
    accessChanged();
  }

  putGroupMember(
    actor: AuthorizationSubject,
    groupId: string,
    principalId: string,
    role: GroupRole,
  ): void {
    if (
      !ID_PATTERN.test(groupId) ||
      !ID_PATTERN.test(principalId) ||
      (role !== "admin" && role !== "member")
    ) {
      throw new IdentityError("invalid");
    }
    this.options.store.transaction((tx) => {
      this.requireGroupAdmin(tx.accounts, actor, groupId);
      const target = tx.accounts.principal(principalId);
      if (tx.accounts.group(groupId) === undefined || target === undefined) {
        throw new IdentityError("notFound");
      }
      // 组管理员管的是组里的「人」，不是服务器的主人：把 owner 拉进组、改它的
      // 组内角色都不改变 owner 的任何授权，却会让组表显示一个组管理员管着 owner。
      if (target.kind === "owner" && !this.manages(tx.accounts, actor)) {
        throw new IdentityError("permission");
      }
      const now = this.now();
      tx.accounts.putGroupMember({
        groupId,
        principalId,
        role,
        joinedAtMs: now,
      });
      this.note(tx.accounts, actor, now, {
        action: "identity.group.member.put",
        target: `${groupId}/${principalId}`,
        detail: { role },
      });
    });
    accessChanged();
  }

  removeGroupMember(
    actor: AuthorizationSubject,
    groupId: string,
    principalId: string,
  ): void {
    if (!ID_PATTERN.test(groupId) || !ID_PATTERN.test(principalId)) {
      throw new IdentityError("invalid");
    }
    this.options.store.transaction((tx) => {
      this.requireGroupAdmin(tx.accounts, actor, groupId);
      if (
        tx.accounts.principal(principalId)?.kind === "owner" &&
        !this.manages(tx.accounts, actor)
      ) {
        throw new IdentityError("permission");
      }
      tx.accounts.removeGroupMember(groupId, principalId);
      this.note(tx.accounts, actor, this.now(), {
        action: "identity.group.member.remove",
        target: `${groupId}/${principalId}`,
      });
    });
    accessChanged();
  }

  /* --------------------------------- grants ------------------------------- */

  listGrants(actor: AuthorizationSubject, workspaceId: string): GrantView[] {
    if (!validIdentifier(workspaceId) || workspaceId === "") {
      throw new IdentityError("invalid");
    }
    return this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [scope("workspace:share", workspaceId)]);
      return tx.accounts.workspaceGrants(workspaceId).map((row) => ({
        grantId: row.grantId,
        subjectKind: row.subjectKind,
        subjectId: row.subjectId,
        workspaceId: row.workspaceId,
        role: row.role,
        grantedBy: row.grantedBy,
        createdAtMs: row.createdAtMs,
        permissions: rolePermissions(row.role),
      }));
    });
  }

  /** 授予或改角色。改角色 = 撤旧立新，所以一个主体永远只有一条有效授予。 */
  putGrant(
    actor: AuthorizationSubject,
    input: {
      workspaceId: string;
      subjectKind: GrantSubjectKind;
      subjectId: string;
      role: unknown;
    },
  ): GrantView {
    const role = parseShareRole(input.role);
    if (
      !validIdentifier(input.workspaceId) ||
      input.workspaceId === "" ||
      !ID_PATTERN.test(input.subjectId) ||
      (input.subjectKind !== "principal" && input.subjectKind !== "group")
    ) {
      throw new IdentityError("invalid");
    }
    const granted = this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [
        scope("workspace:share", input.workspaceId),
      ]);
      const now = this.now();
      const exists =
        input.subjectKind === "principal"
          ? tx.accounts.principal(input.subjectId) !== undefined
          : tx.accounts.group(input.subjectId) !== undefined;
      if (!exists) throw new IdentityError("notFound");
      const row = this.put(tx.accounts, {
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        workspaceId: input.workspaceId,
        role,
        grantedBy: actor.principalId,
        nowMs: now,
      });
      this.note(tx.accounts, actor, now, {
        action: "share.grant.set",
        target: row.grantId,
        workspaceId: input.workspaceId,
        detail: {
          role,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
        },
      });
      return {
        ...row,
        permissions: rolePermissions(role),
      };
    });
    // 降级（driver → viewer）同样是一次收权：已经开着的事件流要复核。
    accessChanged();
    return granted;
  }

  revokeGrant(
    actor: AuthorizationSubject,
    input: {
      workspaceId: string;
      subjectKind: GrantSubjectKind;
      subjectId: string;
    },
  ): void {
    if (
      !validIdentifier(input.workspaceId) ||
      input.workspaceId === "" ||
      !ID_PATTERN.test(input.subjectId)
    ) {
      throw new IdentityError("invalid");
    }
    this.options.store.transaction((tx) => {
      this.require(tx.accounts, actor, [
        scope("workspace:share", input.workspaceId),
      ]);
      const now = this.now();
      const row = tx.accounts.liveGrant(
        input.subjectKind,
        input.subjectId,
        input.workspaceId,
      );
      if (row === undefined) throw new IdentityError("notFound");
      tx.accounts.revokeGrant(row.grantId, now);
      this.note(tx.accounts, actor, now, {
        action: "share.grant.revoke",
        target: row.grantId,
        workspaceId: input.workspaceId,
        detail: { subjectKind: input.subjectKind, subjectId: input.subjectId },
      });
    });
    accessChanged();
  }

  /** 一个 principal 今天从授予里拿到的全部 scope，界面用它显示「有效权限」。 */
  effectiveGrantScopes(principalId: string): Scope[] {
    return this.options.store.transaction((tx) =>
      compileGrants(tx.accounts, principalId),
    );
  }

  /* --------------------------------- audit -------------------------------- */

  readAudit(
    actor: AuthorizationSubject,
    filter: { principalId?: string; workspaceId?: string; limit?: number },
  ): {
    id: number;
    atMs: number;
    principalId: string;
    deviceId: string;
    action: string;
    target: string;
    workspaceId: string;
    detail: unknown;
  }[] {
    return this.options.store.transaction((tx) => {
      this.require(
        tx.accounts,
        actor,
        filter.workspaceId
          ? [scope("workspace:share", filter.workspaceId)]
          : [scope("identity:manage")],
      );
      return tx.accounts.auditEntries(filter).map((row) => ({
        id: row.id,
        atMs: row.atMs,
        principalId: row.principalId,
        deviceId: row.deviceId,
        action: row.action,
        target: row.target,
        workspaceId: row.workspaceId,
        detail: parseDetail(row.detailJson),
      }));
    });
  }

  /* -------------------------------- internals ----------------------------- */

  private put(
    accounts: AccountsTx,
    input: {
      subjectKind: GrantSubjectKind;
      subjectId: string;
      workspaceId: string;
      role: ShareRole;
      grantedBy: string;
      nowMs: number;
    },
  ): {
    grantId: string;
    subjectKind: GrantSubjectKind;
    subjectId: string;
    workspaceId: string;
    role: ShareRole;
    grantedBy: string;
    createdAtMs: number;
  } {
    const live = accounts.liveGrant(
      input.subjectKind,
      input.subjectId,
      input.workspaceId,
    );
    if (live !== undefined) {
      if (live.role === input.role) {
        return {
          grantId: live.grantId,
          subjectKind: live.subjectKind,
          subjectId: live.subjectId,
          workspaceId: live.workspaceId,
          role: live.role,
          grantedBy: live.grantedBy,
          createdAtMs: live.createdAtMs,
        };
      }
      accounts.revokeGrant(live.grantId, input.nowMs);
    }
    const grantId = newId();
    const row = {
      grantId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      workspaceId: input.workspaceId,
      role: input.role,
      grantedBy: input.grantedBy,
      createdAtMs: input.nowMs,
    };
    accounts.createGrant({ ...row, revokedAtMs: 0 });
    return row;
  }

  /**
   * 判定入口。owner 恒真（设计 §4.1），其余按「会话快照 ∪ 编译出来的授予」。
   *
   * 和 `Authorizer` 是同一条规则，写在这里是因为它跑在**已经打开的事务里**：
   * 再开一笔事务去编译授予会在同一个连接上嵌套 `BEGIN`。
   */
  private require(
    accounts: AccountsTx,
    actor: AuthorizationSubject,
    required: readonly Scope[],
  ): void {
    if (actor.kind === "owner") return;
    const granted = [
      ...actor.scopes,
      ...compileGrants(accounts, actor.principalId),
    ];
    const allowed = required.every((request) =>
      granted.some(
        (grant) =>
          grant.Permission === request.Permission &&
          (grant.WorkspaceID === "" ||
            grant.WorkspaceID === request.WorkspaceID) &&
          (grant.ExecutionHostID === "" ||
            grant.ExecutionHostID === request.ExecutionHostID),
      ),
    );
    if (!allowed) throw new IdentityError("permission");
  }

  /** 有没有全局的 `identity:manage`（owner 恒有）。不抛，给「要不要过滤」用。 */
  private manages(accounts: AccountsTx, actor: AuthorizationSubject): boolean {
    try {
      this.require(accounts, actor, [scope("identity:manage")]);
      return true;
    } catch {
      return false;
    }
  }

  /** 这个主体在哪些组里是 `admin`。 */
  private administeredGroups(
    accounts: AccountsTx,
    actor: AuthorizationSubject,
  ): Set<string> {
    const groups = new Set<string>();
    if (actor.principalId === "") return groups;
    for (const groupId of accounts.groupsOf(actor.principalId)) {
      const own = accounts
        .groupMembers(groupId)
        .find((member) => member.principalId === actor.principalId);
      if (own?.role === "admin") groups.add(groupId);
    }
    return groups;
  }

  /**
   * 管这个组的成员：全局 `identity:manage`，或者本组的 `admin`。
   *
   * 组角色是**组内**的：它不编译成任何 scope（授权仍只有 scope 一种表达，设计
   * S3），只在组管理这几个动作上多一道「你是不是这个组的管理员」。所以组管理员
   * 管不到别的组、建不了组、删不了组，也发不了工作空间上的共享。
   */
  private requireGroupAdmin(
    accounts: AccountsTx,
    actor: AuthorizationSubject,
    groupId: string,
  ): void {
    if (this.manages(accounts, actor)) return;
    if (this.administeredGroups(accounts, actor).has(groupId)) return;
    throw new IdentityError("permission");
  }

  /**
   * 签发或作废一张邀请要什么：指向工作空间的要那块工作空间的 `workspace:share`；
   * 只指向组的要能管那个组。两者都指向时两条都要。
   */
  private requireInvitationRights(
    accounts: AccountsTx,
    actor: AuthorizationSubject,
    targetGroupId: string,
    targetWorkspaceId: string,
  ): void {
    if (targetWorkspaceId !== "") {
      this.require(accounts, actor, [
        scope("workspace:share", targetWorkspaceId),
      ]);
    }
    if (targetGroupId !== "") {
      this.requireGroupAdmin(accounts, actor, targetGroupId);
    }
    if (targetGroupId === "" && targetWorkspaceId === "") {
      this.require(accounts, actor, [scope("identity:manage")]);
    }
  }

  /** 动自己的凭据不需要 `identity:manage`；动别人的需要。 */
  private requireSelfOrManage(
    accounts: AccountsTx,
    actor: AuthorizationSubject,
    principalId: string,
  ): void {
    if (actor.kind === "owner" || actor.principalId === principalId) return;
    this.require(accounts, actor, [scope("identity:manage")]);
  }

  private view(
    accounts: AccountsTx,
    row: {
      principalId: string;
      kind: PrincipalKind;
      displayName: string;
      createdAtMs: number;
      disabledAtMs: number;
    },
  ): PrincipalView {
    return {
      principalId: row.principalId,
      kind: row.kind,
      displayName: row.displayName,
      createdAtMs: row.createdAtMs,
      disabledAtMs: row.disabledAtMs,
      hasPassword: accounts.livePassword(row.principalId) !== undefined,
    };
  }

  private note(
    accounts: AccountsTx,
    actor: AuthorizationSubject,
    nowMs: number,
    event: {
      action: string;
      target?: string;
      workspaceId?: string;
      detail?: Record<string, unknown>;
    },
  ): void {
    accounts.appendAudit({
      atMs: nowMs,
      principalId: actor.principalId,
      deviceId: "",
      action: event.action,
      target: event.target ?? "",
      workspaceId: event.workspaceId ?? "",
      detailJson:
        event.detail === undefined ? "" : JSON.stringify(event.detail),
    });
  }
}

function parseDetail(value: string): unknown {
  if (value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
