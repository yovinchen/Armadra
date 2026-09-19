-- 账号、组与共享：把「单 owner」泛化成「principal 多个，owner 是其中一种」。
--
-- 规格是 `docs/design/server-accounts-and-sharing.md` §2。这条迁移只改身份域的
-- 形状，不改任何判定：应用之后这台机器仍然只有一个 owner 行、一台设备、一份
-- 全量授权，页面看不出区别。区别在于此后**可以**有第二个 principal。
--
-- 三件事在这里一次做完，因为它们互为前提：
--
--   * `identity_owner`（单行表）变成 `identity_principals`（多行表）。owner 那
--     一行在同一条迁移里搬过来，`kind='owner'`，`principal_id` 一个字节都不变
--     ——设备、会话、票据全都按它引用，换标识等于把所有人踢下线。
--   * `identity_devices` 的 `role` 从 `CHECK(role = 'owner')` 放开成
--     `'owner' | 'member'`，外键改指 `identity_principals`。SQLite 改不动
--     CHECK 与外键，只能整表重建（下面那一段的注释写了顺序为什么是那样）；
--     `PRAGMA defer_foreign_keys` 把外键检查推到提交时——迁移跑在
--     `BEGIN IMMEDIATE` 里，此时 `PRAGMA foreign_keys` 是空操作，只有它生效。
--   * 共享需要的四张新表：凭据、邀请、组与组成员、授予，外加审计。
--
-- 角色（viewer / editor / operator / driver）到 scope 的编译表**不在库里**，在
-- `core/identity/roles.ts`。库里存的是角色名：编译表随代码走，一次发布就能给
-- 所有既有授予补上新权限；存编译结果则要一条迁移才能改，而权限集合是会变的。

PRAGMA defer_foreign_keys = ON;

CREATE TABLE identity_principals (
 principal_id TEXT PRIMARY KEY CHECK(length(principal_id) = 32),
 kind TEXT NOT NULL CHECK(kind IN ('owner', 'member', 'service')),
 display_name TEXT NOT NULL CHECK(length(display_name) <= 256),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 disabled_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(disabled_at_ms >= 0)
);

-- owner 行原样搬过来。`identity_owner` 是单行表，所以这条最多搬一行；空库搬
-- 零行，第一次配对时再建。显示名留空：Go Host 从来没有存过它。
INSERT INTO identity_principals (principal_id, kind, display_name, created_at_ms, disabled_at_ms)
 SELECT principal_id, 'owner', '', created_at_ms, 0 FROM identity_owner;

-- 「只有一个 owner」这条不变量从单行表的 `singleton` 主键搬到这里。没有它，
-- 第二个 owner 行会让 `ownerPrincipal()` 变成一个要挑的选择。
CREATE UNIQUE INDEX identity_principals_single_owner
 ON identity_principals(kind) WHERE kind = 'owner';

-- 设备表整表重建，会话表跟着重建一次。
--
-- SQLite 改不动 CHECK 与外键，只能新建、搬行、换名，而这里有两条它的事实把
-- 顺序钉死了：
--
--   * `DROP TABLE` 一个**还有子表引用**的父表，会给每一行子记录记一笔延迟外键
--     违例，后面把新表改成同名也消不掉这笔账——提交时照样炸。所以旧的设备表
--     必须在**没有人引用它**的时候才能删，而引用它的正是会话表。
--   * `ALTER TABLE ... RENAME TO` 会把其它表 `REFERENCES` 里的表名一起改写。
--     这一次这条行为是帮忙的：最后两步改名把会话表的外键自动指回
--     `identity_devices`。（`PRAGMA legacy_alter_table` 关不掉它——试过。）
--
-- 会话行原样搬：`session_id` 与 `device_id` 不变，所以正在用的凭据升级之后
-- 继续有效，没有人被踢下线。
CREATE TABLE identity_devices_v2 (
 device_id TEXT PRIMARY KEY CHECK(length(device_id) = 32),
 principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
 role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
 epoch INTEGER NOT NULL CHECK(epoch > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
);

INSERT INTO identity_devices_v2 (device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms)
 SELECT device_id, principal_id, name, role, epoch, created_at_ms, revoked_at_ms FROM identity_devices;

CREATE TABLE identity_sessions_v2 (
 session_id TEXT PRIMARY KEY CHECK(length(session_id) = 32),
 device_id TEXT NOT NULL REFERENCES identity_devices_v2(device_id),
 device_epoch INTEGER NOT NULL CHECK(device_epoch > 0),
 origin TEXT NOT NULL, scopes BLOB NOT NULL CHECK(length(scopes) <= 16384),
 access_hash BLOB NOT NULL CHECK(length(access_hash) = 32),
 refresh_hash BLOB NOT NULL CHECK(length(refresh_hash) = 32),
 csrf_hash BLOB NOT NULL CHECK(length(csrf_hash) = 32),
 rotation INTEGER NOT NULL CHECK(rotation > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 access_expires_at_ms INTEGER NOT NULL CHECK(access_expires_at_ms > created_at_ms),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= access_expires_at_ms),
 revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
);

INSERT INTO identity_sessions_v2 (session_id, device_id, device_epoch, origin, scopes, access_hash,
 refresh_hash, csrf_hash, rotation, created_at_ms, access_expires_at_ms, expires_at_ms, revoked_at_ms)
 SELECT session_id, device_id, device_epoch, origin, scopes, access_hash, refresh_hash, csrf_hash,
 rotation, created_at_ms, access_expires_at_ms, expires_at_ms, revoked_at_ms FROM identity_sessions;

DROP TABLE identity_sessions;
DROP TABLE identity_devices;
DROP TABLE identity_owner;

ALTER TABLE identity_devices_v2 RENAME TO identity_devices;
ALTER TABLE identity_sessions_v2 RENAME TO identity_sessions;

-- 凭据。口令走 `crypto.scrypt`，参数逐列存下来：升参数是改常量，不是改迁移，
-- 而一份用旧参数派生的哈希必须仍然校验得了——所以参数属于行，不属于代码。
-- passkey 这一版只建表：WebAuthn 的注册与断言要一个这一批不引入的依赖。
CREATE TABLE identity_credentials (
 credential_id TEXT PRIMARY KEY CHECK(length(credential_id) = 32),
 principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
 kind TEXT NOT NULL CHECK(kind IN ('password', 'passkey', 'oauth')),
 provider TEXT NOT NULL DEFAULT '' CHECK(length(provider) <= 64),
 subject TEXT NOT NULL DEFAULT '' CHECK(length(subject) <= 256),
 secret_hash BLOB NOT NULL DEFAULT x'' CHECK(length(secret_hash) <= 128),
 salt BLOB NOT NULL DEFAULT x'' CHECK(length(salt) <= 64),
 kdf TEXT NOT NULL DEFAULT '' CHECK(kdf IN ('', 'scrypt')),
 kdf_cost INTEGER NOT NULL DEFAULT 0 CHECK(kdf_cost >= 0),
 kdf_block INTEGER NOT NULL DEFAULT 0 CHECK(kdf_block >= 0),
 kdf_parallel INTEGER NOT NULL DEFAULT 0 CHECK(kdf_parallel >= 0),
 kdf_length INTEGER NOT NULL DEFAULT 0 CHECK(kdf_length >= 0),
 public_key BLOB NOT NULL DEFAULT x'' CHECK(length(public_key) <= 1024),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
);

-- 一个 principal 同时只有一份有效口令。撤销的那些留着，是审计的一部分。
CREATE UNIQUE INDEX identity_credentials_one_password
 ON identity_credentials(principal_id)
 WHERE kind = 'password' AND revoked_at_ms = 0;

-- 一个第三方身份只能绑一个 principal，否则「用 GitHub 登录」是个二选一。
CREATE UNIQUE INDEX identity_credentials_one_oauth_subject
 ON identity_credentials(provider, subject)
 WHERE kind = 'oauth' AND revoked_at_ms = 0;

-- 邀请。一次性靠 `consumed_at_ms`，和票据同一种做法：删记录会让「这张邀请已经
-- 被谁用过」无从回答。
CREATE TABLE identity_invitations (
 invitation_id TEXT PRIMARY KEY CHECK(length(invitation_id) = 32),
 issued_by TEXT NOT NULL REFERENCES identity_principals(principal_id),
 target_group_id TEXT NOT NULL DEFAULT '' CHECK(length(target_group_id) IN (0, 32)),
 target_workspace_id TEXT NOT NULL DEFAULT '' CHECK(length(target_workspace_id) <= 256),
 role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'operator', 'driver')),
 token_hash BLOB NOT NULL CHECK(length(token_hash) = 32),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
 consumed_by TEXT NOT NULL DEFAULT '' CHECK(length(consumed_by) IN (0, 32)),
 consumed_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(consumed_at_ms >= 0)
);

CREATE TABLE identity_groups (
 group_id TEXT PRIMARY KEY CHECK(length(group_id) = 32),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
 owner_principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0)
);

CREATE TABLE identity_group_members (
 group_id TEXT NOT NULL REFERENCES identity_groups(group_id) ON DELETE CASCADE,
 principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
 role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
 joined_at_ms INTEGER NOT NULL CHECK(joined_at_ms > 0),
 PRIMARY KEY(group_id, principal_id)
);

-- 授予。`workspace_id` 刻意**不**建外键：授予的生命周期比一块画布长（删掉又
-- 从备份恢复的工作空间不该顺手清空谁能看它），而删除工作空间时级联撤销授予是
-- 一次显式的动作，不是一条约束。
CREATE TABLE identity_grants (
 grant_id TEXT PRIMARY KEY CHECK(length(grant_id) = 32),
 subject_kind TEXT NOT NULL CHECK(subject_kind IN ('principal', 'group')),
 subject_id TEXT NOT NULL CHECK(length(subject_id) = 32),
 workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
 role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'operator', 'driver')),
 granted_by TEXT NOT NULL REFERENCES identity_principals(principal_id),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
);

-- 一个主体对一个工作空间同时只有一条有效授予：两条不同角色的授予没有「哪条
-- 说了算」的答案，改角色就是撤旧立新。
CREATE UNIQUE INDEX identity_grants_one_live_per_subject
 ON identity_grants(subject_kind, subject_id, workspace_id)
 WHERE revoked_at_ms = 0;

CREATE INDEX identity_grants_by_workspace
 ON identity_grants(workspace_id) WHERE revoked_at_ms = 0;

-- 审计。**没有外键**：一条审计记录要比它提到的设备、组、授予活得久，外键会让
-- 「删掉那个组」同时删掉「谁在什么时候删了那个组」。
CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 at_ms INTEGER NOT NULL CHECK(at_ms > 0),
 principal_id TEXT NOT NULL DEFAULT '' CHECK(length(principal_id) IN (0, 32)),
 device_id TEXT NOT NULL DEFAULT '' CHECK(length(device_id) IN (0, 32)),
 action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 128),
 target TEXT NOT NULL DEFAULT '' CHECK(length(target) <= 256),
 workspace_id TEXT NOT NULL DEFAULT '' CHECK(length(workspace_id) <= 256),
 detail_json TEXT NOT NULL DEFAULT '' CHECK(length(detail_json) <= 8192)
);

CREATE INDEX audit_log_by_time ON audit_log(at_ms);
CREATE INDEX audit_log_by_principal ON audit_log(principal_id, at_ms);
CREATE INDEX audit_log_by_workspace ON audit_log(workspace_id, at_ms);
