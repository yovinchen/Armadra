import type { MessageModule } from "./index";

/**
 * Agent 协作文案（v3，计划书 §5.7 / §5.8 / §5.9）：派生边、子代理卡片、
 * 待启动 DAG、投递记录、关闭确认、工作区的互发消息开关。
 *
 * §14 规则 2：界面只出中文，`en` 仅作为键值留档。需要在非组件代码里取串时
 * 用 `collabText`（就是下面的 `zh` 对象），组件里一律走 `useT()`。
 */
const zh = {
  /* 派生边（§3.3） */
  "rope.waiting": "等待依赖",
  "rope.launched": "由它开出",
  "rope.subagent": "子代理",

  /* 子代理卡片（§5.9） */
  "subagent.card": "子代理卡片",
  "subagent.expand": "展开结果",
  "subagent.collapse": "收起结果",
  "subagent.noResult": "没有返回结果",

  /* 待启动（§5.8 的 --after DAG） */
  "launch.waiting": "等待依赖完成",
  "launch.stalled": "启动没有回执",
  "launch.manual": "立即运行",

  /* 投递记录（§5.7 第 10 条） */
  "delivery.title": "投递记录",
  "delivery.empty": "还没有投递",
  "delivery.close": "关闭",
  "delivery.from": "发送方",
  "delivery.to": "接收方",
  "delivery.outcome": "结果",
  "delivery.chars": "{count} 字",
  "delivery.outcome.delivered": "已送达",
  "delivery.outcome.queued": "已排队",
  "delivery.outcome.stalled": "没有回执",
  "delivery.outcome.expired": "已过期",
  "delivery.outcome.rateLimited": "过于频繁",
  "delivery.outcome.queueFull": "队列已满",
  "delivery.outcome.targetBusy": "对方在忙",
  "delivery.outcome.targetStatusUnverified": "对方状态未验证",
  "delivery.outcome.targetStatusStale": "对方状态过期",
  "delivery.outcome.targetNotAgentPane": "对方不是该 Agent",
  "delivery.outcome.targetGone": "对方已不在",
  "delivery.outcome.notPermitted": "未获授权",

  /* 关闭确认（§5.8） */
  "confirm.title": "Agent 请求关闭节点",
  "confirm.allow": "允许",
  "confirm.deny": "拒绝",
  "confirm.expired": "这个请求已经失效。",

  /* 设置 → 工作区 */
  "settings.agentMessaging": "允许 Agent 互发消息",
} as const;

const en: Record<keyof typeof zh, string> = {
  "rope.waiting": "Waiting on dependencies",
  "rope.launched": "Opened by",
  "rope.subagent": "Subagent",

  "subagent.card": "Subagent card",
  "subagent.expand": "Show result",
  "subagent.collapse": "Hide result",
  "subagent.noResult": "No result reported",

  "launch.waiting": "Waiting on dependencies",
  "launch.stalled": "Launch was not acknowledged",
  "launch.manual": "Run now",

  "delivery.title": "Delivery log",
  "delivery.empty": "Nothing delivered yet",
  "delivery.close": "Close",
  "delivery.from": "From",
  "delivery.to": "To",
  "delivery.outcome": "Outcome",
  "delivery.chars": "{count} chars",
  "delivery.outcome.delivered": "Delivered",
  "delivery.outcome.queued": "Queued",
  "delivery.outcome.stalled": "No receipt",
  "delivery.outcome.expired": "Expired",
  "delivery.outcome.rateLimited": "Rate limited",
  "delivery.outcome.queueFull": "Queue full",
  "delivery.outcome.targetBusy": "Target busy",
  "delivery.outcome.targetStatusUnverified": "Target status unverified",
  "delivery.outcome.targetStatusStale": "Target status stale",
  "delivery.outcome.targetNotAgentPane": "Target is not that agent",
  "delivery.outcome.targetGone": "Target gone",
  "delivery.outcome.notPermitted": "Not permitted",

  "confirm.title": "An agent wants to close a node",
  "confirm.allow": "Allow",
  "confirm.deny": "Deny",
  "confirm.expired": "This request has expired.",

  "settings.agentMessaging": "Let agents message each other",
};

export const collab: MessageModule = { "zh-CN": zh, en };
