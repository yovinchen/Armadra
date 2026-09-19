-- 统一库：事件 outbox 与定时/自动化域。
--
-- 两件事一条迁移，因为它们是同一句话的两半：一个计划跑完要广播一条事件，而
-- 断线的页面要能把那条事件补回去。Go Host 里这两半分别在 `eventstream/` 与
-- `automation/` + `automationhost/`，中间隔着一个通用实体表；同进程之后中间那
-- 层没有了，两边各自落在自己的表上。
--
-- ## events —— 事件 outbox
--
-- 形状照 `apps/host/internal/storage/schema.go` schemaV1 的 `events` 收敛：那张
-- 表记的是「实体的某个修订」，因为 Host 的事件是实体投影出来的；统一库里事件
-- 就是事件（21 个 `WorkspaceEvent` 之一），所以列只剩序号、工作空间、类型、
-- 帧本身和时间。
--
--   * `seq` 是 AUTOINCREMENT，全库单调。**不是每个工作空间一条序列**：两个工作
--     空间共用一条序列，一个只看 A 的客户端在补发 B 的那段时也会把游标推过去，
--     这正是 `eventstream/catchup.go` 说的「游标跨过被过滤掉的事件继续前进」。
--   * `payload_json` 存的是发给页面的那一帧**原文**，不是它的零件。帧的形状是
--     契约（`workspaceEventSchema` 逐字段解析），补发的帧必须和当初广播的那帧
--     逐字节相同，重新拼一次就给了它一个走样的机会。
--   * 保留下限记在 `store_meta.event_floor`，水位记在 `store_meta.last_sequence`
--     ——列在 0015 就有了（照 schemaV1 抄的），这里第一次真正用上它们。游标低于
--     下限就是 `SNAPSHOT_REQUIRED`，高于水位就是 `CURSOR_AHEAD`。
--
-- ## 自动化
--
-- Host 把计划、激活记录、运行、目标闸门全都塞进通用 `entities` 表，一行一个
-- protobuf BLOB，排序靠自己编的 key。统一库里它们各有各的表，但**载荷仍然是同
-- 一份 protobuf**：`AutomationPlan` / `AutomationActivation` / `AutomationRun` 的
-- 字节不变，配置摘要因此和 Host 算出来的完全一致，旧 `host.db` 搬过来之后已经
-- 激活的计划不用重新授权。
--
-- 运行历史不再是「再建一张按时间倒排的索引实体」——那张索引在 Host 那边存在的
-- 唯一理由是实体表只能按 key 排序。这里一条 SQL 索引就是它，所以也没有回填。

CREATE TABLE events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 workspace_id TEXT NOT NULL,
 type TEXT NOT NULL CHECK(length(type) BETWEEN 1 AND 64),
 payload_json TEXT NOT NULL CHECK(length(payload_json) <= 1048576),
 at_ms INTEGER NOT NULL CHECK(at_ms > 0)
);

CREATE INDEX events_workspace_seq ON events(workspace_id, seq);

-- 冻结的命令根与命令会话。列逐字对着 schemaV3，搬运不做形状转换。
CREATE TABLE command_roots (
 root_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 path TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0)
);

CREATE TABLE command_sessions (
 session_id TEXT PRIMARY KEY,
 root_id TEXT NOT NULL REFERENCES command_roots(root_id),
 workspace_id TEXT NOT NULL,
 execution_host_id TEXT NOT NULL,
 launch BLOB NOT NULL CHECK(length(launch) BETWEEN 1 AND 131072),
 launch_sha256 BLOB NOT NULL CHECK(length(launch_sha256) = 32),
 generation INTEGER NOT NULL CHECK(generation > 0),
 state INTEGER NOT NULL CHECK(state IN (1,2)),
 reason_code TEXT NOT NULL CHECK(length(reason_code) <= 64),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);

-- 计划的私有载荷（stdin / prompt）。内容寻址：`payload_ref` 就是它的十六进制
-- 摘要，所以同样的字节只存一份，而一个计划永远指不到别人存进来的内容。
CREATE TABLE automation_payloads (
 workspace_id TEXT NOT NULL,
 payload_ref TEXT NOT NULL,
 payload BLOB NOT NULL CHECK(length(payload) <= 262144),
 payload_sha256 BLOB NOT NULL CHECK(length(payload_sha256) = 32),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 PRIMARY KEY(workspace_id, payload_ref)
);

-- 授权当时那台设备握着的授权位。投递时重新对照的是这一行，不是一个活会话：
-- 计划在页面关掉之后还要跑，而跑的时候那台设备可能已经被吊销了。
CREATE TABLE automation_grants (
 authorization_id TEXT PRIMARY KEY CHECK(length(authorization_id) = 32),
 principal_id TEXT NOT NULL CHECK(length(principal_id) = 32),
 device_id TEXT NOT NULL,
 device_epoch INTEGER NOT NULL CHECK(device_epoch > 0),
 scopes BLOB NOT NULL CHECK(length(scopes) BETWEEN 1 AND 16384),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);

CREATE TABLE automation_plans (
 workspace_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 payload BLOB NOT NULL CHECK(length(payload) <= 1048576),
 state INTEGER NOT NULL,
 next_due_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_due_at_ms >= 0),
 updated_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(updated_at_ms >= 0),
 PRIMARY KEY(workspace_id, plan_id)
);

CREATE TABLE automation_activations (
 workspace_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 payload BLOB NOT NULL CHECK(length(payload) <= 262144),
 PRIMARY KEY(workspace_id, plan_id)
);

-- `scheduled_at_ms` 与 `run_id` 一起就是运行历史的顺序。Host 另建了一张按时间
-- 倒排的索引实体外加一次性回填，因为它的实体表只能按 key 排；这里索引就是索引。
CREATE TABLE automation_runs (
 workspace_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 scheduled_at_ms INTEGER NOT NULL CHECK(scheduled_at_ms >= 0),
 revision INTEGER NOT NULL CHECK(revision > 0),
 payload BLOB NOT NULL CHECK(length(payload) <= 1048576),
 PRIMARY KEY(workspace_id, run_id)
);

CREATE INDEX automation_runs_history
 ON automation_runs(workspace_id, plan_id, scheduled_at_ms DESC, run_id);

CREATE UNIQUE INDEX automation_runs_operation ON automation_runs(operation_id);

-- 目标闸门：一个目标同时只允许一次投递在飞。键是执行主机 + 会话（命令目标）或
-- 执行主机 + 节点（Agent 目标）的摘要——Agent 的会话会因为重启或冷启动合法地
-- 换掉，跟着会话走的闸门会停止串行化两个指向同一个终端的计划。
CREATE TABLE automation_gates (
 gate_id TEXT PRIMARY KEY,
 execution_host_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 node_id TEXT NOT NULL,
 active_run_id TEXT NOT NULL DEFAULT '',
 active_plan_id TEXT NOT NULL DEFAULT '',
 active_workspace_id TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL CHECK(revision > 0)
);

-- 投递收据。Host 的收据躺在 Rust Worker 的日志里，Lookup 是一次跨进程提问；
-- 同进程之后这张表就是那本日志，`advance` 在结果不明时照样能问出「到底写没写」。
CREATE TABLE automation_receipts (
 operation_id TEXT PRIMARY KEY,
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256) = 32),
 payload BLOB NOT NULL CHECK(length(payload) <= 65536),
 observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms > 0)
);
