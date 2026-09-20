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

  /* 投递与那一队（`agent-delivery.md` §10） */
  "delivery.queued": "排队 {count}",
  "delivery.queue.title": "排在这个终端前面的",
  "delivery.queue.empty": "队里是空的。",
  "delivery.queue.from": "{name} · 第 {position} 位 · {chars} 字",
  "delivery.queue.cancel": "拒收",
  "delivery.edge.last": "最近一次投递：{outcome} · {time}",
  "delivery.outcome.delivered": "已投递",
  "delivery.outcome.queued": "已排队",
  "delivery.outcome.unknown": "结果未知",
  "delivery.outcome.refused": "被拒",
  "delivery.notice": "「{source}」向「{target}」的投递被拦下：{reason}",
  "delivery.notice.open": "看看这两个节点",
  "delivery.palette.queue": "查看「{title}」的投递队列",
  "delivery.palette.takeover": "接管「{title}」的终端",
  "delivery.palette.release": "交还「{title}」的终端",

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

  "delivery.queued": "{count} queued",
  "delivery.queue.title": "Queued for this terminal",
  "delivery.queue.empty": "Nothing is queued.",
  "delivery.queue.from": "{name} · #{position} · {chars} chars",
  "delivery.queue.cancel": "Refuse",
  "delivery.edge.last": "Last delivery: {outcome} · {time}",
  "delivery.outcome.delivered": "Delivered",
  "delivery.outcome.queued": "Queued",
  "delivery.outcome.unknown": "Outcome unknown",
  "delivery.outcome.refused": "Refused",
  "delivery.notice":
    "A delivery from “{source}” to “{target}” was stopped: {reason}",
  "delivery.notice.open": "Show both nodes",
  "delivery.palette.queue": "Show the delivery queue for “{title}”",
  "delivery.palette.takeover": "Take over the terminal of “{title}”",
  "delivery.palette.release": "Hand back the terminal of “{title}”",

  "confirm.title": "An agent wants to close a node",
  "confirm.allow": "Allow",
  "confirm.deny": "Deny",
  "confirm.expired": "This request has expired.",
};

export const collab: MessageModule = { "zh-CN": zh, en };
