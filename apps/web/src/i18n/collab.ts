import type { MessageModule } from "./index";

/**
 * Agent 协作文案（v3，计划书 §5.7 / §5.8 / §5.9）：子代理卡片、
 * 待启动 DAG、投递记录、关闭确认、工作区的互发消息开关。
 *
 * §14 规则 2：界面只出中文，`en` 仅作为键值留档。需要在非组件代码里取串时
 * 用 `collabText`（就是下面的 `zh` 对象），组件里一律走 `useT()`。
 */
const zh = {
  /* 子代理卡片（§5.9） */
  "subagent.card": "子代理卡片",
  "subagent.expand": "展开结果",
  "subagent.collapse": "收起结果",
  "subagent.noResult": "没有返回结果",

  /* 待启动（§5.8 的 --after DAG） */
  "launch.waiting": "等待依赖完成",
  "launch.manual": "立即运行",

  /* 依赖等待（Agent 自动化设计 §6）：等待与启动都归 core */
  "dependency.waiting": "等待 {names}",
  "dependency.separator": "、",
  "dependency.title": "启动前在等",
  "dependency.condition.current": "等它做完这一轮",
  "dependency.condition.next": "等它下一次成功结束",
  "dependency.state.waiting": "等待中",
  "dependency.state.satisfied": "已满足",
  "dependency.state.failed": "没有成功结束",
  "dependency.state.missing": "节点已删除",
  "dependency.state.expired": "等待已过期",
  "dependency.state.cancelled": "已取消",
  "dependency.launchFailed": "启动失败",
  "dependency.deleted": "已删除的节点",
  "dependency.cancel": "不等了，现在启动",

  /* 投递与那一队（`agent-delivery.md` §10） */
  "delivery.queued": "排队 {count}",
  "delivery.queue.title": "排在这个终端前面的",
  "delivery.queue.empty": "队里是空的。",
  "delivery.queue.from": "{name} · 第 {position} 位 · {chars} 字",
  "delivery.queue.cancel": "拒收",
  "delivery.recent.title": "最近投进来的",
  "delivery.recent.item": "{time} · {chars} 字",
  "delivery.basis.reported": "有上报",
  "delivery.basis.observed": "按观察放行",
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

  /* 被读取（阶段 C+，`agent-delivery.md` §10） */
  "contextReads.count": "被读取 {count} 次",
  "contextReads.title": "最近读过这个节点的",
  "contextReads.empty": "还没有记录。",
  "contextReads.entry": "{name} · {verb} · {bytes}",

  /* 节点的 Agent 设置（§10「节点设置」） */
  "agentSettings.title": "Agent 设置",
  "agentSettings.inboxWake": "收件箱唤醒",
  "agentSettings.inboxWake.off": "关",
  "agentSettings.inboxWake.notify": "提示",
  "agentSettings.inboxWake.deliver": "直接投递",
  "agentSettings.acceptSubDelivery": "允许从向我投递",
  "agentSettings.contextShare": "允许相连 Agent 读取转录",

  /* 关闭确认（§5.8） */
  "confirm.title": "Agent 请求关闭节点",
  "confirm.allow": "允许",
  "confirm.deny": "拒绝",
  "confirm.expired": "这个请求已经失效。",
} as const;

const en: Record<keyof typeof zh, string> = {
  "subagent.card": "Subagent card",
  "subagent.expand": "Show result",
  "subagent.collapse": "Hide result",
  "subagent.noResult": "No result reported",

  "launch.waiting": "Waiting on dependencies",
  "launch.manual": "Run now",

  "dependency.waiting": "Waiting for {names}",
  "dependency.separator": ", ",
  "dependency.title": "Waiting before launch",
  "dependency.condition.current": "Until it finishes this turn",
  "dependency.condition.next": "Until its next successful turn",
  "dependency.state.waiting": "Waiting",
  "dependency.state.satisfied": "Done",
  "dependency.state.failed": "Did not finish cleanly",
  "dependency.state.missing": "Node deleted",
  "dependency.state.expired": "Wait expired",
  "dependency.state.cancelled": "Cancelled",
  "dependency.launchFailed": "Launch failed",
  "dependency.deleted": "Deleted node",
  "dependency.cancel": "Stop waiting and launch",

  "delivery.queued": "{count} queued",
  "delivery.queue.title": "Queued for this terminal",
  "delivery.queue.empty": "Nothing is queued.",
  "delivery.queue.from": "{name} · #{position} · {chars} chars",
  "delivery.queue.cancel": "Refuse",
  "delivery.recent.title": "Recently delivered here",
  "delivery.recent.item": "{time} · {chars} chars",
  "delivery.basis.reported": "Reported",
  "delivery.basis.observed": "Observed only",
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

  "contextReads.count": "Read {count}×",
  "contextReads.title": "Recently read this node",
  "contextReads.empty": "Nothing recorded yet.",
  "contextReads.entry": "{name} · {verb} · {bytes}",

  "agentSettings.title": "Agent settings",
  "agentSettings.inboxWake": "Inbox wake",
  "agentSettings.inboxWake.off": "Off",
  "agentSettings.inboxWake.notify": "Notify",
  "agentSettings.inboxWake.deliver": "Deliver",
  "agentSettings.acceptSubDelivery": "Let subs type into my terminal",
  "agentSettings.contextShare": "Let linked agents read my transcript",

  "confirm.title": "An agent wants to close a node",
  "confirm.allow": "Allow",
  "confirm.deny": "Deny",
  "confirm.expired": "This request has expired.",
};

export const collab: MessageModule = { "zh-CN": zh, en };
