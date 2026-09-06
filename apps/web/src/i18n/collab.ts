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

  /* 关闭确认（§5.8） */
  "confirm.title": "Agent 请求关闭节点",
  "confirm.allow": "允许",
  "confirm.deny": "拒绝",
  "confirm.expired": "这个请求已经失效。",
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

  "confirm.title": "An agent wants to close a node",
  "confirm.allow": "Allow",
  "confirm.deny": "Deny",
  "confirm.expired": "This request has expired.",
};

export const collab: MessageModule = { "zh-CN": zh, en };
