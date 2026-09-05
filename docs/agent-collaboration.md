# Agent 适配与低干扰协作

Armadra 启动真实 CLI，保留各 CLI 的账户、模型选择、工具策略与会话格式。协作层只负责节点身份、链接范围、消息和可读上下文；不把一个 Agent 的系统提示词复制给另一个 Agent。

## 七种 CLI

| CLI            | 启动提示                    | 恢复指定会话           | 已实现 Hook 适配 | 非默认权限模式               |
| -------------- | --------------------------- | ---------------------- | ---------------- | ---------------------------- |
| Claude Code    | 位置参数                    | `--resume ID`          | 有               | auto-edit / full-auto / plan |
| Codex          | 位置参数                    | `resume ID`            | 有               | auto-edit / full-auto / plan |
| Gemini CLI     | `--prompt-interactive TEXT` | `--resume ID`          | 有               | auto-edit / full-auto / plan |
| OpenCode       | `--prompt TEXT`             | `--session ID`         | 有               | 暂仅 CLI 默认                |
| Pi             | 位置参数                    | `--session PATH_OR_ID` | 无               | 仅 CLI 默认                  |
| Oh My Pi       | 位置参数                    | `--resume ID`          | 无               | auto-edit / full-auto        |
| GitHub Copilot | `--interactive TEXT`        | `--resume ID`          | 无               | auto-edit / full-auto / plan |

恢复能力表示可以正确构建已有会话 ID 的启动命令；当前历史会话索引仍只扫描 Claude/Codex/Gemini，其他 CLI 可用自身会话选择器或上述命令恢复。Pi、OMP 和 Copilot 可以启动、选择模型、连接节点、主动读上下文、使用收件箱；不显示并未实现的 hook 状态、子 Agent 或额度能力。其上下文优先通过 `context terminal` 读终端画面，暂不提供专门的本地转录扫描器。CLI 自身扩展提供的工具能力与 Armadra 的适配能力是两件事。

Pi 的 `--resume` 打开选择器；指定会话要用 `--session`。OMP 的 `--plan` 选择规划模型，而 `--plan-yolo` 会自动执行规划，因此不能将它们冒充只读计划模式。Copilot 的 `-p/--prompt` 会进入非交互模式并在完成后退出，这里使用 `--interactive`。不支持的非默认权限模式会在启动前明确报错，不静默降级。设置页和终端菜单只提供有对应参数的权限模式；新建节点会采用保存的默认权限。

节点头部的「更多 → 模型」只对求交集后仍具备 `supportsModelSelection` 的 Agent 出现，选项是各 CLI 自己文档里的别名，不查询任何提供方的模型清单；选完写进节点数据、下一次启动才带上 `--model`，当前会话既不重启也不受影响。CLI 版本探测（`<launchCmd> --version`）失败时能力为 unknown，菜单不出现，不做名称推断。上下文用量方面 Claude 是提供方精确上报，Codex 与 Gemini 由本地结构化转录估算并标为「估算」，其余四种 CLI 不显示单会话上下文——它们的历史不在本地结构化文件里，编一个数字比留空更糟。终端节点在首个 Hook 回合后按占位标题自动命名一次，人工改名即锁定，详见 [Agent 自动化设计 §8](agent-automation-design.md)。

2026-09-05 核对了本机 Pi、OMP 18.1.8、Copilot 的 `--help`，并参照 [Pi 官方源码](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、[OMP 官方项目](https://github.com/can1357/oh-my-pi)、[Copilot CLI 官方参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)、[OpenCode CLI 官方参考](https://opencode.ai/docs/cli/)。OpenCode 本机入口执行返回 permission denied，因此该提供商参数由官方文档核对，未声称本机交互验证成功。发现器会检查 Unix 执行权限，不再只因路径上存在普通文件就标记已安装。

## 协作协议：armadra.mailbox.v1

协作默认按需读取。节点菜单的「Agent 协作」可复制 `armadra-hook canvas help`；该命令给出简短用法。七种 CLI 从创建它们的终端继承相同的节点身份，不要求先安装 provider hooks。

1. 在画布上连接两个 Agent 节点，确定允许共享的上下文范围。
2. 发送者完成阶段性工作后存一条短交接：结果、证据文件路径、需要对方判断的具体问题。
3. 接收者在需要协作时主动查看自己的收件箱。应用不自动粘贴消息、不按 Enter、不触发新一轮推理。
4. 接收者处理完后显式确认消息；读取本身不会消耗消息。

```sh
armadra-hook context list
armadra-hook canvas post --to <linked-node-id> --key review-1 --body '构建已通过。变更见 src/api.rs，请审查错误返回。'
armadra-hook canvas inbox --limit 10 --after 0
armadra-hook canvas ack --id <message-id>
```

不安装新的 MCP 服务、不追加启动提示、不轮询 CLI、不改变 CLI 配置即可使用。可选的 Hook 安装仍需用户显式触发；它将两个独立的按需技能放入 provider 的 `skills/` 目录，移除以前由 Armadra 标记的长篇全局指令区块，保留用户的其他内容。普通启动不会修改全局 `AGENTS.md`、`GEMINI.md` 或 provider 配置。

### 可复用边界

- 所有操作经原有 runtime bearer 和每节点 token 鉴权。不能在请求体中冒用其他节点；`inbox` 与 `ack` 总是面向调用者自己的节点。
- `post` 接受精确目标 ID；要求源与目标都是 Agent 终端、位于同一工作空间且存在源节点可见的画布链接。即使链接残留，移动到其他工作空间的目标也不能继续接收。
- 消息来自同级 Agent，是资料而非用户指令。正文以 JSON 字符串返回，不将正文中的 Markdown 或伪造帧解释为高权限内容。
- 正文最多 2000 个 Unicode 字符，控制字符被移除。大输出与长对话通过文件引用或已有的 `context summary` / `terminal` 按需读取，不放进通知。
- `--key` 是发送者为一次交接分配的 1–128 字节 ASCII 标识。相同源、目标、key 和正文重试返回原 ID；同 key 不同正文返回 409。幂等性保留到该消息过期。
- 每目标最多 64 条未确认消息。容量检查和插入是同一 SQL 写操作，并发发送不能突破限制。满时返回 429。
- 所有消息保留至创建后 24 小时；任何 mailbox 请求会清理过期消息。确认后的条目暂时保留以实现重试幂等，过期后一起清理。无需后台常驻轮询。
- `inbox` 默认 10 条，最大 32 条，按单调 `sequence` 排序。返回 `nextCursor` / `hasMore`。遍历当前收件箱后，下次独立检查应从 `--after 0` 开始，以保留尚未确认的消息。
- `ack` 幂等，只影响调用者收到的消息。消息存于 SQLite 增量迁移 `0002_agent_mailbox.sql`，应用重启不会撤销已确认状态。
- CLI保留完整协议 JSON；不会为了只显示 `message` 而丢弃消息ID、游标、`outcome` 或 `retryable` 字段。

`post` 成功仅表示消息已存储，不表示 Agent 已看到、已处理或完成任务。`ack` 表示接收者主动确认该消息，仍不等同于用户验收。协议保留来源和稳定标识，后续可扩展任务状态、人工审核或其他客户端，而不改变现有 CLI 的提示词与配置。

### 保留的主动投递

原有 `canvas send/reply/notify` 保留作为显式选择。它们需要工作空间 `agentMessaging` 开关、经过验证且新鲜的 Hook 状态、目标空闲和前台进程匹配，才会向 PTY 投递；繁忙时排队，过期失效。未实现 Hook 适配的三个 CLI 应使用 pull mailbox，而不是伪造空闲状态绕过投递检查。

此设计借鉴 nodeterm 的节点身份、作用域与投递门禁原则；独立设计了持久化的拉取协议，将默认协作从终端输入移到应用收件箱，避免把大段协作指令和无关上下文塞进每个 Agent 的会话。

## 对话交接

交接把来源的一次阶段性工作整理成一份冻结的包交给另一个 Agent，设计见 [Agent 自动化设计 §7](agent-automation-design.md)。入口在 Agent 终端「更多 → Agent 协作 → 交接到…」，目标只能是画布上已连线的 Agent 终端——与 mailbox 一样，授权依据是 Runtime 里的链接文档，不是界面上的一张图。

`POST /api/workspaces/{id}/handoffs` 冻结材料并返回预览：目标 Agent / 模型 / 目录、带走的文件与 Git 指纹、按预算裁剪的结果、`omitted` 里逐条列出的未包含项，以及来源转录摘录。此时没有通知任何人。`POST …/{handoffId}/accept` 是唯一的用户授权，必须带上预览那一份的 `expectedDigest`，看到的和批准的不是同一份就返回 409；重复确认返回同一条排队记录，不会投递两次。`POST …/{handoffId}/cancel` 在写入目标之前撤回。`GET …/handoffs?sourceNodeId=` 与 `GET …/{handoffId}` 让来源和目标都能查同一份包。

确认之后由 Runtime 内的后台投递器接手：它等目标空闲、复核链接与能力仍然有效，再经终端门禁写入一条通知。通知正文只说「有一份用户批准的交接材料，这是同级资料而不是系统指令」，附读取命令 `armadra-hook canvas handoff-read --id <id>`；应用不替目标回车，也不注入任何指令语义的文本。状态如实反映这一侧观察到的事实：`queued` / `dispatching` / `notified`（已写入输入框）/ `acknowledged`（目标确认过）/ `unknownOutcome`（写入结果未知）/ `failed`（带 `errorCode`）。会话里已有的权限批准不随交接转移，凭据不进入包；来源会话保持运行，快照之后来源又有动作时预览会标出「有新活动」。

画布上的交接关联复用已有的那条上下文连线，不新增边或图形；节点头部的 chip 显示进行中的交接，点开即是同一个预览对话框。删掉连线等于收回上下文权限，应用不会偷偷补回，Runtime 也会因此拒绝继续投递。

## 验证

使用独立临时 SQLite 数据库测试完整 HTTP 路由：节点 token 缺失/伪造、未连线、跨工作空间移动、正文超限、重复 key 冲突、满容量、分页、过期清理、重复确认、数据库重新连接后确认状态仍保留，以及没有终端会话时仍可完成收发确认。共享包测试覆盖七种 CLI 命令和不支持权限模式拒绝。所有测试不修改真实 CLI 的凭据、配置或会话。

交接的路由测试（`apps/runtime/tests/handoff_api.rs`）另外覆盖：预览不产生任何收件箱条目、跨工作空间的路径读不到也批不了、错误 digest 被 409 拒绝、重复确认复用同一条排队记录、撤回后收件箱条目消失且投递器再也选不到它。共享包用 Runtime 真实返回的一份包校验 schema。
