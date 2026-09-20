import type { MessageModule } from "./index";

export const agentCapabilities: MessageModule = {
  "zh-CN": {
    "capability.title": "继承的能力",
    "capability.note":
      "仅继承基础适配器已有的能力，可关闭但不能额外授予。能力是否真的可用仍取决于实际 CLI 与执行主机。",
    "capability.probeUnknown": "未探测到 CLI 版本；未知能力不会显示对应操作。",
    "capability.name.hooks": "状态 Hook",
    "capability.name.resume": "恢复会话",
    "capability.name.subagent": "子 Agent",
    "capability.name.contextLink": "节点上下文链接",
    "capability.name.browser": "浏览器节点",
    "capability.name.usage": "账户用量",
    "capability.name.nativeRecurrence": "CLI 内置循环",
    "capability.name.structuredInputAck": "结构化投递回执",
    "capability.name.supportsModelSelection": "模型选择",
    "capability.source.base": "基础适配器",
    "capability.source.custom": "自定义配置",
    "capability.source.version": "CLI 版本探测",
    "capability.source.host": "执行主机",
    "capability.state.supported": "可用",
    "capability.state.unsupported": "不可用",
    "capability.state.unknown": "未知",
  },
  en: {
    "capability.title": "Inherited capabilities",
    "capability.note":
      "Inherits only existing base-adapter capabilities. You can disable them, not grant extra ones. Whether a capability truly works also depends on the CLI and the execution host.",
    "capability.probeUnknown":
      "The CLI version was not detected. Unknown capabilities show no controls.",
    "capability.name.hooks": "Status hooks",
    "capability.name.resume": "Resume session",
    "capability.name.subagent": "Subagents",
    "capability.name.contextLink": "Node context links",
    "capability.name.browser": "Browser nodes",
    "capability.name.usage": "Account usage",
    "capability.name.nativeRecurrence": "CLI-native loops",
    "capability.name.structuredInputAck": "Structured delivery receipts",
    "capability.name.supportsModelSelection": "Model selection",
    "capability.source.base": "Base adapter",
    "capability.source.custom": "Custom configuration",
    "capability.source.version": "CLI version probe",
    "capability.source.host": "Execution host",
    "capability.state.supported": "Available",
    "capability.state.unsupported": "Unavailable",
    "capability.state.unknown": "Unknown",
  },
};
