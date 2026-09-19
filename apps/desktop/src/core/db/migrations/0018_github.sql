-- 统一库：GitHub 域。Go Host `schemaV4` 的三张 `github_*` 表原样落地。
--
-- 和 0016 不同，这里没有撞名的问题：`canvas.db` 从来没有 GitHub 表，Rust
-- Runtime 也没有对应实现。所以「吸收」在这一条里就是字面意思——表名、列名、
-- 类型和 CHECK 一个字不改地抄过来，旧 `host.db` 的行才能逐列搬进来
-- (`absorb-host.ts` 按列名而不是按列序搬，抄得不一样就会在搬运时炸开，而不是
-- 悄悄把 `api_base` 写进 `secret_ref`)。
--
-- 三张表各记什么：
--
--   github_config           单例。**机器级**，不属于任何工作空间也不属于任何
--                           设备：一台机器只有一个 GitHub 凭据来源和一个 API
--                           base。这就是它不去 `identity_credentials` 的理由
--                           ——那张表记的是「这台设备的这个人」，而 GitHub 令
--                           牌记的是「这台机器」。
--   github_status_mappings  每个工作空间 × 每个仓库一行，`mapping` 是
--                           `GithubStatusMapping` 的确定性 protobuf 编码。
--                           存 BLOB 而不是拆成列：分组是一个可变长度的列表，
--                           拆开会得到第四张表和一份和 protobuf 不同步的形状。
--   github_references       Issue / PR ↔ 本地会话、分支、worktree 的连接。
--                           `reference_id` 由「这条连接的含义」哈希而来，所以
--                           同一个 Issue 连到同一个目标两次是同一行。
--
-- **令牌不在这里**。`github_config` 只记来源、密钥存储种类和一个引用名；值本身
-- 在 OS 钥匙串或数据目录下那个 0600 文件里，读凭据永远回到 OS 存储。
--
-- 每张表都有 `revision`，CAS 就靠它：读到 revision N 的客户端写回来必须带 N，
-- 否则是冲突。`revision > 0` 是个 CHECK 而不是约定——0 表示「还没有行」，让它
-- 进库就等于让「不存在」和「第一版」长得一样。

CREATE TABLE github_config (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  source TEXT NOT NULL CHECK(source IN ('none','gh_cli','token_ref')),
  api_base TEXT NOT NULL CHECK(length(api_base) BETWEEN 1 AND 2048),
  secret_store TEXT NOT NULL CHECK(secret_store IN ('none','os_keychain','file_fallback')),
  secret_ref TEXT NOT NULL CHECK(length(secret_ref) <= 256),
  account_login TEXT NOT NULL CHECK(length(account_login) <= 256),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);

CREATE TABLE github_status_mappings (
  workspace_id TEXT NOT NULL,
  api_base TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  web_host TEXT NOT NULL,
  mapping BLOB NOT NULL CHECK(length(mapping) <= 262144),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0),
  PRIMARY KEY(workspace_id, api_base, owner, name)
);

CREATE TABLE github_references (
  reference_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  api_base TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  web_host TEXT NOT NULL,
  kind INTEGER NOT NULL CHECK(kind IN (1,2)),
  number INTEGER NOT NULL CHECK(number > 0),
  target_kind INTEGER NOT NULL CHECK(target_kind IN (1,2,3)),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 512),
  title TEXT NOT NULL CHECK(length(title) <= 1024),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);

-- 列表按工作空间 + `reference_id` 游标翻页，详情按目标过滤；两条都走这个索引。
CREATE INDEX idx_github_references_workspace
  ON github_references(workspace_id, reference_id);
CREATE INDEX idx_github_references_target
  ON github_references(workspace_id, target_id);
