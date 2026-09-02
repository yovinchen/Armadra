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
  "agent.allow": "允许",
  "agent.deny": "拒绝",
  "agent.launchFailed": "Agent 启动失败",

  /* 状态胶囊文案（§24.3-3：11px medium，不再全大写；中文界面就说中文） */
  "agent.state.working": "运行中",
  "agent.state.waiting": "需要你",
  "agent.state.blocked": "需要你",
  "agent.state.done": "已完成",
  "agent.state.errored": "已失败",
  "agent.state.interrupted": "已暂停",
} as const;

const en: Record<keyof typeof zh, string> = {
  "agent.restart": "Restart agent",
  "agent.permissionMode": "Permission mode",
  "agent.mode.default": "Default",
  "agent.mode.auto-edit": "Auto edit",
  "agent.mode.full-auto": "Full auto",
  "agent.mode.plan": "Plan",
  "agent.recycle": "Recycle session",
  "agent.allow": "Allow",
  "agent.deny": "Deny",
  "agent.launchFailed": "Could not start the agent",

  "agent.state.working": "Running",
  "agent.state.waiting": "Needs you",
  "agent.state.blocked": "Needs you",
  "agent.state.done": "Done",
  "agent.state.errored": "Turn failed",
  "agent.state.interrupted": "Paused",
};

export const agent: MessageModule = { "zh-CN": zh, en };
