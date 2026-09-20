-- 连线的角色：对等，还是主从（设计 docs/design/agent-delivery.md §3.2 的延伸）。
--
-- 到 0023 为止一条边只有 `kind = 'link'`，而授权也只问一个问题：「有没有这条
-- 边」。有了 `send` 之后这个答案不够用了——把一段文字打进别人的终端并回车，在
-- 「我是你的主」和「我是你的下级」之间不该是同一件事。
--
-- `role` 是有方向的：`supervises` 表示 `source_node_id` 是主、`target_node_id`
-- 是从；`peer` 表示两端对等，也就是人在画布上拉一条线时的默认。缺省值是
-- `peer`，所以所有已经存在的边一条都不改变含义：它们本来就是对等的。
ALTER TABLE edges
  ADD COLUMN role TEXT NOT NULL DEFAULT 'peer';
