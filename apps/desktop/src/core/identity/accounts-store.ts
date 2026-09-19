import type { DatabaseSync } from "node:sqlite";
import { IdentityError } from "./errors";
import type { ShareRole } from "./roles";

/**
 * 账号、凭据、邀请、组、授予与审计的持久化（迁移 `0019_accounts.sql`）。
 *
 * 和 `store.ts` 分开是因为它们的读者不同：`store.ts` 那五张表跑在**每一个请求**
 * 的认证路径上，这几张只在管理动作和一次授权编译里被读。分文件也让 `store.ts`
 * 继续逐列对得上 Go Host 的形状——那是搬运 `host.db` 的前提。
 *
 * 所有方法都要求调用方已经在 `IdentityStore.transaction` 的事务里：一次授予
 * 变更要同时写 `identity_grants` 和 `audit_log`，半笔写入没有意义。
 */

export type PrincipalKind = "owner" | "member" | "service";
export type CredentialKind = "password" | "passkey" | "oauth";
export type GrantSubjectKind = "principal" | "group";
export type GroupRole = "admin" | "member";

export interface PrincipalRow {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly createdAtMs: number;
  readonly disabledAtMs: number;
}

export interface CredentialRow {
  readonly credentialId: string;
  readonly principalId: string;
  readonly kind: CredentialKind;
  readonly provider: string;
  readonly subject: string;
  readonly secretHash: Buffer;
  readonly salt: Buffer;
  readonly kdf: string;
  readonly cost: number;
  readonly block: number;
  readonly parallel: number;
  readonly length: number;
  readonly createdAtMs: number;
  readonly revokedAtMs: number;
}

export interface InvitationRow {
  readonly invitationId: string;
  readonly issuedBy: string;
  readonly targetGroupId: string;
  readonly targetWorkspaceId: string;
  readonly role: ShareRole;
  readonly tokenHash: Buffer;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly consumedBy: string;
  readonly consumedAtMs: number;
}

export interface GroupRow {
  readonly groupId: string;
  readonly name: string;
  readonly ownerPrincipalId: string;
  readonly createdAtMs: number;
}

export interface GroupMemberRow {
  readonly groupId: string;
  readonly principalId: string;
  readonly role: GroupRole;
  readonly joinedAtMs: number;
}

export interface GrantRow {
  readonly grantId: string;
  readonly subjectKind: GrantSubjectKind;
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly role: ShareRole;
  readonly grantedBy: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number;
}

export interface AuditRow {
  readonly id: number;
  readonly atMs: number;
  readonly principalId: string;
  readonly deviceId: string;
  readonly action: string;
  readonly target: string;
  readonly workspaceId: string;
  readonly detailJson: string;
}

export class AccountsTx {
  constructor(private readonly database: DatabaseSync) {}

  /* ------------------------------ principals ------------------------------ */

  principal(principalId: string): PrincipalRow | undefined {
    const row = this.database
      .prepare(`SELECT ${PRINCIPAL_COLUMNS} WHERE principal_id = ?`)
      .get(principalId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toPrincipal(row);
  }

  /** owner 行。唯一索引保证它最多一条，所以这里没有「挑哪一个」的问题。 */
  owner(): PrincipalRow | undefined {
    const row = this.database
      .prepare(`SELECT ${PRINCIPAL_COLUMNS} WHERE kind = 'owner'`)
      .get() as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toPrincipal(row);
  }

  principals(afterId = "", limit = 200): PrincipalRow[] {
    const rows = this.database
      .prepare(
        `SELECT ${PRINCIPAL_COLUMNS} WHERE principal_id > ? ORDER BY principal_id LIMIT ?`,
      )
      .all(afterId, limit) as Record<string, unknown>[];
    return rows.map(toPrincipal);
  }

  createPrincipal(row: PrincipalRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_principals(principal_id, kind, display_name, created_at_ms, disabled_at_ms) " +
          "VALUES(?, ?, ?, ?, ?)",
      )
      .run(
        row.principalId,
        row.kind,
        row.displayName,
        row.createdAtMs,
        row.disabledAtMs,
      );
  }

  renamePrincipal(principalId: string, displayName: string): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_principals SET display_name = ? WHERE principal_id = ?",
      )
      .run(displayName, principalId).changes;
    if (Number(changes) !== 1) throw new IdentityError("notFound");
  }

  /** 停用一个 principal。owner 停不了——那会把这台机器锁死。 */
  disablePrincipal(principalId: string, nowMs: number): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_principals SET disabled_at_ms = ? " +
          "WHERE principal_id = ? AND disabled_at_ms = 0 AND kind <> 'owner'",
      )
      .run(nowMs, principalId).changes;
    if (Number(changes) !== 1) throw new IdentityError("conflict");
  }

  /* ------------------------------ credentials ----------------------------- */

  credential(credentialId: string): CredentialRow | undefined {
    const row = this.database
      .prepare(`SELECT ${CREDENTIAL_COLUMNS} WHERE credential_id = ?`)
      .get(credentialId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toCredential(row);
  }

  credentialsOf(principalId: string): CredentialRow[] {
    const rows = this.database
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} WHERE principal_id = ? ORDER BY created_at_ms, credential_id`,
      )
      .all(principalId) as Record<string, unknown>[];
    return rows.map(toCredential);
  }

  /** 这个 principal 当前有效的口令凭据，最多一份（唯一索引）。 */
  livePassword(principalId: string): CredentialRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} WHERE principal_id = ? AND kind = 'password' AND revoked_at_ms = 0`,
      )
      .get(principalId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toCredential(row);
  }

  createCredential(row: CredentialRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_credentials(credential_id, principal_id, kind, provider, subject, secret_hash, " +
          "salt, kdf, kdf_cost, kdf_block, kdf_parallel, kdf_length, created_at_ms, revoked_at_ms) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        row.credentialId,
        row.principalId,
        row.kind,
        row.provider,
        row.subject,
        new Uint8Array(row.secretHash),
        new Uint8Array(row.salt),
        row.kdf,
        row.cost,
        row.block,
        row.parallel,
        row.length,
        row.createdAtMs,
      );
  }

  /** 参数升级：登录成功那一刻用今天的参数重派生，写回同一行。 */
  updateCredentialSecret(
    credentialId: string,
    secretHash: Buffer,
    salt: Buffer,
    parameters: {
      kdf: string;
      cost: number;
      block: number;
      parallel: number;
      length: number;
    },
  ): void {
    this.database
      .prepare(
        "UPDATE identity_credentials SET secret_hash = ?, salt = ?, kdf = ?, kdf_cost = ?, kdf_block = ?, " +
          "kdf_parallel = ?, kdf_length = ? WHERE credential_id = ? AND revoked_at_ms = 0",
      )
      .run(
        new Uint8Array(secretHash),
        new Uint8Array(salt),
        parameters.kdf,
        parameters.cost,
        parameters.block,
        parameters.parallel,
        parameters.length,
        credentialId,
      );
  }

  revokeCredential(credentialId: string, nowMs: number): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_credentials SET revoked_at_ms = ? WHERE credential_id = ? AND revoked_at_ms = 0",
      )
      .run(nowMs, credentialId).changes;
    if (Number(changes) !== 1) throw new IdentityError("notFound");
  }

  /* ------------------------------ invitations ----------------------------- */

  invitation(invitationId: string): InvitationRow | undefined {
    const row = this.database
      .prepare(`SELECT ${INVITATION_COLUMNS} WHERE invitation_id = ?`)
      .get(invitationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toInvitation(row);
  }

  invitations(limit = 200): InvitationRow[] {
    const rows = this.database
      .prepare(
        `SELECT ${INVITATION_COLUMNS} ORDER BY created_at_ms DESC, invitation_id LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(toInvitation);
  }

  createInvitation(row: InvitationRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_invitations(invitation_id, issued_by, target_group_id, target_workspace_id, " +
          "role, token_hash, created_at_ms, expires_at_ms, consumed_by, consumed_at_ms) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?, ?, '', 0)",
      )
      .run(
        row.invitationId,
        row.issuedBy,
        row.targetGroupId,
        row.targetWorkspaceId,
        row.role,
        new Uint8Array(row.tokenHash),
        row.createdAtMs,
        row.expiresAtMs,
      );
  }

  /**
   * 标记一张邀请被用掉。一次性就在这个 `consumed_at_ms = 0` 条件里：第二次接受
   * 改不动任何行，整笔事务回滚，于是第二个人什么也拿不到。
   */
  consumeInvitation(
    invitationId: string,
    principalId: string,
    nowMs: number,
  ): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_invitations SET consumed_by = ?, consumed_at_ms = ? " +
          "WHERE invitation_id = ? AND consumed_at_ms = 0",
      )
      .run(principalId, nowMs, invitationId).changes;
    if (Number(changes) !== 1) throw new IdentityError("conflict");
  }

  /* --------------------------------- groups ------------------------------- */

  group(groupId: string): GroupRow | undefined {
    const row = this.database
      .prepare(
        "SELECT group_id, name, owner_principal_id, created_at_ms FROM identity_groups WHERE group_id = ?",
      )
      .get(groupId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toGroup(row);
  }

  groups(limit = 200): GroupRow[] {
    const rows = this.database
      .prepare(
        "SELECT group_id, name, owner_principal_id, created_at_ms FROM identity_groups ORDER BY name, group_id LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(toGroup);
  }

  createGroup(row: GroupRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_groups(group_id, name, owner_principal_id, created_at_ms) VALUES(?, ?, ?, ?)",
      )
      .run(row.groupId, row.name, row.ownerPrincipalId, row.createdAtMs);
  }

  renameGroup(groupId: string, name: string): void {
    const changes = this.database
      .prepare("UPDATE identity_groups SET name = ? WHERE group_id = ?")
      .run(name, groupId).changes;
    if (Number(changes) !== 1) throw new IdentityError("notFound");
  }

  /**
   * 删一个组，连同它的成员与它名下的授予。
   *
   * 授予是**撤销**而不是删除：一条「谁在什么时候能看这块画布」的记录，删掉之后
   * 审计里就只剩下一条指向不存在主体的动作。成员表跟着组走（外键级联），因为
   * 一个不存在的组的成员关系没有可回答的问题。
   */
  deleteGroup(groupId: string, nowMs: number): void {
    this.database
      .prepare(
        "UPDATE identity_grants SET revoked_at_ms = ? WHERE subject_kind = 'group' AND subject_id = ? AND revoked_at_ms = 0",
      )
      .run(nowMs, groupId);
    this.database
      .prepare("DELETE FROM identity_group_members WHERE group_id = ?")
      .run(groupId);
    const changes = this.database
      .prepare("DELETE FROM identity_groups WHERE group_id = ?")
      .run(groupId).changes;
    if (Number(changes) !== 1) throw new IdentityError("notFound");
  }

  groupMembers(groupId: string): GroupMemberRow[] {
    const rows = this.database
      .prepare(
        "SELECT group_id, principal_id, role, joined_at_ms FROM identity_group_members " +
          "WHERE group_id = ? ORDER BY principal_id",
      )
      .all(groupId) as Record<string, unknown>[];
    return rows.map(toGroupMember);
  }

  /** 这个 principal 所在的组标识，授权编译要用。 */
  groupsOf(principalId: string): string[] {
    const rows = this.database
      .prepare(
        "SELECT group_id FROM identity_group_members WHERE principal_id = ? ORDER BY group_id",
      )
      .all(principalId) as { group_id: string }[];
    return rows.map((row) => String(row.group_id));
  }

  putGroupMember(row: GroupMemberRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_group_members(group_id, principal_id, role, joined_at_ms) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(group_id, principal_id) DO UPDATE SET role = excluded.role",
      )
      .run(row.groupId, row.principalId, row.role, row.joinedAtMs);
  }

  removeGroupMember(groupId: string, principalId: string): void {
    const changes = this.database
      .prepare(
        "DELETE FROM identity_group_members WHERE group_id = ? AND principal_id = ?",
      )
      .run(groupId, principalId).changes;
    if (Number(changes) !== 1) throw new IdentityError("notFound");
  }

  /* --------------------------------- grants ------------------------------- */

  grant(grantId: string): GrantRow | undefined {
    const row = this.database
      .prepare(`SELECT ${GRANT_COLUMNS} WHERE grant_id = ?`)
      .get(grantId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toGrant(row);
  }

  /** 一个工作空间上所有有效的授予。 */
  workspaceGrants(workspaceId: string): GrantRow[] {
    const rows = this.database
      .prepare(
        `SELECT ${GRANT_COLUMNS} WHERE workspace_id = ? AND revoked_at_ms = 0 ORDER BY created_at_ms, grant_id`,
      )
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map(toGrant);
  }

  liveGrant(
    subjectKind: GrantSubjectKind,
    subjectId: string,
    workspaceId: string,
  ): GrantRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${GRANT_COLUMNS} WHERE subject_kind = ? AND subject_id = ? AND workspace_id = ? AND revoked_at_ms = 0`,
      )
      .get(subjectKind, subjectId, workspaceId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toGrant(row);
  }

  /**
   * 一个 principal 通过自己和自己所在的组拿到的全部有效授予。
   *
   * 这是授权编译的输入。组与个人的授予是并集而不是覆盖：两者给的是 scope，
   * 而 scope 只有「有」和「没有」，没有优先级。
   */
  grantsFor(principalId: string): GrantRow[] {
    const groups = this.groupsOf(principalId);
    const rows = this.database
      .prepare(
        `SELECT ${GRANT_COLUMNS} WHERE revoked_at_ms = 0 AND ` +
          "((subject_kind = 'principal' AND subject_id = ?) OR subject_kind = 'group') " +
          "ORDER BY workspace_id, grant_id",
      )
      .all(principalId) as Record<string, unknown>[];
    return rows
      .map(toGrant)
      .filter(
        (row) =>
          row.subjectKind === "principal" || groups.includes(row.subjectId),
      );
  }

  createGrant(row: GrantRow): void {
    this.database
      .prepare(
        "INSERT INTO identity_grants(grant_id, subject_kind, subject_id, workspace_id, role, granted_by, " +
          "created_at_ms, revoked_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        row.grantId,
        row.subjectKind,
        row.subjectId,
        row.workspaceId,
        row.role,
        row.grantedBy,
        row.createdAtMs,
      );
  }

  revokeGrant(grantId: string, nowMs: number): void {
    const changes = this.database
      .prepare(
        "UPDATE identity_grants SET revoked_at_ms = ? WHERE grant_id = ? AND revoked_at_ms = 0",
      )
      .run(nowMs, grantId).changes;
    if (Number(changes) !== 1) throw new IdentityError("notFound");
  }

  /* --------------------------------- audit -------------------------------- */

  appendAudit(row: Omit<AuditRow, "id">): void {
    this.database
      .prepare(
        "INSERT INTO audit_log(at_ms, principal_id, device_id, action, target, workspace_id, detail_json) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.atMs,
        row.principalId,
        row.deviceId,
        row.action,
        row.target,
        row.workspaceId,
        row.detailJson,
      );
  }

  auditEntries(filter: {
    readonly principalId?: string;
    readonly workspaceId?: string;
    readonly limit?: number;
  }): AuditRow[] {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (filter.principalId) {
      clauses.push("principal_id = ?");
      values.push(filter.principalId);
    }
    if (filter.workspaceId) {
      clauses.push("workspace_id = ?");
      values.push(filter.workspaceId);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    values.push(filter.limit ?? 100);
    const rows = this.database
      .prepare(
        "SELECT id, at_ms, principal_id, device_id, action, target, workspace_id, detail_json " +
          `FROM audit_log${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(...values) as Record<string, unknown>[];
    return rows.map(toAudit);
  }
}

const PRINCIPAL_COLUMNS =
  "principal_id, kind, display_name, created_at_ms, disabled_at_ms FROM identity_principals";
const CREDENTIAL_COLUMNS =
  "credential_id, principal_id, kind, provider, subject, secret_hash, salt, kdf, kdf_cost, kdf_block, " +
  "kdf_parallel, kdf_length, created_at_ms, revoked_at_ms FROM identity_credentials";
const INVITATION_COLUMNS =
  "invitation_id, issued_by, target_group_id, target_workspace_id, role, token_hash, created_at_ms, " +
  "expires_at_ms, consumed_by, consumed_at_ms FROM identity_invitations";
const GRANT_COLUMNS =
  "grant_id, subject_kind, subject_id, workspace_id, role, granted_by, created_at_ms, revoked_at_ms " +
  "FROM identity_grants";

function toPrincipal(row: Record<string, unknown>): PrincipalRow {
  return {
    principalId: String(row.principal_id),
    kind: String(row.kind) as PrincipalKind,
    displayName: String(row.display_name),
    createdAtMs: Number(row.created_at_ms),
    disabledAtMs: Number(row.disabled_at_ms),
  };
}

function toCredential(row: Record<string, unknown>): CredentialRow {
  return {
    credentialId: String(row.credential_id),
    principalId: String(row.principal_id),
    kind: String(row.kind) as CredentialKind,
    provider: String(row.provider),
    subject: String(row.subject),
    secretHash: blob(row.secret_hash),
    salt: blob(row.salt),
    kdf: String(row.kdf),
    cost: Number(row.kdf_cost),
    block: Number(row.kdf_block),
    parallel: Number(row.kdf_parallel),
    length: Number(row.kdf_length),
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
  };
}

function toInvitation(row: Record<string, unknown>): InvitationRow {
  return {
    invitationId: String(row.invitation_id),
    issuedBy: String(row.issued_by),
    targetGroupId: String(row.target_group_id),
    targetWorkspaceId: String(row.target_workspace_id),
    role: String(row.role) as ShareRole,
    tokenHash: blob(row.token_hash),
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    consumedBy: String(row.consumed_by),
    consumedAtMs: Number(row.consumed_at_ms),
  };
}

function toGroup(row: Record<string, unknown>): GroupRow {
  return {
    groupId: String(row.group_id),
    name: String(row.name),
    ownerPrincipalId: String(row.owner_principal_id),
    createdAtMs: Number(row.created_at_ms),
  };
}

function toGroupMember(row: Record<string, unknown>): GroupMemberRow {
  return {
    groupId: String(row.group_id),
    principalId: String(row.principal_id),
    role: String(row.role) as GroupRole,
    joinedAtMs: Number(row.joined_at_ms),
  };
}

function toGrant(row: Record<string, unknown>): GrantRow {
  return {
    grantId: String(row.grant_id),
    subjectKind: String(row.subject_kind) as GrantSubjectKind,
    subjectId: String(row.subject_id),
    workspaceId: String(row.workspace_id),
    role: String(row.role) as ShareRole,
    grantedBy: String(row.granted_by),
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
  };
}

function toAudit(row: Record<string, unknown>): AuditRow {
  return {
    id: Number(row.id),
    atMs: Number(row.at_ms),
    principalId: String(row.principal_id),
    deviceId: String(row.device_id),
    action: String(row.action),
    target: String(row.target),
    workspaceId: String(row.workspace_id),
    detailJson: String(row.detail_json),
  };
}

function blob(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}
