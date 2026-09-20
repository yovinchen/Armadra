import type { MessageModule } from "./index";

/**
 * 自动化页与两种卡片的文案（自动化设计 §3 / §4，画布平台设计 §4）。
 *
 * 状态名逐条对应合并前 Protobuf 枚举的取值，不合并：「已投递」和「已成功」必须能分开，
 * 「结果未知」不能写成失败。reasonCode 是机器码，界面原样显示不翻译。
 */
const zh = {
  /* 页与入口 */
  "automation.title": "自动化",
  "automation.open": "打开自动化",
  "automation.tab.plans": "计划",
  "automation.tab.runs": "运行历史",
  "automation.tab.create": "新建计划",
  "automation.reload": "刷新",
  "automation.empty": "这个工作空间还没有计划",
  "automation.emptyRuns": "这个计划还没有运行记录",
  "automation.more": "加载更多",
  "automation.loading": "正在读取",

  /* 不可用状态（§5：不出现伪按钮） */
  "automation.blocked.noWorkspace": "先打开一个工作空间",
  "automation.blocked.nativeSession":
    "桌面壳未能建立本机会话，原因见「设置 → 连接 → 后台服务」",
  "automation.blocked.disconnected": "连不上 Host",
  "automation.blocked.unsupported": "这个 Host 没有执行 Worker，无法运行计划",
  "automation.blocked.noSession": "这个 Host 不支持浏览器会话",
  "automation.blocked.signedOut": "这台设备还没有与 Host 配对",
  "automation.blocked.noPermission": "这台设备没有该工作空间的自动化权限",
  "automation.blocked.action": "前往设置 → 连接",
  "automation.readOnly": "只读权限：可以查看，不能创建或改动计划",

  /* 计划状态 */
  "automation.planState.unspecified": "未知",
  "automation.planState.draft": "草稿",
  "automation.planState.active": "已启用",
  "automation.planState.paused": "已暂停",
  "automation.planState.expired": "已结束",
  "automation.planState.deleted": "已删除",
  "automation.needsAttention": "需处理",
  "automation.needsAttentionNote":
    "目标连续拒绝执行，需要修复目标或重新定义计划",

  /* 计划字段 */
  "automation.schedule.once": "一次性",
  "automation.schedule.interval": "固定间隔",
  "automation.schedule.cron": "Cron",
  "automation.schedule.loop": "完成后循环",
  "automation.schedule.unknown": "未知计划类型",
  "automation.nextDue": "下次执行",
  "automation.lastRun": "最近运行",
  "automation.unknownTime": "未知",
  "automation.executionHost": "执行位置",
  "automation.target": "目标会话",
  "automation.timezone": "时区",
  "automation.revision": "版本",
  "automation.configVersion": "配置版本",
  "automation.configSha": "配置摘要",

  /* 动作 */
  "automation.activate": "启用",
  "automation.pause": "暂停",
  "automation.runNow": "立即运行",
  "automation.viewRuns": "查看运行历史",
  "automation.showOnCanvas": "在画布上显示",
  "automation.create": "创建",
  "automation.save": "保存新版本",
  "automation.edit": "编辑",
  "automation.editNote": "改动会保存为这个计划的新一版，仍是草稿。",
  "automation.editActiveNote":
    "这个计划正在运行中。保存新版本会作废当前激活，把它退回草稿——要重新启用才会继续执行。",
  "automation.savedDraft": "已保存为新版本；计划回到草稿，需要重新启用",
  "automation.runs.more": "加载更早的记录",
  "automation.runs.loading": "正在加载",
  "automation.cancel": "取消",
  "automation.confirmActivate": "启用这个计划？",
  "automation.confirmActivateNote":
    "启用会绑定你现在看到的这一版配置。之后任何编辑都会让它回到草稿。",
  "automation.confirmRunNow": "立即运行？",
  "automation.confirmRunNowNote":
    "这会额外排一次执行，不改动计划，也不跳过目标占用检查。",
  "automation.detach": "移除展示，保留计划",
  "automation.detachNote": "只从画布上拿掉这张卡片，计划继续在 Host 上运行。",
  "automation.disableAndDetach": "停用并移除",
  "automation.disableAndDetachNote": "先暂停计划，再从画布上移除这张卡片。",

  /* 创建向导 */
  "automation.wizard.location": "执行位置",
  "automation.wizard.currentHost": "当前 Host",
  "automation.wizard.session": "命令会话",
  "automation.wizard.existingSession": "使用已有会话",
  "automation.wizard.newSession": "定义新的命令会话",
  "automation.wizard.sessionId": "会话标识",
  "automation.wizard.rootPath": "工作目录（绝对路径）",
  "automation.wizard.executable": "可执行文件（绝对路径）",
  "automation.wizard.args": "参数（每行一个）",
  "automation.wizard.timeout": "超时（毫秒）",
  "automation.wizard.title": "计划名称",
  "automation.wizard.payload": "命令输入（stdin）",
  "automation.wizard.targetKind": "目标类型",
  "automation.wizard.targetKind.command": "非交互命令",
  "automation.wizard.targetKind.agent": "Agent 终端（写入提示词）",
  "automation.wizard.agentNode": "Agent 节点",
  "automation.wizard.prompt": "提示词",
  "automation.wizard.promptRequired": "写入 Agent 的计划必须填提示词",
  "automation.wizard.agentTargetRequired": "先选择一个 Agent 节点",
  "automation.wizard.coldStart": "会话不在时按冻结定义启动",
  "automation.wizard.coldStartNote":
    "不勾选时，节点上没有运行中的会话就跳过这次执行，不启动任何进程。",
  "automation.wizard.agentDeliveryNote":
    "只在前台是该 Agent、上一回合已结束且期间没有别的输入时投递；写入成功只表示已投递，不代表任务完成。",
  "automation.wizard.fromNative":
    "来源：原生活动卡片。确认后创建为草稿，原生循环不受影响，也不会自动启用。",
  "automation.wizard.scheduleKind": "计划类型",
  "automation.wizard.at": "执行时间",
  "automation.wizard.interval": "间隔（毫秒）",
  "automation.wizard.anchor": "锚点时间",
  "automation.wizard.cron": "Cron 表达式（五字段）",
  "automation.wizard.loopDelay": "完成后延迟（毫秒）",
  "automation.wizard.maxRuns": "最多运行次数",
  "automation.wizard.expiresAt": "截止时间",
  "automation.wizard.misfire": "错过执行",
  "automation.wizard.misfire.skip": "跳过",
  "automation.wizard.misfire.coalesce": "合并补跑一次",
  "automation.wizard.concurrency": "并发",
  "automation.wizard.concurrency.forbid": "禁止重叠",
  "automation.wizard.concurrency.queue": "排队一次",
  "automation.wizard.busyTtl": "目标忙时等待（毫秒）",
  "automation.wizard.loopBound": "完成后循环必须设置次数或截止时间之一",
  "automation.wizard.invalidCron": "Cron 表达式必须是五个字段",
  "automation.wizard.invalidTimezone": "请选择一个有效的 IANA 时区",
  "automation.wizard.invalidPath": "需要一个绝对路径",
  "automation.wizard.invalidTime": "请填写一个有效时间",
  "automation.wizard.invalidInterval": "间隔必须是正整数毫秒",
  "automation.wizard.created": "计划已创建为草稿，启用后才会执行",
  "automation.wizard.saved":
    "保存的是这个计划的新一版；保存后它回到草稿，重新启用才会继续执行。",
  "automation.wizard.editNote":
    "正在编辑一个已有的计划。保存会写入新一版并作废当前激活。",
  "automation.wizard.editTargetFrozen":
    "目标沿用这份计划冻结下来的那一个；换目标是另一件事，要新建一份计划。",
  "automation.wizard.payloadUnavailable":
    "读不到已存的内容，因此不能保存——否则会把提示词清空。",
  "automation.wizard.dialect.cron": "cron",
  "automation.wizard.dialect.launchd": "launchd",
  "automation.wizard.recurrenceTranslated":
    "已按下面这条原生规则预填日程；仍然由你确认后才创建草稿。",
  "automation.wizard.recurrence.unsupportedDialect":
    "不认识这种调度器，日程没有预填；下面是原文。",
  "automation.wizard.recurrence.unsupportedSyntax":
    "这条规则用到了平台计划没有的写法，硬凑会在边界上跑偏，所以没有预填；下面是原文。",
  "automation.wizard.recurrence.noSchedule":
    "这个任务靠事件触发，没有「多久跑一次」可翻；下面是原文。",
  "automation.wizard.recurrence.multipleTimes":
    "原生规则描述了多个时刻，一份计划只有一条重复规则——拆成几份由你决定；下面是原文。",
  "automation.wizard.recurrence.malformed":
    "这条规则读不出来，日程没有预填；下面是原文。",

  /* 运行历史 */
  "automation.run.scheduled": "计划时间",
  "automation.run.completed": "结束时间",
  "automation.run.attempts": "派发次数",
  "automation.run.receipt": "收据",
  "automation.run.reason": "原因",
  "automation.run.misfire": "补发",
  "automation.receipt.none": "无",
  "automation.receipt.queued": "已派发，等待收据",
  "automation.receipt.delivered": "已投递",
  "automation.receipt.settled": "已确认",
  "automation.runState.unspecified": "未知",
  "automation.runState.due": "待执行",
  "automation.runState.claimed": "已认领",
  "automation.runState.waitingTarget": "等待目标",
  "automation.runState.dispatching": "派发中",
  "automation.runState.delivered": "已投递",
  "automation.runState.running": "执行中",
  "automation.runState.succeeded": "已成功",
  "automation.runState.failed": "已失败",
  "automation.runState.cancelled": "已取消",
  "automation.runState.skipped": "已跳过",
  "automation.runState.expired": "已过期",
  "automation.runState.unknown": "结果未知",

  /* 失败分类 */
  "automation.error.invalid": "请求不合法",
  "automation.error.unauthenticated": "会话已失效，请重新配对",
  "automation.error.permission": "没有权限",
  "automation.error.unsupported": "这个 Host 不支持该操作",
  "automation.error.notFound": "计划或会话不存在",
  "automation.error.conflict": "计划已被改动，请刷新后重试",
  "automation.error.response": "Host 返回的内容无法解析",
  "automation.error.cancelled": "请求已取消",
  "automation.error.network": "请求失败",
  "automation.error.unknownOutcome": "结果未知，请刷新确认后再重试",

  /* 原生活动卡片 */
  "activity.title": "原生活动",
  "activity.source.loop": "CLI 循环",
  "activity.source.subagent": "子代理",
  "activity.readOnly": "只读观察",
  "activity.missingSource": "被观察的节点已不在这块画布上",
  "activity.iterations": "已观察 {count} 次",
  "activity.latest": "最近一次",
  "activity.none": "还没有观察到活动",
  "activity.hideOnly": "隐藏这张卡片不会取消 CLI 自己的循环",
  "activity.convert": "转为平台计划",
  "activity.convertNote":
    "会打开预填好的新建向导；确认后创建为草稿，需要再手动启用。原生循环不受影响，也不会被取消。",
  "activity.convertUnavailable": "被观察的节点上没有可作为目标的 Agent 会话",
  "activity.session": "会话",
  "activity.job": "任务标识",
  "activity.generation": "代次",
} as const;

const en: Record<keyof typeof zh, string> = {
  "automation.title": "Automation",
  "automation.open": "Open automation",
  "automation.tab.plans": "Plans",
  "automation.tab.runs": "Run history",
  "automation.tab.create": "New plan",
  "automation.reload": "Reload",
  "automation.empty": "No plans in this workspace yet",
  "automation.emptyRuns": "This plan has not run yet",
  "automation.more": "Load more",
  "automation.loading": "Loading",

  "automation.blocked.noWorkspace": "Open a workspace first",
  "automation.blocked.nativeSession":
    "The desktop shell could not open a local session; see Settings → Connection → Background service",
  "automation.blocked.disconnected": "Cannot reach the Host",
  "automation.blocked.unsupported":
    "This Host has no execution Worker, so it cannot run plans",
  "automation.blocked.noSession": "This Host has no browser session support",
  "automation.blocked.signedOut": "This device is not paired with the Host",
  "automation.blocked.noPermission":
    "This device holds no automation permission for this workspace",
  "automation.blocked.action": "Go to Settings → Connection",
  "automation.readOnly": "Read-only: plans can be viewed but not changed",

  "automation.planState.unspecified": "Unknown",
  "automation.planState.draft": "Draft",
  "automation.planState.active": "Active",
  "automation.planState.paused": "Paused",
  "automation.planState.expired": "Finished",
  "automation.planState.deleted": "Deleted",
  "automation.needsAttention": "Needs attention",
  "automation.needsAttentionNote":
    "The target refused repeatedly; repair it or redefine the plan",

  "automation.schedule.once": "Once",
  "automation.schedule.interval": "Interval",
  "automation.schedule.cron": "Cron",
  "automation.schedule.loop": "Loop after completion",
  "automation.schedule.unknown": "Unknown schedule",
  "automation.nextDue": "Next run",
  "automation.lastRun": "Last run",
  "automation.unknownTime": "Unknown",
  "automation.executionHost": "Execution host",
  "automation.target": "Target session",
  "automation.timezone": "Time zone",
  "automation.revision": "Revision",
  "automation.configVersion": "Config version",
  "automation.configSha": "Config digest",

  "automation.activate": "Activate",
  "automation.pause": "Pause",
  "automation.runNow": "Run now",
  "automation.viewRuns": "View run history",
  "automation.showOnCanvas": "Show on canvas",
  "automation.create": "Create",
  "automation.save": "Save new version",
  "automation.edit": "Edit",
  "automation.editNote":
    "Changes are stored as a new version of this plan, still a draft.",
  "automation.editActiveNote":
    "This plan is active. Saving a new version invalidates the current activation and returns it to draft — it runs again only once re-activated.",
  "automation.savedDraft":
    "Saved as a new version. The plan is a draft again and needs re-activating.",
  "automation.runs.more": "Load older runs",
  "automation.runs.loading": "Loading",
  "automation.cancel": "Cancel",
  "automation.confirmActivate": "Activate this plan?",
  "automation.confirmActivateNote":
    "Activation binds the exact configuration shown here. Any later edit returns it to draft.",
  "automation.confirmRunNow": "Run now?",
  "automation.confirmRunNowNote":
    "This queues one extra run. It does not edit the schedule or skip the target check.",
  "automation.detach": "Remove card, keep plan",
  "automation.detachNote":
    "Only takes the card off the canvas; the plan keeps running on the Host.",
  "automation.disableAndDetach": "Pause and remove",
  "automation.disableAndDetachNote":
    "Pauses the plan first, then removes the card from the canvas.",

  "automation.wizard.location": "Execution location",
  "automation.wizard.currentHost": "Current Host",
  "automation.wizard.session": "Command session",
  "automation.wizard.existingSession": "Use an existing session",
  "automation.wizard.newSession": "Define a new command session",
  "automation.wizard.sessionId": "Session id",
  "automation.wizard.rootPath": "Working directory (absolute path)",
  "automation.wizard.executable": "Executable (absolute path)",
  "automation.wizard.args": "Arguments (one per line)",
  "automation.wizard.timeout": "Timeout (ms)",
  "automation.wizard.title": "Plan name",
  "automation.wizard.payload": "Command input (stdin)",
  "automation.wizard.targetKind": "Target",
  "automation.wizard.targetKind.command": "Non-interactive command",
  "automation.wizard.targetKind.agent": "Agent terminal (write a prompt)",
  "automation.wizard.agentNode": "Agent node",
  "automation.wizard.prompt": "Prompt",
  "automation.wizard.promptRequired":
    "A plan that writes to an Agent needs a prompt",
  "automation.wizard.agentTargetRequired": "Choose an Agent node first",
  "automation.wizard.coldStart":
    "Start the frozen definition when no session is running",
  "automation.wizard.coldStartNote":
    "Left off, a run is skipped when the node has no running session; no process is ever started.",
  "automation.wizard.agentDeliveryNote":
    "Delivered only while that Agent is in the foreground, its last turn has finished and nothing else has been typed since. A written prompt means delivered, never finished.",
  "automation.wizard.fromNative":
    "From a native activity card. Confirming creates a draft; the CLI's own loop is untouched and nothing is enabled automatically.",
  "automation.wizard.scheduleKind": "Schedule",
  "automation.wizard.at": "Run at",
  "automation.wizard.interval": "Interval (ms)",
  "automation.wizard.anchor": "Anchor",
  "automation.wizard.cron": "Cron expression (five fields)",
  "automation.wizard.loopDelay": "Delay after completion (ms)",
  "automation.wizard.maxRuns": "Maximum runs",
  "automation.wizard.expiresAt": "Expires at",
  "automation.wizard.misfire": "Missed runs",
  "automation.wizard.misfire.skip": "Skip",
  "automation.wizard.misfire.coalesce": "Coalesce one",
  "automation.wizard.concurrency": "Concurrency",
  "automation.wizard.concurrency.forbid": "Forbid overlap",
  "automation.wizard.concurrency.queue": "Queue one",
  "automation.wizard.busyTtl": "Wait while the target is busy (ms)",
  "automation.wizard.loopBound":
    "A loop needs either a run count or an expiry date",
  "automation.wizard.invalidCron": "A cron expression needs five fields",
  "automation.wizard.invalidTimezone": "Pick a valid IANA time zone",
  "automation.wizard.invalidPath": "An absolute path is required",
  "automation.wizard.invalidTime": "Enter a valid time",
  "automation.wizard.invalidInterval":
    "The interval must be a positive number of milliseconds",
  "automation.wizard.created":
    "Created as a draft; it runs only once activated",
  "automation.wizard.saved":
    "Saves a new version of this plan. It returns to draft, and runs again only once you re-activate it.",
  "automation.wizard.editNote":
    "Editing an existing plan. Saving stores a new version and invalidates the current activation.",
  "automation.wizard.editTargetFrozen":
    "The target stays the one this plan froze. Pointing a plan somewhere else is a different decision — create a new plan for it.",
  "automation.wizard.payloadUnavailable":
    "The stored content could not be read, so this cannot be saved — doing so would blank the prompt.",
  "automation.wizard.dialect.cron": "cron",
  "automation.wizard.dialect.launchd": "launchd",
  "automation.wizard.recurrenceTranslated":
    "The schedule below was filled in from this native rule. It still becomes a draft only when you confirm.",
  "automation.wizard.recurrence.unsupportedDialect":
    "This scheduler is not one we can read, so nothing was filled in. Its rule is shown as written.",
  "automation.wizard.recurrence.unsupportedSyntax":
    "This rule uses something a platform schedule has no equivalent for, and an approximation would drift at the boundaries. Its rule is shown as written.",
  "automation.wizard.recurrence.noSchedule":
    "This job is triggered by events rather than on a period, so there is no “how often” to translate. Its rule is shown as written.",
  "automation.wizard.recurrence.multipleTimes":
    "The native rule names several times and one plan carries one recurrence. Splitting it is your decision; its rule is shown as written.",
  "automation.wizard.recurrence.malformed":
    "This rule could not be read, so nothing was filled in. It is shown as written.",

  "automation.run.scheduled": "Scheduled",
  "automation.run.completed": "Completed",
  "automation.run.attempts": "Dispatch attempts",
  "automation.run.receipt": "Receipt",
  "automation.run.reason": "Reason",
  "automation.run.misfire": "Misfire",
  "automation.receipt.none": "None",
  "automation.receipt.queued": "Dispatched, awaiting a receipt",
  "automation.receipt.delivered": "Delivered",
  "automation.receipt.settled": "Settled",
  "automation.runState.unspecified": "Unknown",
  "automation.runState.due": "Due",
  "automation.runState.claimed": "Claimed",
  "automation.runState.waitingTarget": "Waiting for target",
  "automation.runState.dispatching": "Dispatching",
  "automation.runState.delivered": "Delivered",
  "automation.runState.running": "Running",
  "automation.runState.succeeded": "Succeeded",
  "automation.runState.failed": "Failed",
  "automation.runState.cancelled": "Cancelled",
  "automation.runState.skipped": "Skipped",
  "automation.runState.expired": "Expired",
  "automation.runState.unknown": "Outcome unknown",

  "automation.error.invalid": "The request was not valid",
  "automation.error.unauthenticated": "The session expired; pair again",
  "automation.error.permission": "Not permitted",
  "automation.error.unsupported": "This Host does not support that",
  "automation.error.notFound": "The plan or session no longer exists",
  "automation.error.conflict": "The plan changed; reload and try again",
  "automation.error.response": "The Host's reply could not be read",
  "automation.error.cancelled": "The request was cancelled",
  "automation.error.network": "The request failed",
  "automation.error.unknownOutcome":
    "Outcome unknown; reload to check before retrying",

  "activity.title": "Native activity",
  "activity.source.loop": "CLI loop",
  "activity.source.subagent": "Subagent",
  "activity.readOnly": "Read-only observation",
  "activity.missingSource": "The observed node is no longer on this canvas",
  "activity.iterations": "{count} observed",
  "activity.latest": "Latest",
  "activity.none": "No activity observed yet",
  "activity.hideOnly": "Hiding this card does not cancel the CLI's own loop",
  "activity.convert": "Turn into a platform plan",
  "activity.convertNote":
    "Opens the create form pre-filled. Confirming saves a draft you still have to enable; the CLI's own loop is untouched and never cancelled.",
  "activity.convertUnavailable":
    "The observed node has no Agent session to target",
  "activity.session": "Session",
  "activity.job": "Job id",
  "activity.generation": "Generation",
};

export const automation: MessageModule = { "zh-CN": zh, en };
