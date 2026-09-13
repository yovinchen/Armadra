# Agent 接入归一：MCP 做操作 API，Hook 只报事件

> 状态：目标设计（2026-09-08）。取代 [agent-collaboration-channels.md](./agent-collaboration-channels.md) §3.2 里「技能 + `armadra canvas` 动词」这一半；Hook 事件通道（§3.3）、Pi / OMP / OpenCode 的进程内扩展（§3.5）、`agent_mailbox` 与内容引用的契约（§4）不变。参照对象是 CleanCode 的原生 MCP（每个会话一个受控端点、按 Provider 在启动时注入、破坏性操作回到 UI 审批）。

## 1. 现状与问题

今天一个 CLI 要和画布打交道，要装两样东西，管三处状态：

| 层       | 机制                                                        | 落点                                                  | 问题                                                                                                     |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 事件上报 | Hook（`armadra-hook <agent>`）或进程内扩展                  | 各 CLI 的全局配置文件（`~/.claude/settings.json` 等） | 写进用户全局配置；旧产品名时期的条目（`aicc-hook`、`nodeterm`）没人清；Codex `hooks.json` 的 schema 变了 |
| 操作画布 | 技能 `armadra/SKILL.md` 教 CLI 去跑 `armadra-hook canvas …` | 各 CLI 的技能目录                                     | 靠模型「记得」用 CLI；参数拼写全凭文档；七种 CLI 的技能目录各不相同；旧技能（`aicc-canvas`）与新技能并存 |
| 协作     | 同上的 `post` / `inbox` / `link` / `handoff-read` 动词      | 同上                                                  | 与操作画布是同一套问题                                                                                   |

用户实测的结论：安装失败、CLI 找不到命令、连线后上下文不通；「能否归一成一种、统一管理」。

## 2. 结论

- **Agent → Armadra 只走 MCP。** 一个 stdio MCP 服务器 `armadra-hook mcp`（复用打包好的 `armadra-hook` 二进制，经 `hook-endpoint.env` 连 Runtime 的 `hook.sock`），把画布操作与协作暴露成工具。工具有类型、有描述，模型不需要背命令行；七种 CLI 都支持 stdio MCP。
- **Armadra ← Agent 只走 Hook / 扩展。** 状态、权限提示、会话生命周期是 MCP 观察不到的，这一半原样保留。
- **技能删除。** `SKILL.md`、技能安装接口、`SKILLS_REVISION`、设置页「协作技能」组全部移除；工具描述本身就是说明书。
- **注入尽量只在启动那一次。** 能用启动参数或会话级配置文件的 CLI（Claude、Codex 的 MCP、Copilot、OpenCode）不再改用户的全局配置；做不到的（Codex hooks.json、Gemini settings）继续写文件，但写法幂等、带标记、可修复。
- **一处管理。** 设置页「Hook 与 Skills」改为「集成」：每种 CLI 一行——注入方式、Hook 状态、MCP 状态、检测到的旧残留与「修复」按钮。
- 与 CleanCode 的区别保留：信箱、内容引用、交接都在 SQLite，重启不丢。

## 3. MCP 服务器

### 3.1 进程与身份

- 命令：`armadra-hook mcp`，stdio，JSON-RPC 2.0，实现 MCP `initialize` / `tools/list` / `tools/call`（协议版本按 2025-06-18；不做 resources / prompts / sampling）。
- 身份：Runtime 在拉起 CLI 时把 `ARMADRA_AGENT_SESSION`（会话 id）与 `ARMADRA_AGENT_TOKEN`（会话级令牌）放进子进程环境，MCP 子进程继承；每次调用都带上，Runtime 用它确定「调用者是哪个节点」，权限规则与现在的 `armadra-hook canvas` 完全相同（读别人的上下文要有连线，写只写自己）。
- 令牌是会话级、随会话重启轮换；没有令牌的调用一律拒绝，不回落到「猜测调用者」。

### 3.2 工具（v1）

| 工具                  | 对应现有动词 / 接口                        | 说明                                                                      |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `get_self`            | —                                          | 当前节点 id、标题、工作空间、连线邻居                                     |
| `list_nodes`          | `canvas` 板面读取（`control/board.rs`）    | 当前画布节点（id、类型、标题、Agent、状态）                               |
| `create_node`         | `create`                                   | `kind: terminal \| agent \| sticky`，`agent`、`title`、`prompt?`、`near?` |
| `link_nodes`          | `link`                                     | 建上下文连线（来源、目标）                                                |
| `rename_node`         | `rename`                                   | 标题 / handle                                                             |
| `interrupt_node`      | `interrupt`                                | 只发 Escape                                                               |
| `close_node`          | `close`                                    | **破坏性**：进 UI 审批（见 §3.3）                                         |
| `read_linked_context` | `context`（transcript / summary / screen） | 只允许有连线的目标                                                        |
| `post_message`        | `post --to`                                | 按名字寻址规则不变                                                        |
| `read_inbox`          | `inbox`                                    |                                                                           |
| `acknowledge`         | `ack`                                      |                                                                           |
| `read_handoff`        | `handoff-read`                             |                                                                           |

参数与返回都是 JSON Schema；错误用 MCP 的 `isError` + 文本，文本就是现有 `{code, message}` 的 message。

### 3.3 审批

破坏性工具（`close_node`，以及以后任何删东西的）不直接执行：Runtime 记一条待审批项，节点头部与通知里出现「Codex 请求关闭节点 X」，用户批准后执行，拒绝或超时（120 s）返回 `isError`。这与 CLI 自己的 `full-auto` 无关——CLI 放行的是「调用这个工具」，Armadra 放行的是「真的删」。

## 4. 各 CLI 的注入

| CLI           | MCP                                                | Hook / 扩展                                                      | 是否改全局配置                                   |
| ------------- | -------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| Claude Code   | `--mcp-config <会话临时文件>`                      | `--settings <会话临时文件>`（hooks 段）                          | 否                                               |
| Codex         | `-c mcp_servers.armadra.command=… -c …args=…`      | `~/.codex/hooks.json`（无启动参数），幂等写入、schema 按现行版本 | 只 hooks                                         |
| Gemini CLI    | `settings.json` 的 `mcpServers.armadra`            | `settings.json` 的 hooks                                         | 是（写在 `GEMINI_CLI_HOME/.gemini`，见 F2 修正） |
| OpenCode      | 会话配置文件（`OPENCODE_CONFIG`）里 `mcp.armadra`  | 进程内扩展（已有）                                               | 否                                               |
| Copilot       | `--additional-mcp-config` / 会话 `mcp-config.json` | 命令 Hook（已有）                                                | 否                                               |
| Pi / Oh My Pi | 扩展直接调用 Runtime（已有，不需要 MCP 子进程）    | 进程内扩展（已有）                                               | 否                                               |

每种 CLI 的注入方式、参数与核实出处写进 `hook/install/<cli>.rs` 顶部注释，与现在一样；临时文件放 `<data_dir>/sessions/<id>/`，会话结束删除。

## 5. 旧残留的清理（修复）

安装器新增 `repair`（设置页按钮 + 首次启动自动检测）：

- 识别：`~/.claude/settings.json` / `~/.codex/hooks.json` / `~/.gemini/settings.json` / OpenCode、Copilot 配置里指向 `aicc-hook`、`nodeterm`、`.nodeterm`、`target/debug/…` 的 hook 条目；技能目录 `aicc-canvas`、`aicc-linked-context`、`get-linked-context`、`manage-nodeterm-canvas`、旧 `armadra`；Codex `hooks.json` 顶层的 `version`。
- 动作：列出→备份原文件为 `<file>.armadra-backup-<时间戳>`→删条目 / 目录→按现行 schema 重写；只动我们认得的条目，其余原样。
- 报告：每种 CLI 一份 `{found, removed, kept, backup}`；设置页显示。

## 6. 数据与接口

- Runtime：`GET /api/agents/{id}/integration` → `{ mcp: {mode: "launch"|"file"|"extension", installed, path?}, hook: {…同现在…}, legacy: {found: [...]}, revision }`；`POST /api/agents/{id}/integration/repair`；`POST …/install` / `uninstall` 只剩 hook 那一半（文件型的）。技能相关接口与 `SKILLS_REVISION` 删除。
- Host 模式：agent 域的这些读写走现有 `ReadTranscript` 等同一条路（新增 `Integration` / `Repair` 两条，worker.proto 编号 +1）。
- `hook-endpoint.env` 不变；`armadra-hook mcp` 用它找 Runtime。

## 7. 不做

- 不做 MCP resources / prompts / sampling；不做远程（非本机）MCP。
- 不给 Agent 通用文件读写 / shell / PTY 输入——那是它自己的 CLI 的事。
- 不改 Hook 事件契约（`HOOK_CLIENT_REVISION` 不动）。

## 8. 验收

- 七种 CLI：`pnpm agent:smoke` 扩到「MCP 工具可列出、`get_self` 正确、`create_node` 在画布出现节点、`read_linked_context` 有连线才通、`close_node` 进审批」。
- 用户机器的旧残留样本（`aicc-hook`、`aicc-canvas`、Codex `version`）作为测试夹具，`repair` 后各 CLI 能正常启动。
- 设置页「集成」在打包版可用（走原生 Host 会话或 Runtime 直连均可）。
