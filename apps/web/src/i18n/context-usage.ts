import type { MessageModule } from "./index";

export const contextUsage: MessageModule = {
  "zh-CN": {
    "context.title": "会话上下文",
    "context.badge": "上下文 {value}",
    "context.unknown": "未知",
    "context.reported": "提供方报告",
    "context.estimated": "估算",
    "context.stale": "已过期",
    "context.model": "实际模型",
    "context.session": "终端会话",
    "context.providerSession": "提供方会话",
    "context.used": "当前输入占用",
    "context.capacity": "上下文容量",
    "context.reserved": "输出预留",
    "context.observed": "接收时间",
    "context.generation": "会话代次",
    "context.compaction": "已观测压缩次数",
    "context.revision": "来源序号",
    "context.source": "数据来源",
    "context.provider_hook": "提供方结构化状态栏",
    "context.structured_transcript": "结构化会话记录",
    "context.tokenizer_estimate": "分词器估算",
    "context.unavailable": "尚无可靠来源",
    "context.explanation":
      "占用是最近一次请求的输入、缓存写入与缓存读取 token 之和，不是累计账单。它不包含输出预留或尚未提交的新输入，不能代表全部可用预算。",
    "context.estimateNote": "此值为估算，可能遗漏工具、系统指令或隐藏开销。",
    "context.staleNote": "超过 5 分钟未收到新观测；显示的是上次记录。",
    "context.restartNote": "快照仅保存在运行期；服务重启后等待新的报告。",
    "context.awaiting_report":
      "等待本会话的结构化报告。旧终端可能需要重启才能绑定会话代次。",
    "context.awaiting_response":
      "提供方尚未报告当前用量；首次请求前或压缩后不会显示为 0%。",
    "context.unsupported": "此 Agent 暂无已接入的上下文来源。",
    "context.session_changed": "会话或代次已变化，等待新的报告。",
    "context.session_ended": "会话已经结束。",
    "context.source_unavailable": "无法读取当前上下文来源。",
    "context.statusLinePreserved":
      "已保留已有状态栏，上下文数据尚未连接。不会覆盖你的状态栏命令。",
    "context.setupNote":
      "Claude 通过安装 Hook 时添加的结构化状态栏上报；已有自定义状态栏会保留，此时上下文可能保持未知。",
    "context.high":
      "上下文占用已超过 {percent}%；请按需要检查会话。不会自动压缩或清空。",
    "context.critical":
      "上下文占用已超过 {percent}%；建议准备交接或使用适配器支持的压缩动作。应用不会替你执行。",
    "context.estimator": "估算方式",
    "context.estimateDetail":
      "启发式 {heuristic}，置信 {confidence}，已统计 {messages} 条会话消息。",
    "context.estimateFloor": "转录超出读取上限，结果为下限，实际占用可能更高。",
    "context.confidence.low": "低",
    "context.confidence.medium": "中",
    "context.thresholds": "上下文提醒阈值",
    "context.warnPercent": "提醒（%）",
    "context.dangerPercent": "警告（%）",
    "context.thresholdNote":
      "达到阈值只改变徽标措辞，不会自动压缩上下文或打断 CLI。警告值不会低于提醒值。",
    "context.capability.nativeRecurrence": "CLI 内置循环",
    "context.capability.structuredInputAck": "结构化投递回执",
    "context.capability.supportsModelSelection": "模型选择",
    "context.capabilitySource.base": "基础适配器",
    "context.capabilitySource.custom": "自定义配置",
    "context.capabilitySource.version": "CLI 版本探测",
    "context.capabilitySource.host": "执行主机",
    "context.capabilityState.supported": "可用",
    "context.capabilityState.unsupported": "不可用",
    "context.capabilityState.unknown": "未知",
    "context.probeUnknown": "未探测到 CLI 版本；未知能力不会显示对应操作。",

    "context.capabilities": "继承的能力",
    "context.capabilityNote":
      "仅继承基础适配器已有的能力，可关闭但不能额外授予。报告能力仍取决于实际 CLI 和已连接的数据来源。",
    "context.capability.hooks": "状态 Hook",
    "context.capability.resume": "恢复会话",
    "context.capability.subagent": "子 Agent",
    "context.capability.contextLink": "节点上下文链接",
    "context.capability.usage": "账户用量",
    "context.capability.contextUsage": "单会话上下文",
  },
  en: {
    "context.title": "Session context",
    "context.badge": "Context {value}",
    "context.unknown": "Unknown",
    "context.reported": "Provider reported",
    "context.estimated": "Estimated",
    "context.stale": "Stale",
    "context.model": "Actual model",
    "context.session": "Terminal session",
    "context.providerSession": "Provider session",
    "context.used": "Current input usage",
    "context.capacity": "Context capacity",
    "context.reserved": "Reserved output",
    "context.observed": "Received at",
    "context.generation": "Session generation",
    "context.compaction": "Observed compactions",
    "context.revision": "Source revision",
    "context.source": "Source",
    "context.provider_hook": "Provider structured status line",
    "context.structured_transcript": "Structured transcript",
    "context.tokenizer_estimate": "Tokenizer estimate",
    "context.unavailable": "No reliable source yet",
    "context.explanation":
      "Usage sums input, cache writes and cache reads from the latest request, not cumulative billing. It excludes output reserves and new unsent input, so it is not the full available context budget.",
    "context.estimateNote":
      "This estimate may omit tools, system instructions or hidden overhead.",
    "context.staleNote":
      "No new observation for over 5 minutes. The last record is shown.",
    "context.restartNote":
      "Snapshots live in memory and await a new report after the service restarts.",
    "context.awaiting_report":
      "Waiting for this session's structured report. Older terminals may need a restart to bind their generation.",
    "context.awaiting_response":
      "The provider has no current usage yet. Before the first response or after compaction, this is not 0%.",
    "context.unsupported": "This Agent has no connected context source yet.",
    "context.session_changed":
      "The session or generation changed. Waiting for a new report.",
    "context.session_ended": "This session has ended.",
    "context.source_unavailable": "Could not read the current context source.",
    "context.statusLinePreserved":
      "Your existing status line was preserved. Context reporting is not connected, and its command was not overwritten.",
    "context.setupNote":
      "Claude reports through the structured status line added during hook installation. Existing custom status lines are preserved, so context may remain unknown.",
    "context.high":
      "Context usage is over {percent}%. Review the session when needed; nothing is compacted or cleared automatically.",
    "context.critical":
      "Context usage is over {percent}%. Consider preparing a handoff, or a compaction action the adapter explicitly supports. Neither happens on its own.",
    "context.estimator": "Estimator",
    "context.estimateDetail":
      "Heuristic {heuristic}, {confidence} confidence, summed over {messages} transcript messages.",
    "context.estimateFloor":
      "The transcript exceeded the read budget, so this is a floor; actual usage may be higher.",
    "context.confidence.low": "low",
    "context.confidence.medium": "medium",
    "context.thresholds": "Context reminder thresholds",
    "context.warnPercent": "Remind at (%)",
    "context.dangerPercent": "Warn at (%)",
    "context.thresholdNote":
      "Crossing a threshold only changes what the badge says. Nothing is compacted and no CLI is interrupted. The warn value never drops below the reminder value.",
    "context.capability.nativeRecurrence": "CLI-native loops",
    "context.capability.structuredInputAck": "Structured delivery receipts",
    "context.capability.supportsModelSelection": "Model selection",
    "context.capabilitySource.base": "Base adapter",
    "context.capabilitySource.custom": "Custom configuration",
    "context.capabilitySource.version": "CLI version probe",
    "context.capabilitySource.host": "Execution host",
    "context.capabilityState.supported": "Available",
    "context.capabilityState.unsupported": "Unavailable",
    "context.capabilityState.unknown": "Unknown",
    "context.probeUnknown":
      "The CLI version was not detected. Unknown capabilities show no controls.",

    "context.capabilities": "Inherited capabilities",
    "context.capabilityNote":
      "Inherits only existing base-adapter capabilities. You can disable them, not grant extra capabilities. Reporting also requires a compatible CLI and connected source.",
    "context.capability.hooks": "Status hooks",
    "context.capability.resume": "Resume session",
    "context.capability.subagent": "Subagents",
    "context.capability.contextLink": "Node context links",
    "context.capability.usage": "Account usage",
    "context.capability.contextUsage": "Session context",
  },
};
