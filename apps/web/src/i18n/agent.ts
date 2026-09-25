import type { MessageModule } from "./index";

/**
 * Agent 文案（v3）。ACP 已删除；Agent 就是终端里跑的 CLI，
 * 这里只剩启动/权限/状态几个词（计划书 §5.1、§3.4）。
 */
const zh = {
  "agent.restart": "重启 Agent",
  "agent.permissionMode": "权限模式",
  "agent.mode.default": "默认",
  "agent.mode.auto-edit": "自动编辑",
  "agent.mode.full-auto": "全自动",
  "agent.mode.plan": "计划",
  "agent.recycle": "回收会话",
  "agent.model": "模型",
  "agent.modelDefault": "CLI 默认",
  "agent.modelHint":
    "仅对下一次启动的会话生效；当前会话保持不变，也不会被重启。",
  "agent.modelQueued": "下一次启动使用 {model}；当前会话不受影响。",

  /* 状态胶囊文案（§24.3-3：11px medium，不再全大写；中文界面就说中文） */
  "agent.state.working": "运行中",
  "agent.state.waiting": "需要你",
  "agent.state.blocked": "需要你",
  "agent.state.done": "已完成",
  "agent.state.errored": "已失败",
  "agent.state.interrupted": "已暂停",

  /* 状态来源（协作通道 §3.2 / §3.4）。前两个是同一份认证报告的两种传输，
     第三个是 PTY 侧的猜测，只作头部提示，不作任何判据。 */
  "agent.stateSource.hook": "Hook 上报", // i18n-exempt
  "agent.stateSource.hook.note": "状态来自 CLI 的 Hook 上报。", // i18n-exempt
  "agent.stateSource.extension": "扩展上报",
  "agent.stateSource.extension.note": "状态来自 CLI 进程内的扩展上报。",
  "agent.stateSource.observed": "终端观测",
  "agent.stateSource.observed.note":
    "没有适配器，状态由终端输出推测；交接与消息投递仍会被拒绝。",
} as const;

const en: Record<keyof typeof zh, string> = {
  "agent.restart": "Restart agent",
  "agent.permissionMode": "Permission mode",
  "agent.mode.default": "Default",
  "agent.mode.auto-edit": "Auto edit",
  "agent.mode.full-auto": "Full auto",
  "agent.mode.plan": "Plan",
  "agent.recycle": "Recycle session",
  "agent.model": "Model",
  "agent.modelDefault": "CLI default",
  "agent.modelHint":
    "Applies to the next session this node starts. The running session is unchanged and is not restarted.",
  "agent.modelQueued":
    "The next session will use {model}. The running one is unaffected.",

  "agent.state.working": "Running",
  "agent.state.waiting": "Needs you",
  "agent.state.blocked": "Needs you",
  "agent.state.done": "Done",
  "agent.state.errored": "Turn failed",
  "agent.state.interrupted": "Paused",

  "agent.stateSource.hook": "Reported by hook",
  "agent.stateSource.hook.note": "The state comes from the CLI's hooks.",
  "agent.stateSource.extension": "Reported by extension",
  "agent.stateSource.extension.note":
    "The state comes from an extension inside the CLI's own process.",
  "agent.stateSource.observed": "Observed in the terminal",
  "agent.stateSource.observed.note":
    "No adapter: the state is a guess from terminal output. Handoffs and message delivery are still refused.",
};

export const agent: MessageModule = { "zh-CN": zh, en };
