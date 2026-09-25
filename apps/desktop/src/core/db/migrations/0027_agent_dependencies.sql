-- Agent 依赖编排挪到 core（设计 docs/design/agent-automation-design.md §6）。
--
-- 此前 `open-agent --after A,B` 只往节点数据里写一份 `pendingLaunch`，由页面
-- 挂载那个节点时自己判定、自己敲启动行。页面没开，就没有人等，也没有人启动；
-- 判定用的是「现在是不是 done」，一条早就躺在那里的 done 会让它当场放行。
--
-- 两张表，因为一次等待有两个粒度：
--
--   * `agent_dependency_launches`：**一个下游节点**的那一次启动。它带着第一
--     条任务（`--task`）——任务在启动那一刻才进投递队列，排早了会在五分钟的
--     队列 TTL 里过期。`state` 只有三态：还在等、已经启动、启动失败。
--   * `agent_dependencies`：**一条边**，下游等上游的某一次结束。`condition`
--     是 `current`（上游手上这一轮）或 `next`（上游下一次成功结束）；创建时记
--     下上游的基准（状态、最后一次上报的时刻），之后只认基准之后的那次结束，
--     旧的 done 不会被重放成放行。`observed_busy` 是「基准之后见过它忙」：
--     过期扫描把 working 改成 done 时不一定挪 `last_event_at`，光比时刻会漏掉
--     这一次结束。
--
-- 失败、中断、退出、上游被删都**不**放行下游（`failed` / `missing`），过期是
-- `expired`；这三种都要人来处理——取消这条边之后，其余的边都满足了才启动。
-- 下游节点被删掉时由服务清掉它的行：节点在画布文档里，这里不挂外键。
CREATE TABLE agent_dependency_launches (
  node_id              TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  board_id             TEXT NOT NULL,
  task_body            TEXT,
  task_source_node_id  TEXT,
  task_hops            INTEGER NOT NULL DEFAULT 0,
  task_trail           TEXT NOT NULL DEFAULT '[]',
  state                TEXT NOT NULL DEFAULT 'waiting'
                       CHECK (state IN ('waiting', 'launched', 'failed')),
  reason               TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  session_id           TEXT,
  task_queue_id        TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  launched_at          INTEGER
);

CREATE INDEX agent_dependency_launches_workspace
  ON agent_dependency_launches(workspace_id, state);

CREATE TABLE agent_dependencies (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  downstream_node_id   TEXT NOT NULL
                       REFERENCES agent_dependency_launches(node_id)
                       ON DELETE CASCADE,
  upstream_node_id     TEXT NOT NULL,
  condition            TEXT NOT NULL CHECK (condition IN ('current', 'next')),
  baseline_state       TEXT,
  baseline_event_at    TEXT,
  observed_busy        INTEGER NOT NULL DEFAULT 0,
  state                TEXT NOT NULL DEFAULT 'waiting'
                       CHECK (state IN ('waiting', 'satisfied', 'failed',
                                        'missing', 'expired', 'cancelled')),
  reason               TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  resolved_at          INTEGER,
  UNIQUE (downstream_node_id, upstream_node_id)
);

-- 上游每报一次状态都要问一句「谁在等我」。
CREATE INDEX agent_dependencies_upstream
  ON agent_dependencies(upstream_node_id, state);
