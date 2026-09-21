-- 投递记录里补一列：这一条是**按哪种事实**放行或被拦下的（设计
-- docs/design/agent-delivery.md §4.3）。
--
-- `outcome` 回答的是「结果如何」（`delivered` / `queued` / `unknown`），它答不
-- 了「凭什么」。两条路都以 `delivered` 收尾而可信度完全不同：一条是目标自己
-- 报了 `idle`，另一条是我们看着它安静了三秒就投了进去（`startsSilently` 的
-- CLI 首投，以及显式 `--unverified`）。后者要在记录面板上看得出来，否则一次
-- 按观察放行的投递与一次有上报的投递在事后完全无法区分。
--
-- 值就是回执里的那个 `targetState`：五态之一，或者 `observed-quiet`。缺省是空
-- 串，所以既有的每一行含义不变——它们只是没有记过这件事。
ALTER TABLE agent_deliveries
  ADD COLUMN target_state TEXT NOT NULL DEFAULT '';
