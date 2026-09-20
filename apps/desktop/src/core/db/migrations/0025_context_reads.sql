-- 跨 Agent 上下文读取的游标与审计（设计 `docs/design/agent-delivery.md` §13）。
--
-- 到 0024 为止，一次 `context summary` 或 `context transcript` 是一次无记名、
-- 无上限、无记忆的全量读：每次都从头给一遍对方的转录原文。三个连线各读一次就
-- 是十几万 token，而且读第二次拿到的还是同一批内容。这张迁移给那条路补上它缺
-- 的两样东西。
--
-- ## `context_read_cursors`：读到哪了
--
-- 游标按「谁读谁」记，不按会话记：会话是对方那一侧的概念，而「我上次读到哪」
-- 是读者这一侧的事实。游标的内容是**转录文件路径 + 已读字节偏移**——路径是
-- 判据的一半，因为对方换了 session 就换了文件，那时候偏移没有意义，只能从头
-- 再读一遍（`collab/context-reads.ts::readCursor` 就是这么判的）。
--
-- 存字节偏移而不是「第 N 条」：转录是追加写的 JSONL，条数要重新解析整个文件
-- 才数得出来，而偏移是一次 `stat` 就能对上的数。
--
-- ## `context_reads`：读了多少
--
-- 每一次跨 Agent 读取写一行，不论成功与否给出了多少字节。它同时是两件事的依
-- 据：每条连线的读取预算（每分钟 64 KB、每小时 1 MB，见 §13 的限速表），以及
-- 节点头那一句「被读取 N 次」。
--
-- 索引按 `(target, at_ms)`：两个问题都是「这个节点最近被读了些什么」。预算那
-- 一侧还要按读者收窄，但那是同一个区间里的一次过滤，不值得第二条索引。
--
-- 行不清理：一行几十个字节，而「谁在读我」是一条用户会回头翻的记录。真要清
-- 的话按 `at_ms` 删，索引已经在那儿了。
CREATE TABLE context_read_cursors (
  reader_node_id  TEXT NOT NULL,
  target_node_id  TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  byte_offset     INTEGER NOT NULL DEFAULT 0,
  updated_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (reader_node_id, target_node_id)
);

CREATE TABLE context_reads (
  id             TEXT PRIMARY KEY,
  reader_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  verb           TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  at_ms          INTEGER NOT NULL
);

CREATE INDEX context_reads_target_at ON context_reads(target_node_id, at_ms);
