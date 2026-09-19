-- 统一库：Go Host 曾经独占的身份表，以 Host 自己的表名与列名建进 `canvas.db`。
--
-- 编号接着 `apps/runtime/migrations` 往下走（14 → 15），但文件不放在那个目录：
-- 那个目录被 `sqlx::migrate!("./migrations")` 编译进 Rust Runtime，放进去 Rust
-- 也会应用它，单向门就不成立了。这条迁移只有 TS core 认识，Rust 打开一个应用
-- 过它的库时命中「版本本构建不认识」这条拒绝规则——正是 TypeScript Core 设计
-- §7 要的效果（应用后不能再回 Rust，回滚 = 用备份替换）。
--
-- 列定义逐字对着 `apps/host/internal/storage/schema.go` 的 schemaV1（store_meta）
-- 与 schemaV2（身份四张表），CHECK 一条不少。同名同列是为了 `host.db` 的一次性
-- 搬运能逐行照搬，不做任何形状转换。其余域（命令、GitHub、自动化、实体/事件）
-- 的表由 R4 / R5 各自的后续迁移加。

CREATE TABLE store_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 host_id TEXT NOT NULL,
 event_floor INTEGER NOT NULL DEFAULT 0 CHECK(event_floor >= 0),
 last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= event_floor)
);

CREATE TABLE identity_owner (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 principal_id TEXT NOT NULL UNIQUE CHECK(length(principal_id) = 32),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0)
);

CREATE TABLE identity_devices (
 device_id TEXT PRIMARY KEY CHECK(length(device_id) = 32),
 principal_id TEXT NOT NULL REFERENCES identity_owner(principal_id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
 role TEXT NOT NULL CHECK(role = 'owner'),
 epoch INTEGER NOT NULL CHECK(epoch > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
);

CREATE TABLE identity_sessions (
 session_id TEXT PRIMARY KEY CHECK(length(session_id) = 32),
 device_id TEXT NOT NULL REFERENCES identity_devices(device_id),
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

CREATE TABLE identity_bootstrap_tickets (
 ticket_id TEXT PRIMARY KEY CHECK(length(ticket_id) = 32),
 ticket_hash BLOB NOT NULL CHECK(length(ticket_hash) = 32),
 host_id TEXT NOT NULL, instance_id TEXT NOT NULL, origin TEXT NOT NULL,
 device_name TEXT NOT NULL CHECK(length(device_name) BETWEEN 1 AND 256),
 scopes BLOB NOT NULL CHECK(length(scopes) <= 16384),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
 consumed_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(consumed_at_ms >= 0)
);
