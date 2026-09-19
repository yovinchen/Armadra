-- 自动化域：载荷从 protobuf 字节改成 JSON 文本。
--
-- 0017 把计划、激活、运行、收据、命令会话的定义都按 Go Host 的样子存成一个
-- protobuf BLOB。那是为了让旧 `host.db` 搬过来的行逐字节相同，已经激活的计划不
-- 用重新授权。R7 要删掉 `proto/` 与两份生成码，所以那个理由到期了：**一条谁都
-- 打得开的记录不能只由一份即将被删除的 schema 才读得懂**。
--
-- ## 形状
--
-- 每张表加一个 `*_json TEXT` 列，原来的 BLOB 列改为可空。两列并存一小段时间：
-- 迁移本身不解码任何字节（SQL 里没有 protobuf 解码器），转换在 core 启动时由
-- `core/schedule/convert-legacy.ts` 做一遍，把还只有 BLOB 的行补上 JSON。R7 收尾
-- 删那段代码，并把 BLOB 列一起删掉。
--
-- JSON 的写法是 protobuf 的 JSON 映射（字段名 camelCase、`int64` 与 `uint64` 是
-- 十进制字符串、`bytes` 是 base64、枚举是枚举值名、`oneof` 摊平成那一个被设置的
-- 字段）。选它不是因为还想留着 protobuf，而是因为它是一份**已经写死的规范**：
-- R7 手写编码器时有一份逐字段的参照，而不是一个「当初大概是这么转的」。逐字段的
-- 说明在 `docs/contracts/core-json-api.md`。
--
-- ## 摘要会变
--
-- `configSha256` 原来是 `toBinary(AutomationPlanConfig)` 的 SHA-256，现在是**规范
-- JSON**（键按名字排序、无空白、UTF-8）的 SHA-256。所以同一份配置算出来的是另一
-- 个数：**已经激活的计划需要重新授权一次**。产品未发布，这是可接受的代价；换来
-- 的是摘要不再依赖一份 protobuf 序列化器的字段顺序。
--
-- SQLite 的 `ALTER TABLE` 去不掉一个 `NOT NULL`，所以这几张表按「建新表 → 搬数据
-- → 换名字」重建。索引在重建之后按原样建回去。

-- 计划。
CREATE TABLE automation_plans_new (
 workspace_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 payload BLOB CHECK(payload IS NULL OR length(payload) <= 1048576),
 payload_json TEXT CHECK(payload_json IS NULL OR length(payload_json) <= 2097152),
 state INTEGER NOT NULL,
 next_due_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_due_at_ms >= 0),
 updated_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(updated_at_ms >= 0),
 PRIMARY KEY(workspace_id, plan_id),
 CHECK(payload IS NOT NULL OR payload_json IS NOT NULL)
);
INSERT INTO automation_plans_new
 (workspace_id, plan_id, revision, payload, payload_json, state, next_due_at_ms, updated_at_ms)
 SELECT workspace_id, plan_id, revision, payload, NULL, state, next_due_at_ms, updated_at_ms
 FROM automation_plans;
DROP TABLE automation_plans;
ALTER TABLE automation_plans_new RENAME TO automation_plans;

-- 激活记录。
CREATE TABLE automation_activations_new (
 workspace_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 payload BLOB CHECK(payload IS NULL OR length(payload) <= 262144),
 payload_json TEXT CHECK(payload_json IS NULL OR length(payload_json) <= 524288),
 PRIMARY KEY(workspace_id, plan_id),
 CHECK(payload IS NOT NULL OR payload_json IS NOT NULL)
);
INSERT INTO automation_activations_new
 (workspace_id, plan_id, revision, payload, payload_json)
 SELECT workspace_id, plan_id, revision, payload, NULL FROM automation_activations;
DROP TABLE automation_activations;
ALTER TABLE automation_activations_new RENAME TO automation_activations;

-- 运行记录。索引在重建之后建回去，名字与 0017 一致。
CREATE TABLE automation_runs_new (
 workspace_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 scheduled_at_ms INTEGER NOT NULL CHECK(scheduled_at_ms >= 0),
 revision INTEGER NOT NULL CHECK(revision > 0),
 payload BLOB CHECK(payload IS NULL OR length(payload) <= 1048576),
 payload_json TEXT CHECK(payload_json IS NULL OR length(payload_json) <= 2097152),
 PRIMARY KEY(workspace_id, run_id),
 CHECK(payload IS NOT NULL OR payload_json IS NOT NULL)
);
INSERT INTO automation_runs_new
 (workspace_id, run_id, plan_id, operation_id, scheduled_at_ms, revision, payload, payload_json)
 SELECT workspace_id, run_id, plan_id, operation_id, scheduled_at_ms, revision, payload, NULL
 FROM automation_runs;
DROP TABLE automation_runs;
ALTER TABLE automation_runs_new RENAME TO automation_runs;

CREATE INDEX automation_runs_history
 ON automation_runs(workspace_id, plan_id, scheduled_at_ms DESC, run_id);
CREATE UNIQUE INDEX automation_runs_operation ON automation_runs(operation_id);

-- 投递收据。
CREATE TABLE automation_receipts_new (
 operation_id TEXT PRIMARY KEY,
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256) = 32),
 payload BLOB CHECK(payload IS NULL OR length(payload) <= 65536),
 payload_json TEXT CHECK(payload_json IS NULL OR length(payload_json) <= 131072),
 observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms > 0),
 CHECK(payload IS NOT NULL OR payload_json IS NOT NULL)
);
INSERT INTO automation_receipts_new
 (operation_id, request_sha256, payload, payload_json, observed_at_ms)
 SELECT operation_id, request_sha256, payload, NULL, observed_at_ms FROM automation_receipts;
DROP TABLE automation_receipts;
ALTER TABLE automation_receipts_new RENAME TO automation_receipts;

-- 冻结的命令会话定义。`launch` 是一份 `CommandLaunchSpec`，同样换成 JSON；
-- `launch_sha256` 不变——它是那份定义的身份，重算等于换掉所有已冻结会话的身份。
CREATE TABLE command_sessions_new (
 session_id TEXT PRIMARY KEY,
 root_id TEXT NOT NULL REFERENCES command_roots(root_id),
 workspace_id TEXT NOT NULL,
 execution_host_id TEXT NOT NULL,
 launch BLOB CHECK(launch IS NULL OR length(launch) BETWEEN 1 AND 131072),
 launch_json TEXT CHECK(launch_json IS NULL OR length(launch_json) <= 262144),
 launch_sha256 BLOB NOT NULL CHECK(length(launch_sha256) = 32),
 generation INTEGER NOT NULL CHECK(generation > 0),
 state INTEGER NOT NULL CHECK(state IN (1,2)),
 reason_code TEXT NOT NULL CHECK(length(reason_code) <= 64),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0),
 CHECK(launch IS NOT NULL OR launch_json IS NOT NULL)
);
INSERT INTO command_sessions_new
 (session_id, root_id, workspace_id, execution_host_id, launch, launch_json, launch_sha256,
  generation, state, reason_code, revision, created_at_ms, updated_at_ms)
 SELECT session_id, root_id, workspace_id, execution_host_id, launch, NULL, launch_sha256,
  generation, state, reason_code, revision, created_at_ms, updated_at_ms
 FROM command_sessions;
DROP TABLE command_sessions;
ALTER TABLE command_sessions_new RENAME TO command_sessions;

-- `automation_payloads` 不在这张单子里：它存的是用户自己敲进去的 stdin / prompt
-- 原文，不是 protobuf。它按内容寻址（`payload_ref` 就是这些字节的摘要），把它转
-- 成另一种表示就会改掉所有已冻结计划指向的那个引用。JSON 面把它当 UTF-8 文本
-- 读出去（见 `docs/contracts/core-json-api.md` §4.3），库里仍然是字节。
