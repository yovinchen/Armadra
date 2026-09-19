-- 统一库：Agent 域。Go Host `schemaV9` 的七张 `agent_*` 表在这里落地。
--
-- 和 0015 同一个机制：只有 TS core 读这个目录，编号接着往下走（15 → 16），
-- 单向门在 0015 就已经过了，这一条不再另做备份。
--
-- 七张表里只有两张是新建的，原因是名字已经被占了——不是被 Host 占，是被这个
-- 库自己占。`canvas.db` 从 0001 起就有 `agent_status` / `agent_approvals` /
-- `agent_mailbox` / `agent_deliveries` / `agent_handoffs`，列名、类型和主键都和
-- Host 那套不一样（Host 存 protobuf BLOB 加摘要，这边存 TEXT 加 JSON）。把
-- Host 的形状照抄进来会撞名，改名抄进来会得到两份同一件事的记录，而真正在用
-- 的是这边这份——API 逐字段对着它答。所以「吸收」在这里的意思是：把 Host 形状
-- **多出来的那些能力**补到既有表上，而不是把表再建一遍。
--
-- 逐张对照：
--
--   agent_status        → 既有表 + `revision`
--   agent_approvals     → 既有表 + `revision` / `session_id` / `generation` /
--                         `reason_code`
--   agent_mailbox       → 既有表 + `revision`
--   agent_deliveries    → 既有表 + `revision`
--   agent_handoffs      → 既有表 + `revision`
--   agent_context_links → 统一库里的对应物是 `context_links`（R1a 在用）。它的
--                         CAS 是 `updated_at`，和画布文档同一条规则，不再加一
--                         个第二真相。
--   agent_drain_cursor  → 新建，形状逐字对着 schemaV9。
--
-- `revision` 是跨设备互斥的那一列。Host 的写路径是「先在库里按 CAS 记下决定，
-- 再去告诉机器」——两台设备读到同一条待答审批都会尝试写 revision 1，第二台在
-- 碰到文件之前就被拒。默认 0 表示「这一行是 0016 之前写的，还没有人对它做过
-- CAS 写」，第一次 CAS 写把它抬到 1。
--
-- `agent_approval_audit` 是审计表，Host 那边这件事落在实体/事件库里，统一库里
-- 没有那套东西，所以单独一张。它记的是**每一次尝试**，不只是成功的那次：跨设备
-- 互斥的价值全在「谁先谁后、后来的那个被拒了」，只留胜者等于把证据丢掉。

ALTER TABLE agent_status ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_approvals ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_approvals ADD COLUMN session_id TEXT;
ALTER TABLE agent_approvals ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_approvals ADD COLUMN reason_code TEXT NOT NULL DEFAULT '';

ALTER TABLE agent_mailbox ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_deliveries ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_handoffs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

-- 每一次「有人回答了这条审批」的尝试，成功与否都记。
--
-- `accepted = 0` 的行是被 CAS 挡掉的那一次，`refusal` 说明为什么（已被回答、
-- revision 不对、决定不合法）。`answered_by` 是发起方的身份，跨设备时是另一台
-- 设备的主体 id；本机用户就是 `user`。
CREATE TABLE agent_approval_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  answered_by TEXT NOT NULL DEFAULT '',
  -- 尝试写入时调用方持有的 revision，和写入后实际生效的 revision。被拒时
  -- `applied_revision` 是 NULL：什么都没有生效。
  expected_revision INTEGER NOT NULL DEFAULT 0,
  applied_revision INTEGER,
  accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0, 1)),
  -- 决定送到 CLI 的路子：`file` / `keys` / `none`，被拒时为空串。
  route TEXT NOT NULL DEFAULT '',
  refusal TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_approval_audit_approval
  ON agent_approval_audit(approval_id, id);

-- 执行主机排空到哪一条事件了。形状逐字对着 schemaV9：没有同名表，照抄。
CREATE TABLE agent_drain_cursor (
  execution_host_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);
