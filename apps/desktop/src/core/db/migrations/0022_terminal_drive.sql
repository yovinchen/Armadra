-- 终端的驱动权代次（设计 docs/design/agent-delivery.md §6.2）。
--
-- 浏览器会话早就有这一列（`browser_sessions.lease_generation`），终端没有：
-- `terminal_sessions.generation` 是 **PTY 代次**——它在会话被回收、被换后端时
-- 变，说的是「这个 pane 后面还是不是同一个进程」。驱动权换手是另一件事：人
-- 按了接管、Agent 的租约到期、另一个人从另一台设备接手，PTY 一动不动。两个
-- 数混用的后果是一个旧客户端手里的号在一次回收之后又变成了当前的。
--
-- 租约本身只在内存里（§4.4）：core 重启之后没有人持有。存下来的只有这个计数
-- 器，于是重启后代次从它记得的数继续往上走，绕不回去。
ALTER TABLE terminal_sessions
  ADD COLUMN drive_generation INTEGER NOT NULL DEFAULT 0;
