# Agent 能力、对话交接与后台自动化

> 状态：目标设计，部分实施。下文「实现状态」一节写于 Rust Runtime / Go Host 尚分进程的年代（2026-09-05 前后）；二者已于 R7d 合并进统一的 TS core（`apps/desktop/src/core/`，见 [typescript-core.md](typescript-core.md)），下文的 Runtime/Host/Worker 提法是彼时的实现分工，读作 core 内的对应模块即可。协议边界的历史记录见[服务端设计](../history/host-protocol-design.md)。

## 实现状态（截至 2026-09-05，实现分工已并入 core）

§1 能力交集已落地：能力表新增 `nativeRecurrence`、`structuredInputAck`、`supportsModelSelection`；求交集顺序为基础适配器 → 自定义配置 → CLI 版本探测 → 执行主机，实现在 `packages/shared/src/agent-capabilities.ts`，设置页的能力清单逐项显示裁决它的那一级。版本探测跑 `<launchCmd> --version` 并缓存到 `settings.agents.probes[<agentId>]`（core 的对应域模块，24 小时过期，换启动程序即重探）；探不到就是 `failed`，对应能力显示 unknown，界面不画按钮。`CAPABILITY_MIN_VERSION` 目前是空表——没有可引用的发行说明就不编版本门槛，探测眼下只提供「问不出来 → 不承诺」这一半。`nativeRecurrence` 仍无内置适配器声明：六种 CLI 都没有可读的任务列表。但**读得到规则的时候**有一层适配：活动卡片可以带一条 `nativeRecurrence { dialect, rule, timezone }`（`packages/shared/src/domain/node-data.ts`，原文逐字保存、不做规范化），`apps/web/src/panels/automation/native-recurrence.ts` 把 cron 表达式与 launchd 的 `StartCalendarInterval` / `StartInterval` 翻成平台计划的 recurrence 预填进向导。翻不动的一律返回机器码并把原文摆出来：`@reboot`（是事件不是周期）、带秒的六字段、`L`/`W`/`#` 扩展、只有事件触发的 launchd 任务、`StartCalendarInterval` 数组里的多个时刻（一份计划只有一条重复规则）、以及超出 Host 上下限的 interval。时区不猜——crontab 行不带时区、launchd 用本机时区，源头没写就留空由人选。执行主机方面，SSH 终端不带 `usage`（账号在对面机器上）。

§2 单会话上下文占用已于 2026-09-21 整条移除，不再是目标：读数、能力位、路由、Claude 状态行与 CLI 子命令都已删除，详见 §2。

§8 自动命名：Hook 报出本会话第一个回合后调一次 `suggest-title`，仅在标题仍是占位名时应用，用户改名即锁定，按 (节点, 会话, 代次) 缓存，请求期间被改名则丢弃结果；OSC 标题不覆盖自动命名写入的语义标题（`apps/web/src/meta/auto-title.ts`）。设置页有开关。普通终端不参与：`suggest-title` 要有 Agent 报来的会话身份，没有 Agent 的终端仍只跟随 OSC 标题。提交信息草稿新增语言（zh/en）与 Conventional Commits 选项，二者只追加固定的风格子句，不改变读取范围、文件排除、敏感行处理与 digest 复核。

§3 的两种卡片、§4 的平台计划与 §5 的投递已经能写进 Agent 终端，逐节的实施状态见下面各小节。§6 依赖编排已于 2026-09-25 挪进 core（`apps/desktop/src/core/dependencies/`，迁移 0027，路由见契约 `core-json-api.md` §8）：`--after` 写依赖表，条件满足时由 core 起终端、敲启动行、把第一条任务排进投递队列，页面没开也会启动；批量组队与多角度评审这一条组合操作仍未做。§9 其余服务的表与事件仍未实施。

## 1. 能力继承与执行身份

适配器能力使用组合式接口，避免按 CLI 名称在每个 UI 分支硬编码：

```ts
interface AgentCapabilities {
  status: "hook" | "structured" | "unsupported";
  transcript: "structured" | "text" | "unsupported";
  resume: boolean;
  nativeFork: boolean;
  nativeRecurrence: { observe: boolean; pause: boolean; cancel: boolean };
  structuredInputAck: boolean;
  supportsModelSelection: boolean;
}
```

这是领域形状示意；对外字段定义为 core 的 TypeScript 类型（无跨进程协议）。能力按内置基础适配器 → 自定义 Agent 配置 → CLI 版本探测 → 执行主机能力 → 项目授权求交集。未知能力不由名称推断为支持；自定义配置可以关闭能力，不能凭声明绕过版本探测。

配置继承：用户默认 → 项目默认 → worktree/Frame 默认 → 节点覆盖；既有 Session 保存启动快照，不随全局设置改变而热切身份。权限、模型、环境变量和账号分别合成并标出来源。环境变量只在 Worker 启动进程时解析，禁止写进共享画布和终端命令历史。

预留 `AccountRef { provider, accountId, executionHostId }` 与 `CredentialBinding { credentialRef, authorizationId }`。界面显示的 Agent 品牌不等于登录账号；节点可绑定账号但首期只有系统默认账号适配。后续多账号增加隔离配置目录与凭据管理，不修改 Session 的身份模型。

账号切换默认创建新的 SessionRun，显式提示是否恢复旧对话；不在运行中的 CLI 下替换认证文件。账号失效时用量及计划状态转为需处理，不能自动切到另一个账号消费额度。

预留部分已落地的：core 的 `AccountRef { accountId, providerId, label }` 与 `CredentialBinding { credentialRef, scope, authorizationId }` 类型；节点数据的 `agent.account`（`packages/shared/src/domain.ts`，可选、默认缺省，core 侧逐字段限长）。`agentSessionRequest`（`apps/web/src/agent/launch.ts`）只在字段存在时透传 `accountId`，`credentialRef` 不上行；命令会话对非 `default` 账号仍然显式拒绝。节点头部的 `AccountBindingBadge` 只在字段存在时出现，设置页没有绑定入口，core 把 `accountBinding` 报为 unsupported。账号的创建、列举与切换都未实现。

## 2. 单会话上下文占用（已移除）

2026-09-21 整条移除，不再是目标设计的一部分。移除的是：终端节点 `···` 里的「会话上下文」条目与诊断表、
`ContextUsage` 读数与其缓存、`contextUsage` 能力位、`GET …/nodes/{nodeId}/context-usage` 与
`/automation/session-context-usage` 两条路由、Pi / OMP 扩展里的 `ctx.getContextUsage()` 上报、
以及 Claude 的 `statusLine` 接入。

`armadra-hook context-usage` 保留为静默无操作并退出 0：老 `settings.json` 在修复跑到之前仍可能每次状态刷新
都调它，报错会刷屏。安装、修复与卸载都会把**认得出是我们写的**那条 `statusLine` 摘掉，别人自己的一律不动。

## 3. 原生活动卡片与平台计划节点

两者均为独立画布组件，使用不同实体，不复用任务卡片或 Kanban schema。

| 类型              | 所有者                      | 数据与动作                                                      | 页面关闭后                          |
| ----------------- | --------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| AgentActivityNode | CLI 内部 Loop/Cron/Schedule | 显示迭代、计划、父会话、最近结果；暂停/取消仅在适配器支持时开放 | CLI 与对应后端继续；观察器在 Worker |
| AutomationNode    | core 的平台 Automation 模块 | 创建、编辑、激活、暂停、立即运行、历史、关联目标                | core 常驻调度，与客户端数量无关     |

原生活动 ID 采用 executionHost/session/generation/nativeJobId，不用标题作为去重键。core 持久化观察事件并维护活动镜像；刷新页面从 core 恢复。无法读取到的 CLI 内部计划不编造卡片。

活动卡片包含来源徽标、任务文字、循环次数/下次执行、最近事件、父节点定位、展开历史和备注。仅隐藏卡片不会取消原生计划；删除时提供“隐藏观察卡片”和“取消原生计划”不同操作，不支持取消时明确说明能力。

平台计划节点包含状态、执行 Host/时区、目标 Agent/终端、下次执行、最近结果、操作按钮、备注。节点只引用 automationId；关闭一个画布不取消计划。删除节点时可“移除展示，保留计划”或“停用并移除”；自动化面板始终可找回无节点计划。

同一原生任务不会自动复制成平台计划，否则会双重触发。显式“转为平台计划”时必须先确认原生任务已取消；不支持确认时只创建停用草稿。

活动卡片上的“转为平台计划”按这条规矩实现：它不转换任何东西，只把创建向导预填好打开（表单顶部标明来源是原生活动卡片），由人确认后创建**草稿**。原生卡片和它观察的 CLI 循环原地不动，计划也不会被自动启用——六种 CLI 都没有可读的任务列表，「确认原生任务已取消」眼下只能由人做，界面把这句写在按钮下面而不是替用户假设。被观察的节点上没有可作为目标的 Agent 会话时按钮置灰并说明原因，而不是打开一个选不出目标的表单。

### 3.1 实施状态（2026-09-05）

`automation` 与 `agentActivity` 是两种独立节点类型，schema 与 Runtime 校验互不接受对方的 payload，不存在互相转换的路径。计划节点只存 `planId` / `planWorkspaceId` / `executionHostId`，外加仅供离线显示的计划类型与时区；状态、下次执行与最近收据每次从 Host 现读，读不到时显示原因而不是空计划。活动卡片绑定被观察的终端节点，数据取自现有 Hook 事件（agent status 与 subagent），只读，界面明说隐藏它不会取消 CLI 的循环。两者都没有上下文连线把手：内容不在画布上，连过去读不到东西。

计划级“需处理”已进入协议：`AutomationPlan` 新增 `needs_attention` / `attention_reason_code` / `attention_streak`（字段号 13–15，既有字段号未动）。连续两次 `TARGET_UNSUPPORTED` 或 `STALE_GENERATION` 才置位，只有观察到投递或重新定义计划才清除；暂停或过期不清除，因为它们无法证明目标已修好。计划自身的状态不被这个标记改写。

## 4. 平台自动化模型

`Automation` 至少包含：id、workspaceId、executionHostId、ownerId、revision、schedule、target、payloadRef、activationHash、enabled、timezone、misfirePolicy、concurrencyPolicy、busyPolicy、coldStartPolicy、retryPolicy、maxRuns、expiresAt、createdAt。

| 配置                | 默认与允许值                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| 计划类型            | Cron（五字段）、Interval、Once、LoopAfterCompletion                        |
| Cron                | IANA 时区，保存表达式及下五次执行预览；不使用客户端设备时区推断            |
| Interval            | 默认 anchored interval：以保存的 anchor 计算时隙；与执行结束后延迟循环分开 |
| LoopAfterCompletion | 完成后延迟；必须设置次数或截止时间之一，避免无边界自循环                   |
| 错过执行            | 默认 skip；可选 coalesce-one；不支持无限补跑                               |
| 并发                | 默认 forbid；可选 queue-one；同一目标共享投递门，不让多个计划交错输入      |
| Agent 忙时          | 默认排队至 idle-success，TTL 初始 5 分钟；blocked/unknown 不视为空闲       |
| 普通终端            | 仅确认处于 Shell 提示状态时执行；否则拒绝，不向任意 TUI 注入               |
| 目标不在线          | 默认 skip；显式启用可从冻结的 LaunchSpec 启动，前提是账号和审批策略支持    |
| 重试                | 仅明确未产生副作用的错误可重试；退避上限和次数固定，输入结果未知不自动重发 |
| 夏令时              | 不存在的本地时间跳过；重复本地时刻默认只运行第一次，key 含时区与本地时隙   |

Cron 正常触发、misfire 补发和一次性计划过期是三种记录，不混称成功。Interval 在运行中用单调时钟等待、用持久 UTC 锚点恢复；系统时钟回拨后仍按已记录时隙去重。

编辑表达式、内容、目标、身份、执行目录、授权、重试或补跑策略都使 activationHash 失效，计划回到 draft/needs-activation。共享项目导入的计划默认停用，机器本地 activation 不随项目同步。激活保存用户看到的确切 revision；每次派发再次检查该 revision 与授权。

### 4.1 实施状态（2026-09-05）

右侧工作面板的“自动化”页有计划、运行历史、新建计划三个页签，全部走 core 的 HTTPS 认证接口（复用设备会话的 Cookie、序列化队列与 CSRF）。创建向导把执行位置固定为当前 Host——计划只能派发到定义它的那台 Host，所以不提供一个必然失败的下拉；命令会话可选已有的或当场定义新的，五字段 cron、显式 IANA 时区、misfire/并发策略与“完成后循环必须有次数或截止时间”都在发出请求前校验。激活需要确认，确认框显示绑定的 revision、configVersion 与 config sha。运行历史逐条显示状态、收据阶段与派发次数：“已投递”与“已成功”分开，“结果未知”自成一行。“移除展示，保留计划”与“停用并移除”始终是两个按钮。

Host 未连接、未配对、没有执行 Worker 或设备没有该工作空间的自动化权限时，整页只显示原因与“前往设置 → 连接”，不渲染任何点了会失败的按钮；只读设备能看列表但没有管理按钮。

运行历史由 Host 分页，按时间倒序：run 本身仍按时隙 hash 存储，另有一份 `automation.run-history` 索引，键是 `<planId>/<倒序时刻>/<runId>`，与 run 同一个事务写入。于是一页确实是「再往前的 N 条」，游标确实是时间上的一个位置，客户端不再需要把全部翻回来自己排序。索引出现之前就存在的 run 由 `EnsureRunHistory` 在 Host 启动时一次性补投影（按工作空间打标记，只补不改），否则升级那一刻之前的历史会看起来像是被截断了。面板首屏取一页，其余由「加载更早的记录」显式请求。

编辑已有计划走的是同一个向导：读回配置填表，另调 `GetPayload` 读回已存的提示词——Host 把 payload 与配置分开存，读不回来就不允许保存，否则一次编辑会把提示词悄悄清空。保存即 `Define(expectedRevision)`，Host 按既有规则递增 `config_version`、作废激活、把计划退回草稿，因此「保存」永远不等于「重新启用」，界面明说这一点。目标不在编辑范围内：换目标要重新冻结 Agent 定义与代次，那是另建一份计划的决定，表单把它只读展示。

已知限制：编辑不改目标；`GetPayload` 需要 `automation:manage`，只读设备看不到已存内容。

### 4.2 目标为 Agent 终端（2026-09-06）

计划有两种目标，协议上分开：`AutomationTargetKind` 的 `NON_INTERACTIVE_COMMAND`（新建进程）与 `AGENT_SESSION_PROMPT`（往已经存在的 PTY 里写一段提示词）。字段未设置读作命令目标，所以此前冻结的计划不会因为加了这个字段就变成会往终端写字的东西。两者互不转换。

Agent 目标冻结的是**节点** + 一份 `AgentLaunchSpec`（agentId、目录、argv、权限模式、模型，只支持 `default` 账号）。这份定义**不能命名可执行文件**：程序由执行侧按 `agentId` 从自己的注册表和本机启动覆盖解析，一份存下来的计划因此永远变不成「运行这个二进制」。计划里的 `generation` 是定义时看到的那一代，只作记录：会话寿命归 Runtime，人重启 Agent 或授权的冷启动都会合法地换掉它，所以身份是节点加冻结定义，两者在每次探测和写入时各查一遍，收据里写明真正写进了哪个会话与代次。命令目标仍然严格按代次比对——那里的另一个代次就是另一个进程。

投递门：同一个节点的多份计划共用一道门（门按节点键，不按会话，否则冷启动一换会话就不再串行）。写入前要求前台确实是那个 Agent、上一回合已结束、期间没有别的输入；这三项由 Runtime 的 `paste_handoff` 同一段临界区判断。

传输复用的是 hook 客户端已经在用的那道门——同一份 `hook-endpoint.env`、同一个 Unix socket（或它发布的回环端口）、同一个 app bearer，不新开监听、不新造凭据（这条路径定于 Rust Runtime 与 Go Host 尚分进程的年代：当时选它是为了不让 Host 再对 Runtime 开一条新的认证通道，避免自己的配对、轮换与可达性；合并为 core 后投递与执行同在一个进程内，仍沿用同一套复用逻辑）。够不到目标会话时整条能力报 UNSUPPORTED，这是 core 已经会画的状态。

收据由 Runtime 持久化在 `agent_prompt_deliveries`，按 operationId 幂等，且**先写后投**：同一个 operationId 再来一次从表里回答，不会第二次粘贴；进程死在写入中途的行读回来是 unknown。阶段映射到自动化结果：`notWritten`（预检拒绝，唯一带「无副作用」证明的，可安全重试）→ NOT_DISPATCHED，`submitted` → DELIVERED（写进输入框不等于做完），`completed`（结束的那一回合期间没有别的输入，可归因）→ SUCCEEDED，`abandoned`（会话先结束了）→ FAILED，其余（包括「有人在我们之后打过字」）→ UNKNOWN，永不自动重发。

冷启动只在**目标探测**里发生，不在写入里：那时 run 已认领、授权刚复查过。会话不在时按冻结定义起一个新的（程序由 Runtime 解析，argv 逐个 shell 引用后写进去，所以计划里加不了 shell 操作符），把新会话写回节点的 `sessionId`，然后报 busy——刚起来的 Agent 还没启动完，更没有回合结束——于是真正碰 PTY 的那一步只对着 ready 的目标发生。同一节点 60 秒内不做第二次冷启动，起不来的 shell 不会变成起进程的循环。没开冷启动的计划遇到会话不在就 skip，不起任何进程。

验收：core 自动化模块的集成测试（设 `ARMADRA_TEST_REAL_WORKER` 与 `ARMADRA_TEST_REAL_HOOK` 后运行）跑真的 Once 计划 → 真的 core 自动化引擎 → 真的执行子进程 → 真的 PTY，断言的是那个伪 Agent 自己读到了提示词，以及运行记录写的是「已投递」而不是「已完成」。伪 Agent 的 idle 是它自己用真的 hook 客户端报的，测试里没有手写观测。

## 5. 调度执行、持久性与不确定结果

计划状态：draft → active ↔ paused → expired/deleted。运行状态：due → claimed → waiting-target → dispatching → delivered → running → succeeded/failed/cancelled；另有 skipped/expired/unknown。

1. Host 将 automationId/revision/scheduledSlot 唯一键写入运行表，事务认领并写 outbox；单实例锁仍需数据库唯一约束兜底。
2. 获取目标 Session 的写入门及当前 generation，核对在线、状态、权限、账号和工作目录。
3. 使用稳定 operationId 向 Worker 派发。Worker 持久化请求摘要、generation、执行阶段与收据，再操作后端。
4. 一段提示词以完整 framed paste 投递，提交键是同一串行临界区的后续动作，禁止逐行 Enter。
5. Hook 的下一回合必须与本次 run 关联；有结构化 request/turnId 优先使用。无法建立关联时保留 delivered/unattributed，不能仅凭某次 done 宣告成功。
6. 收到结构化完成事件后更新运行、消息与后继依赖，释放目标门；运行超时可以等待处理，不能擅自终止用户会话。

崩溃窗口必须明确：

| 崩溃位置                      | 恢复行为                                              |
| ----------------------------- | ----------------------------------------------------- |
| 认领前                        | 唯一时隙可重新认领                                    |
| outbox 已写、Worker 未接收    | 使用同一 operationId 安全重发                         |
| Worker 收到但确认尚未写入 PTY | 查收据后继续                                          |
| 已写入 PTY，但执行收据未完成  | 标记 UNKNOWN_OUTCOME；用户/结构化对账决定，不盲目重发 |
| 已触发 CLI，Host 未收到结果   | 重放 Worker/Hook outbox；如仍无法关联则待确认         |
| 计划被暂停/编辑，投递仍排队   | 派发前核对 revision，撤销旧队列项                     |

数据库可以保证同一时隙只创建一条 run；无法与任意终端进程建立原子事务，因此不承诺“任意 CLI 端到端恰好执行一次”。UI 不允许将“已投递”显示成“任务完成”。

关闭全部客户端的验收需要真实集成测试：启用一次性/循环计划 → 断开所有 UI → 等待 Host 调度 → 验证 Worker 收据和 CLI 输出 → 重新连接读取历史。另测 Host 重启、Worker 重启、暂停排队项、DST、睡眠恢复、网络恢复和目标已被删除。

## 6. 依赖编排迁移

现有 `--after` 行为移到 Host 的 DependencyService。图中每个依赖绑定 Session 或明确的完成里程碑，保存 generation/turn baseline；依赖满足一次后不能因历史 done 重放重复启动。

- 用户指定“当前这次工作结束”或“下一次成功结束”；创建时记录基准 turnId，避免对旧 done 误触发。
- failed、interrupted、unknown 不释放后继；目标删除默认转 dependency-missing，提供移除依赖或取消操作，不自动当成功。
- 检测环、跨工作空间/Host 无效引用、普通终端无状态来源、失效权限。
- UI 的 rope 边由服务状态派生；页面未打开也能创建、等待和启动目标。
- 批量组队和多角度评审作为组合操作：一个组、多个 LaunchSpec、依赖边和结果汇总。每个角色可指定 Agent/模型/worktree，不复制调度器。

## 7. 不同 Agent 间的对话交接

### 7.1 两种行为

同一 provider 支持原生 resume/fork 时，调用适配器的原生能力并显示方式。不同 provider 使用标准化交接包；不承诺无损转换私有会话格式，也不将外部材料伪装成目标 Agent 的系统消息。

默认“复制上下文并继续”：来源会话保留运行，目标单独创建。用户选择暂停来源时，需在来源回合边界执行；目标启动失败不关闭来源。

### 7.2 HandoffBundle

包含版本、handoffId、来源 provider/session/generation、截止 turnId/事件序号、用户目标、约束、已完成工作、未完成事项、关键决策、工具结果摘要、文件引用、Git HEAD/index/工作树摘要、worktreeId、来源链接、附件清单、来源身份、生成时间、摘要生成方式及截断报告。

每条引用包含执行主机、相对路径、内容 hash 和必要的文件版本。附件限大小并明确列出；跨主机时复制明确选择的文件快照，不能声称传送了未提交改动就完成代码同步。源代码的复制/分支同步是单独操作。

### 7.3 流程

1. Prepare：冻结边界，读取规范化转录及项目状态，计算目标可用上下文预算。
2. 构造固定段落；必要时由选择的 CLI 生成摘要。模型不可用时可提供原始摘录包，并标出未摘要和截断。
3. Preview：显示目标 Agent/模型/账号/目录、带走的文件、遗漏内容、估算 token；允许编辑交接指令。
4. Accept：记录授权和请求摘要，持久化 bundle；跨主机上传完整性校验后再启动目标。
5. Start：使用预算内的 bootstrap prompt 和项目内可读取的 bundle 引用启动；确认目标实际接收方式。
6. 记录 targetSessionId/operationId；画布显示交接关联边和“转到来源/目标”，双方可查交接包。

总预算为目标上下文容量减系统预留、工具预留和输出预留；上限未知时要求选择保守字节预算并标记估算。包含的文本按用户目标/约束、未完成工作、关键结论、证据优先裁剪，提供被裁剪清单。

会话里已有的权限批准不转移给目标，凭据不进入交接包；链接材料及转录中的指令保持为来源内容。启动幂等，失败重试复用同一 handoffId；来源仍在工作时显示“快照后有新活动”。

### 7.4 实施状态（2026-09-06）

交接历史面板按工作空间列出全部记录（`GET /api/workspaces/{id}/handoffs`，不带 `sourceNodeId` 即整块工作空间），一行给出状态、来源 → 目标、冻结与最近更新时间、投递尝试次数、队列状态与原因码。来源与目标读的是**冻结在包里**的身份，不重新解析当前画布：节点被删掉之后，这条记录仍然要说清当时是谁交给谁。原因码是机器码，原样显示不翻译；“已投递”“已确认”“写入结果未知”三种状态在文案上互不合并。入口在 Agent 终端的右键菜单，与发起交接的“交接到…”分开——面板只读，不发起任何交接。

投递尝试次数来自 `agent_handoff_outbox.attempts`（迁移 0006），在**认领**时自增，因此数的是尝试而不是成功：投递门证明的拒绝（目标忙、前台不是那个 Agent）会把通知退回队列，只看 `state` 分不出第一次和第二十次。

`armadra-hook canvas handoff-read` 的真实端到端由一个 smoke 测试脚本跑通：真的 core 进程、真的 PTY、真的节点令牌，用真的 hook 客户端读包并 ack。它断言三件事——目标读得到并且拿到的是标了 peer data 的资料；**读不等于确认**，读完状态仍不是 acknowledged；`canvas ack` 才是确认，且只有被寻址的那个会话能做（来源自己去读会被 403 拒绝）。

## 8. 自动命名与 AI 文本生成

提供 `SuggestionService`，用于节点名称、会话名称和 Git commit message。配置默认 CLI/模型、语言、超时、最大输入及费用预算；不同场景使用独立模板。

命名输入为首条任务、有限转录及终端有效摘要；不把整段终端日志送出。AI 输出长度、换行和控制字符校验后作为候选。AI 不可用时沿用本地提取候选，并标记来源。

自动命名仅在 autoTitle=true 且仍为占位标题时应用；用户修改名称即锁定。按 session/generation/sourceRevision 缓存，一回合不重复调用；手动“重新生成”提供候选预览。生成过程中用户改名，结果只作为建议，不覆盖。

提交信息的 diff hash 和提交前复核规则见 [Git 设计](./git-github-design.md)。生成请求走 Worker 独立非交互 CLI，不向用户正在工作的终端偷偷输入命令。若 CLI 无安全的非交互入口，返回 unsupported 并允许选其他适配器。

## 9. API 与持久化

| 服务       | 主要命令                                          | 事件                                                |
| ---------- | ------------------------------------------------- | --------------------------------------------------- |
| Agent      | ResolveCapabilities、SuggestName                  | CapabilitiesChanged、NameSuggested                  |
| Activity   | List、Observe、Hide、NativePause/Cancel           | ActivityDiscovered、IterationChanged、ActivityStale |
| Automation | Create、Update、Activate、Pause、RunNow、ListRuns | AutomationChanged、RunChanged、NextRunChanged       |
| Dependency | CreateGraph、Release、Cancel、Repair              | Waiting、Satisfied、Missing、Launched               |
| Handoff    | Prepare、Preview、Accept、Get、Retry              | Prepared、Transferred、TargetStarted、Failed        |

core 表（同一份数据库）：agent_capability_cache、agent_activities、automations、automation_activations、automation_runs、dependencies、handoffs、suggestions、dispatch_receipts、hook_outbox。大量转录/附件落资产存储；数据库存引用、hash、权限和保留期。

## 10. 验收要点

- 不同基础适配器继承能力互不污染；版本降级后隐藏不可用动作，已存计划明确需处理。
- 刷新页面能找回原生活动和平台运行历史，隐藏活动不取消循环。
- 零客户端依赖启动与定时运行通过；UI 不再是启动权威。
- 多个计划发往同一终端不会交错粘贴；未知投递结果能定位且不会自动重复。
- 账号额度与累计 token 分开；更新事件按 SessionRun 对齐。
- 跨 Agent/跨执行主机交接有完整包、预算和缺失材料报告；原会话不被意外结束。
- 自动命名、摘要和提交信息都标识生成来源，人工编辑优先级最高。
