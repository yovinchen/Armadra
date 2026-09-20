-- `send` 排在别人终端前面的那一队（设计 docs/design/agent-delivery.md §4.6）。
--
-- 为什么排队要落库：目标忙的时候 `send` 既不拒绝也不打断，它等下一次 idle
-- （§0 的 D4）。而「下一次 idle」可能在页面刷新之后、甚至在 core 重启之后才
-- 到，所以这一队不能只在内存里。收件箱（`agent_mailbox`）早就是这个道理。
--
-- 为什么不复用 `agent_mailbox`：收件箱是**拉取**的，目标自己来读；这一队是
-- **推送**的，core 在目标空闲的那一刻替它按键。两张表的过期、容量、取消与
-- 可见性都不一样，共用一张表就得在每条语句上写「这一行是哪一种」。
--
-- `origin` 三个值对应三条入口：`send`（§3）、收件箱唤醒（§5）、带任务启动
-- （§8）。三条共用这一队、共用串行门、共用速率上限——不给唤醒开快车道，否则
-- 两条路径同时命中一个刚空闲的终端就是两次粘贴挤在一起。
CREATE TABLE agent_send_queue (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  origin         TEXT NOT NULL,
  message_key    TEXT,
  body           TEXT NOT NULL,
  hops           INTEGER NOT NULL DEFAULT 0,
  trail          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL,
  last_reason    TEXT
);

-- 出队问的永远是同一个问题：「这个目标还排着哪些，最早的是谁」。
CREATE INDEX agent_send_queue_target
  ON agent_send_queue(target_node_id, state, created_at);

-- 幂等键只在**还没投出去**的那些行上唯一：同一条重发要回原来那个 id，而一条
-- 已经投完的不该挡住下一条同 key 的新投递（§3.3 的 `--key`）。
CREATE UNIQUE INDEX agent_send_queue_key
  ON agent_send_queue(source_node_id, target_node_id, message_key)
  WHERE message_key IS NOT NULL AND state IN ('queued','delivering');
