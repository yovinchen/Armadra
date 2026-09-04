# Agent 能力、上下文、对话交接与后台自动化

> 状态：目标设计，待实施。Host/Worker 及协议边界见[服务端设计](./host-protocol-design.md)。

## 1. 能力继承与执行身份

适配器能力使用组合式接口，避免按 CLI 名称在每个 UI 分支硬编码：

```ts
interface AgentCapabilities {
  status: "hook" | "structured" | "unsupported";
  contextUsage: "reported" | "estimated" | "unsupported";
  transcript: "structured" | "text" | "unsupported";
  resume: boolean;
  nativeFork: boolean;
  nativeRecurrence: { observe: boolean; pause: boolean; cancel: boolean };
  structuredInputAck: boolean;
  supportsModelSelection: boolean;
}
```

这是领域形状示意；对外字段定义在 Protobuf 中。能力按内置基础适配器 → 自定义 Agent 配置 → CLI 版本探测 → 执行主机能力 → 项目授权求交集。未知能力不由名称推断为支持；自定义配置可以关闭能力，不能凭声明绕过版本探测。

配置继承：用户默认 → 项目默认 → worktree/Frame 默认 → 节点覆盖；既有 Session 保存启动快照，不随全局设置改变而热切身份。权限、模型、环境变量和账号分别合成并标出来源。环境变量只在 Worker 启动进程时解析，禁止写进共享画布和终端命令历史。

预留 `AccountRef { provider, accountId, executionHostId }` 与 `CredentialBinding { credentialRef, authorizationId }`。界面显示的 Agent 品牌不等于登录账号；节点可绑定账号但首期只有系统默认账号适配。后续多账号增加隔离配置目录与凭据管理，不修改 Session 的身份模型。

账号切换默认创建新的 SessionRun，显式提示是否恢复旧对话；不在运行中的 CLI 下替换认证文件。账号失效时用量及计划状态转为需处理，不能自动切到另一个账号消费额度。

## 2. 单会话上下文占用

### 2.1 数据模型与来源

`ContextUsage`：sessionId、generation、providerSessionId、modelId、usedTokens、capacityTokens、reservedOutputTokens、observedAt、source、quality、sourceRevision、compactionEpoch。

- source 为 provider_hook / structured_transcript / tokenizer_estimate / unavailable。
- quality 为 reported / estimated / stale / unknown。
- 分子是当前有效上下文占用，不是累计账单 token，不把缓存命中 token 再加一次。
- 分母来自该会话实际模型与配置的上下文上限；无法确认模型或上限时显示未知。
- 估算使用对应 tokenizer 或有依据的模型适配；不把“字符数/4”标成精确值。
- compaction、clear、resume、模型切换和 providerSessionId 改变时重置/更新来源，旧会话事件按 generation 丢弃。
- 来源异步到达时按 sourceRevision/observedAt 去重；未收到用量事件不能显示 0%。

### 2.2 界面

终端头部 `ContextUsageBadge` 显示模型简写、迷你进度与百分比；小尺寸只保留图标和数值。Popover 显示已用/上限、输出预留、采集时间、是否估算、压缩事件和来源。

80%/95% 为初始提醒阈值，可设置；只提示，不自动清理上下文或打断 CLI。达到阈值可以“准备交接”或调用适配器明确支持的压缩动作。额度面板仍独立显示账号限额，二者不能混用。

运行会话优先由 Hook/结构化事件更新，必要时节流读取转录；静止会话停止高频解析。手机焦点页使用相同数据与图例。

验收：长对话、压缩、模型切换、恢复旧会话、CLI 版本不支持、未知上限、延迟乱序事件、不同账号均显示正确来源；不存在精度不足却显示精确百分比的状态。

## 3. 原生活动卡片与平台计划节点

两者均为独立画布组件，使用不同实体，不复用任务卡片或 Kanban schema。

| 类型              | 所有者                      | 数据与动作                                                      | 页面关闭后                          |
| ----------------- | --------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| AgentActivityNode | CLI 内部 Loop/Cron/Schedule | 显示迭代、计划、父会话、最近结果；暂停/取消仅在适配器支持时开放 | CLI 与对应后端继续；观察器在 Worker |
| AutomationNode    | Go Host 的平台 Automation   | 创建、编辑、激活、暂停、立即运行、历史、关联目标                | Host 常驻调度，与客户端数量无关     |

原生活动 ID 采用 executionHost/session/generation/nativeJobId，不用标题作为去重键。Worker 持久化观察事件，Host 维护活动镜像；刷新页面从 Host 恢复。无法读取到的 CLI 内部计划不编造卡片。

活动卡片包含来源徽标、任务文字、循环次数/下次执行、最近事件、父节点定位、展开历史和备注。仅隐藏卡片不会取消原生计划；删除时提供“隐藏观察卡片”和“取消原生计划”不同操作，不支持取消时明确说明能力。

平台计划节点包含状态、执行 Host/时区、目标 Agent/终端、下次执行、最近结果、操作按钮、备注。节点只引用 automationId；关闭一个画布不取消计划。删除节点时可“移除展示，保留计划”或“停用并移除”；自动化面板始终可找回无节点计划。

同一原生任务不会自动复制成平台计划，否则会双重触发。显式“转为平台计划”时必须先确认原生任务已取消；不支持确认时只创建停用草稿。

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

## 8. 自动命名与 AI 文本生成

提供 `SuggestionService`，用于节点名称、会话名称和 Git commit message。配置默认 CLI/模型、语言、超时、最大输入及费用预算；不同场景使用独立模板。

命名输入为首条任务、有限转录及终端有效摘要；不把整段终端日志送出。AI 输出长度、换行和控制字符校验后作为候选。AI 不可用时沿用本地提取候选，并标记来源。

自动命名仅在 autoTitle=true 且仍为占位标题时应用；用户修改名称即锁定。按 session/generation/sourceRevision 缓存，一回合不重复调用；手动“重新生成”提供候选预览。生成过程中用户改名，结果只作为建议，不覆盖。

提交信息的 diff hash 和提交前复核规则见 [Git 设计](./git-github-design.md)。生成请求走 Worker 独立非交互 CLI，不向用户正在工作的终端偷偷输入命令。若 CLI 无安全的非交互入口，返回 unsupported 并允许选其他适配器。

## 9. API 与持久化

| 服务       | 主要命令                                          | 事件                                                    |
| ---------- | ------------------------------------------------- | ------------------------------------------------------- |
| Agent      | ResolveCapabilities、GetContextUsage、SuggestName | CapabilitiesChanged、ContextUsageChanged、NameSuggested |
| Activity   | List、Observe、Hide、NativePause/Cancel           | ActivityDiscovered、IterationChanged、ActivityStale     |
| Automation | Create、Update、Activate、Pause、RunNow、ListRuns | AutomationChanged、RunChanged、NextRunChanged           |
| Dependency | CreateGraph、Release、Cancel、Repair              | Waiting、Satisfied、Missing、Launched                   |
| Handoff    | Prepare、Preview、Accept、Get、Retry              | Prepared、Transferred、TargetStarted、Failed            |

Host 表：agent_capability_cache、context_usage、agent_activities、automations、automation_activations、automation_runs、dependencies、handoffs、suggestions。Worker 表：dispatch_receipts、hook_outbox。大量转录/附件落资产存储；数据库存引用、hash、权限和保留期。

## 10. 验收要点

- 不同基础适配器继承能力互不污染；版本降级后隐藏不可用动作，已存计划明确需处理。
- 刷新页面能找回原生活动和平台运行历史，隐藏活动不取消循环。
- 零客户端依赖启动与定时运行通过；UI 不再是启动权威。
- 多个计划发往同一终端不会交错粘贴；未知投递结果能定位且不会自动重复。
- 上下文占用、账号额度、累计 token 三者分离；更新事件按 SessionRun 对齐。
- 跨 Agent/跨执行主机交接有完整包、预算和缺失材料报告；原会话不被意外结束。
- 自动命名、摘要和提交信息都标识生成来源，人工编辑优先级最高。
