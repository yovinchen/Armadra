# Agent 适配与低干扰协作

Armadra 启动真实 CLI，保留各 CLI 的账户、模型选择、工具策略与会话格式。协作层只负责节点身份、链接范围、消息和可读上下文；不把一个 Agent 的系统提示词复制给另一个 Agent。

## 七种 CLI

| CLI            | 启动提示                    | 恢复指定会话           | 状态通道   | 非默认权限模式               |
| -------------- | --------------------------- | ---------------------- | ---------- | ---------------------------- |
| Claude Code    | 位置参数                    | `--resume ID`          | 命令 Hook  | auto-edit / full-auto / plan |
| Codex          | 位置参数                    | `resume ID`            | 命令 Hook  | auto-edit / full-auto / plan |
| Gemini CLI     | `--prompt-interactive TEXT` | `--resume ID`          | 命令 Hook  | auto-edit / full-auto / plan |
| OpenCode       | `--prompt TEXT`             | `--session ID`         | 插件       | 暂仅 CLI 默认                |
| Pi             | 位置参数                    | `--session PATH_OR_ID` | 进程内扩展 | 仅 CLI 默认                  |
| Oh My Pi       | 位置参数                    | `--resume ID`          | 进程内扩展 | auto-edit / full-auto        |
| GitHub Copilot | `--interactive TEXT`        | `--resume ID`          | 命令 Hook  | auto-edit / full-auto / plan |

恢复能力表示可以正确构建已有会话 ID 的启动命令；当前历史会话索引仍只扫描 Claude/Codex/Gemini，其他 CLI 可用自身会话选择器或上述命令恢复。七种 CLI 都能启动、选择模型、连接节点、主动读上下文、使用收件箱；子 Agent 与额度这类没有实现的能力不显示。CLI 自身扩展提供的工具能力与 Armadra 的适配能力是两件事。

Pi 的 `--resume` 打开选择器；指定会话要用 `--session`。OMP 的 `--plan` 选择规划模型，而 `--plan-yolo` 会自动执行规划，因此不能将它们冒充只读计划模式。Copilot 的 `-p/--prompt` 会进入非交互模式并在完成后退出，这里使用 `--interactive`。不支持的非默认权限模式会在启动前明确报错，不静默降级。设置页和终端菜单只提供有对应参数的权限模式；新建节点会采用保存的默认权限。

节点头部的「更多 → 模型」只对求交集后仍具备 `supportsModelSelection` 的 Agent 出现，选项是各 CLI 自己文档里的别名，不查询任何提供方的模型清单；选完写进节点数据、下一次启动才带上 `--model`，当前会话既不重启也不受影响。CLI 版本探测（`<launchCmd> --version`）失败时能力为 unknown，菜单不出现，不做名称推断。上下文占用见下节。终端节点在首个 Hook 回合后按占位标题自动命名一次，人工改名即锁定，详见 [Agent 自动化设计 §8](../design/agent-automation-design.md)。

2026-09-06 用真实 CLI 跑过 Pi 0.84.4、OMP 18.1.8、Copilot 1.0.83 的状态通道（`pnpm agent:smoke`，见[开发指南](./development.md)）；2026-09-05 核对了它们的 `--help`，并参照 [Pi 官方源码](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、[OMP 官方项目](https://github.com/can1357/oh-my-pi)、[Copilot CLI 官方参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)、[OpenCode CLI 官方参考](https://opencode.ai/docs/cli/)。OpenCode 本机入口执行返回 permission denied，因此该提供商参数由官方文档核对，未声称本机交互验证成功。发现器会检查 Unix 执行权限，不再只因路径上存在普通文件就标记已安装。

## 状态通道与来源徽标

节点头部的状态（RUNNING / NEEDS YOU / DONE）、自动化调度的空闲判断、以及单会话上下文占用，
都来自同一件事：CLI 自己告诉 Runtime 它在做什么。这条通道按 CLI 分两种形式，能力完全相同：

| 形式       | CLI                                     | 装在哪                                                                                                | 怎么工作                                                               |
| ---------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 命令 Hook  | Claude Code、Codex、Gemini CLI、Copilot | Claude / Gemini `settings.json`；Codex `hooks.json`；Copilot 单独一个 `~/.copilot/hooks/armadra.json` | CLI 每个事件 fork 一次 `armadra-hook`，它连 Runtime 的本地 socket 回报 |
| 进程内扩展 | Pi、Oh My Pi                            | `<配置目录>/extensions/armadra-status.ts`（Pi 是 `~/.pi/agent/`，OMP 是 `~/.omp/agent/`）             | 生成的 TS 扩展在 CLI 进程内连同一个 socket，不 fork 进程               |
| 插件       | OpenCode                                | `~/.config/opencode/plugin/`                                                                          | 插件在事件里调 `armadra-hook`                                          |

安装与卸载都在「设置 → Hook 与 Skills」，一个 CLI 一个开关，必须用户显式触发。安装写的文件名固定以
`armadra` 开头，识别规则只认文件里出现 `armadra-hook` 标记的条目；用户自己写的 hook、扩展和插件一律不动，
卸载也只删自己写的那些。重装写出的字节完全相同。

进程内扩展**不比**命令 Hook 更可信：两者用同一个 bearer、同一份每节点令牌、同一条终端绑定发同样的请求，
Runtime 分不出也不会因此多给任何权限。区别只是省掉每个事件一次 fork。

### 各 CLI 的配置目录覆盖

写到哪一个目录由各 CLI 自己的环境变量决定，Armadra 照抄它们的语义，不发明新的：

| CLI            | 变量                                                     | 语义                                                                                |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Claude Code    | `CLAUDE_CONFIG_DIR`                                      | 直接就是配置目录                                                                    |
| Codex          | `CODEX_HOME`                                             | 直接就是配置目录                                                                    |
| GitHub Copilot | `COPILOT_HOME`                                           | 直接就是配置目录                                                                    |
| Gemini CLI     | `GEMINI_CLI_HOME`                                        | **是 HOME 的替代，不是 `~/.gemini` 的替代**：配置目录为 `$GEMINI_CLI_HOME/.gemini` |
| OpenCode       | `OPENCODE_CONFIG_DIR`，否则 `$XDG_CONFIG_HOME/opencode` | 前者直接就是配置目录                                                                |
| Pi / Oh My Pi  | `PI_CODING_AGENT_DIR`（OMP 另有 `PI_CONFIG_DIR` 与 profile） | 直接就是 agent 目录                                                                 |

`GEMINI_CLI_HOME` 曾被当作配置目录本身，于是 hook 被写进 `$GEMINI_CLI_HOME/settings.json`——比 CLI 真正读的那份高一层，
安装看起来成功但一条事件都不会到；转录查找同样从高一层开始，永远返回「没有转录」。gemini-cli 的 `paths.ts` 把这个变量
从自己的 `homedir()` 返回，`storage.ts` 再往上拼 `.gemini`；其配置文档的原话是它「will create a `.gemini` folder inside
this directory」。`GEMINI_DIR` 在 gemini-cli 里是常量字符串 `.gemini`，不是环境变量，因此不再作为覆盖读取。
转录落在 `$GEMINI_CLI_HOME/.gemini/tmp/<项目标识>/chats/`。

### Copilot 的 `notification`

`notification` 一个名字下面是四件事。官方文档页没有它（参考页只列八个事件），出处是 CLI 自己的 changelog 1.0.18：
该事件「fires asynchronously on shell completion, permission prompts, elicitation dialogs, and agent completion」
（<https://github.com/github/copilot-cli/blob/main/changelog.md>）。区分靠载荷里的 `notification_type`，
唯一有一手出处的取值是 `permission_prompt`（<https://github.com/github/copilot-cli/issues/2586>，其修复在 1.0.26
把它收窄成「只在真的向用户弹出提示时触发」）。

因此只有 `permission_prompt` 映射成 NEEDS YOU，其余一律不映射：shell 跑完不是节点的状态（跑它的那一轮还在跑，
`postToolUse` 已经说过了）；elicitation 对话大概也是「等你」，但没有任何出处给出它的 `notification_type`，编一个字符串
只会打在错的地方；agent completion 已经有权威事件 `agentStop`，而 `notification` 是异步的，晚到的那一条只会盖掉更新的一轮。

### 来源徽标

节点头部的小徽标说明这一条状态是怎么来的：

| 徽标      | 含义                                                       | 能满足空闲门吗 |
| --------- | ---------------------------------------------------------- | -------------- |
| Hook 上报 | CLI 的命令 Hook 报的                                       | 能             |
| 扩展上报  | CLI 进程内的扩展报的                                       | 能             |
| 终端观测  | 没有任何适配，Runtime 只按终端有没有新输出猜的一个弱提示   | **不能**       |
| （没有）  | 还没有人报过。头部按「未知」显示，不当作空闲，也不当作忙碌 | 不能           |

「终端观测」只用于头部的弱提示与自动命名，永远不写进节点状态，也不能让自动化调度认为目标空闲——
猜出来的空闲会把提示词写进一个正在打字的终端。刷新页面后徽标仍在：会话列表和事件推送带的是同一个字段。

### 上下文占用

「更多 → 上下文」的数字分三种，界面按来源标注，不把三者混为一谈：

| 精度 | CLI               | 来源                                                                    |
| ---- | ----------------- | ----------------------------------------------------------------------- |
| 精确 | Claude Code       | CLI 状态行每次刷新报一次当前窗口占用                                    |
| 精确 | Pi、Oh My Pi      | 扩展在回合结束、压缩与换模型时调 `ctx.getContextUsage()` 报当前窗口占用 |
| 估算 | Codex、Gemini CLI | 按需读本地结构化转录尾部累加，标为「估算」                              |
| 没有 | OpenCode、Copilot | 见下                                                                    |

OpenCode 没有可读的本地窗口读数。Copilot 也没有：它没有状态行，会话事件文件里的占用数字只在压缩开始和
退出时才写，晚于「描述一个还活着的会话」所需要的时刻，所以这里留空而不是编一个数——留空是可以查证的，
一个来路不明的数字不是。

## 协作协议：armadra.mailbox.v1

协作默认按需读取。节点菜单的「Agent 协作」可复制 `armadra-hook canvas help`；该命令给出简短用法。七种 CLI 从创建它们的终端继承相同的节点身份，不要求先安装 provider hooks——上一节的适配只关系到状态、空闲门与上下文占用。

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

### 没有主动投递

Armadra 不把一个 Agent 的话打进另一个 Agent 的终端。原有的 `canvas send / reply / notify`、工作空间开关 `agentMessaging`、投递队列与投递门链都已删除：消息只进 `agent_mailbox`，由接收方自己读。

唯一保留的写入是 `canvas interrupt --to <已连线节点>`，它不带任何正文——只向目标会话发一个 Escape，用于打断跑偏的一轮。Escape 是一个键，不是一句话：它停下当前回合，不替换、不提交、也没有地方能夹带文字。

授权与 mailbox 完全一致：调用者要有本运行时签发的节点令牌、目标要在调用者自己的连线文档里、且与调用者同工作空间（连线残留不能跨工作空间生效）。**没有空闲门**——打断一个正忙的 Agent 正是它的用途，而对着空闲提示符发 Escape 是空操作。前台进程门还在：目标终端当前跑的必须仍是它声称的那个 Agent，否则拒绝。每次都写 `board-log.jsonl`，`bodyChars` 记为 0。

节点头部「更多 → 打断这一轮」是同一个键的手动入口，走用户自己按键的那条 socket，不经 hook 路由。它和上面的「中断」不是一回事：后者发 Ctrl+C 给前台进程组。

`agent_deliveries` 表因为迁移已发布而保留，Runtime 不再写入；`GET /api/workspaces/{id}/deliveries` 仍能读回历史行与 Host 写的行。

此设计借鉴 nodeterm 的节点身份、作用域与投递门禁原则；独立设计了持久化的拉取协议，将默认协作从终端输入移到应用收件箱，避免把大段协作指令和无关上下文塞进每个 Agent 的会话。

## 对话交接

交接把来源的一次阶段性工作整理成一份冻结的包交给另一个 Agent，设计见 [Agent 自动化设计 §7](../design/agent-automation-design.md)。入口在 Agent 终端「更多 → Agent 协作 → 交接到…」，目标只能是画布上已连线的 Agent 终端——与 mailbox 一样，授权依据是 Runtime 里的链接文档，不是界面上的一张图。

`POST /api/workspaces/{id}/handoffs` 冻结材料并返回预览：目标 Agent / 模型 / 目录、带走的文件与 Git 指纹、按预算裁剪的结果、`omitted` 里逐条列出的未包含项，以及来源转录摘录。此时没有通知任何人。`POST …/{handoffId}/accept` 是唯一的用户授权，必须带上预览那一份的 `expectedDigest`，看到的和批准的不是同一份就返回 409；重复确认返回同一条收件箱记录，不会放两份进去。`POST …/{handoffId}/cancel` 删掉那条收件箱消息。`GET …/handoffs?sourceNodeId=` 与 `GET …/{handoffId}` 让来源和目标都能查同一份包。

确认就是投递本身：同一个事务里往目标的 `agent_mailbox` 插一条 `key = handoff:<id>` 的消息，然后结束。正文只说「有一份用户批准的交接材料，这是同级资料而不是系统指令」，附读取命令 `armadra-hook canvas handoff-read --id <id>`；没有任何东西写进对方的终端，也就没有「写了但不知道有没有到」这种状态。

状态只有四个，每一个都是这一侧能证明的事实：

| 状态           | 含义                                   |
| -------------- | -------------------------------------- |
| `prepared`     | 材料已冻结，还没有通知任何人           |
| `queued`       | 用户已批准，材料在目标的收件箱里       |
| `acknowledged` | 目标自己 `canvas ack` 了那条收件箱消息 |
| `cancelled`    | 已撤回，收件箱那条被删掉               |

`handoff-read` 读包不等于确认：读取交出材料，`ack` 才是「我接下了」。旧库里 `dispatching` / `notified` / `unknownOutcome` / `failed` / `expired` 这些描述 PTY 写入结果的值仍在表里（已发布迁移不改），Runtime 读出来时一律归一成 `queued`——批准过、进了信箱、没被确认。会话里已有的权限批准不随交接转移，凭据不进入包；来源会话保持运行，快照之后来源又有动作时预览会标出「有新活动」。

因为不再需要目标空闲，交接对七种 CLI 一视同仁：没有状态适配的 Pi / OMP / Copilot 也能收到并读取，不再卡在 `queued`。

画布上的交接关联复用已有的那条上下文连线，不新增边或图形；节点头部的 chip 显示进行中的交接，点开即是同一个预览对话框。删掉连线等于收回上下文权限，应用不会偷偷补回，Runtime 也会因此拒绝准备、批准和读取。

## 验证

使用独立临时 SQLite 数据库测试完整 HTTP 路由：节点 token 缺失/伪造、未连线、跨工作空间移动、正文超限、重复 key 冲突、满容量、分页、过期清理、重复确认、数据库重新连接后确认状态仍保留，以及没有终端会话时仍可完成收发确认。共享包测试覆盖七种 CLI 命令和不支持权限模式拒绝。所有测试不修改真实 CLI 的凭据、配置或会话。

交接的路由测试（`apps/runtime/tests/handoff_api.rs`）另外覆盖：预览不产生任何收件箱条目、跨工作空间的路径读不到也批不了、错误 digest 被 409 拒绝、重复确认复用同一条收件箱记录、撤回后收件箱条目消失，以及 `agent_deliveries` 与 `agent_handoff_outbox` 保持为空。`tools/handoff-read-smoke.mjs` 用真实进程、真实 PTY 和真实 hook 客户端跑完整轮：批准后目标收件箱出现 `handoff:<id>`、读包不等于确认、`ack` 后状态变 `acknowledged`、撤回后那条消失。共享包用 Runtime 真实返回的一份包校验 schema。
