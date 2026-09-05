import type { MessageModule } from "./index";

/**
 * 节点文案（v3，计划书 §3.4 / §14）。
 *
 * 两套语言都要维护：节点体一律 `useT()` 取串，切语言时整棵树重渲染。
 * `zh` 用 `as const` 是为了让 `en` 的键集合由类型系统兜住。
 */
const zh = {
  /* 节点类型（右键菜单 / Dock / 命令面板 / 无障碍名） */
  "node.terminal": "终端",
  "node.sticky": "便签",
  "node.group": "分组",
  "node.editor": "编辑器",
  "node.diff": "变更",
  "node.files": "文件",
  "node.browser": "浏览器",

  /* 外壳动作 */
  "node.collapse": "折叠",
  "node.expand": "展开",
  "node.maximize": "最大化",
  "node.restore": "还原",
  "node.close": "关闭",
  "node.color": "颜色",
  "node.title": "标题",
  "node.allow": "允许",
  "node.deny": "拒绝",
  "node.linkIn": "接收上下文",
  "node.linkOut": "发出上下文",

  /* 便签 */
  "sticky.placeholder": "写点什么…",

  /* 编辑器 */
  "editor.save": "保存",
  "editor.tooLarge": "文件过大",
  "editor.readonly": "只读",
  "editor.failed": "读取失败",
  "editor.download": "下载文件",
  "editor.dirty": "未保存",
  "editor.saveFailed": "保存失败",
  "editor.versionRequired": "服务未提供内容版本，仅可预览",
  "editor.conflict": "文件已被修改",

  /* 变更 */
  "diff.refresh": "刷新",
  "diff.clean": "无变更",
  "diff.worktree": "工作区",
  "diff.staged": "已暂存",
  "diff.binary": "二进制",
  "diff.failed": "读取失败",

  /* 文件 */
  "files.filter": "过滤",
  "files.root": "根目录",
  "files.failed": "读取失败",
  "files.status.M": "已修改",
  "files.status.A": "新增",
  "files.status.D": "已删除",
  "files.status.R": "已重命名",
  "files.status.?": "未跟踪",

  /* 浏览器 */
  "browser.address": "网址",
  "browser.back": "后退",
  "browser.forward": "前进",
  "browser.reload": "刷新",
  "browser.openExternal": "外部打开",
  "browser.preview": "预览",

  /* 图片 */
  "image.empty": "无图片",

  /* 画图（§21） */
  "draw.pen": "画笔",
  "draw.eraser": "橡皮",
  "draw.color": "颜色",
  "draw.undo": "撤销",

  /* 7 色调色板的无障碍名（§3.4） */
  "color.palette": "节点颜色",
  "color.blue": "蓝",
  "color.green": "绿",
  "color.yellow": "黄",
  "color.red": "红",
  "color.purple": "紫",
  "color.cyan": "青",
  "color.orange": "橙",

  /* 子代理卡片 */
  "subagent.fallback": "子代理",
  "subagent.working": "运行中",
  "subagent.done": "已完成",
  "subagent.tokens": "tokens",
  "subagent.toolUses": "工具",
  "subagent.transcript": "转录",
} as const;

const en: Record<keyof typeof zh, string> = {
  "node.terminal": "Terminal",
  "node.sticky": "Sticky",
  "node.group": "Group",
  "node.editor": "Editor",
  "node.diff": "Diff",
  "node.files": "Files",
  "node.browser": "Browser",

  "node.collapse": "Collapse",
  "node.expand": "Expand",
  "node.maximize": "Maximize",
  "node.restore": "Restore",
  "node.close": "Close",
  "node.color": "Colour",
  "node.title": "Title",
  "node.allow": "Allow",
  "node.deny": "Deny",
  "node.linkIn": "Context in",
  "node.linkOut": "Context out",

  "sticky.placeholder": "Write something…",

  "editor.save": "Save",
  "editor.tooLarge": "File too large",
  "editor.readonly": "Read-only",
  "editor.failed": "Read failed",
  "editor.download": "Download file",
  "editor.dirty": "Unsaved",
  "editor.saveFailed": "Save failed",
  "editor.versionRequired": "Preview only: content version unavailable",
  "editor.conflict": "The file changed on disk",

  "diff.refresh": "Refresh",
  "diff.clean": "No changes",
  "diff.worktree": "Working tree",
  "diff.staged": "Staged",
  "diff.binary": "Binary",
  "diff.failed": "Read failed",

  "files.filter": "Filter",
  "files.root": "Root",
  "files.failed": "Read failed",
  "files.status.M": "Modified",
  "files.status.A": "Added",
  "files.status.D": "Deleted",
  "files.status.R": "Renamed",
  "files.status.?": "Untracked",

  "browser.address": "Address",
  "browser.back": "Back",
  "browser.forward": "Forward",
  "browser.reload": "Reload",
  "browser.openExternal": "Open externally",
  "browser.preview": "Preview",

  "image.empty": "No image",

  "draw.pen": "Pen",
  "draw.eraser": "Eraser",
  "draw.color": "Colour",
  "draw.undo": "Undo",

  "color.palette": "Node colour",
  "color.blue": "Blue",
  "color.green": "Green",
  "color.yellow": "Yellow",
  "color.red": "Red",
  "color.purple": "Purple",
  "color.cyan": "Cyan",
  "color.orange": "Orange",

  "subagent.fallback": "Subagent",
  "subagent.working": "Working",
  "subagent.done": "Done",
  "subagent.tokens": "tokens",
  "subagent.toolUses": "tools",
  "subagent.transcript": "Transcript",
};

export const nodes: MessageModule = { "zh-CN": zh, en };
