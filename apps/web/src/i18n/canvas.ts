import type { MessageModule } from "./index";

/**
 * 画布文案（v3，计划书 §3.2 / §3.3 / §13.3 / §14）。
 *
 * 菜单规格（`menus/add-menu.ts`）只描述键，翻译发生在渲染时——
 * 这样切语言时右键菜单、Dock `+`、命令面板三个入口一起变。
 */
const zh = {
  "canvas.expandMinimap": "展开缩略图",
  "canvas.collapseMinimap": "收起缩略图",
  "canvas.label": "画布",
  "canvas.importLimit":
    "每次最多 256 个文件，单个不超过 16 MB，总计不超过 64 MB",
  "canvas.importFailed": "文件导入失败",
  "canvas.importSaved": "文件已保存到原工作区；切换画板后未添加节点",
  "canvas.importFolderUnsupported": "请先拖入文件；文件夹导入尚未开放",

  /* 新建菜单（§13.3，画布右键 / Dock + / 会话侧栏 + 三个入口共用） */
  "add.terminal": "新建终端",
  "add.agent": "新建 {agent}",
  "add.sticky": "新建便签",
  "add.files": "新建文件管理器",
  "add.openFile": "打开文件…",
  "add.importFiles": "导入文件…",
  "add.browser": "新建浏览器",
  "add.automation": "新建定时计划",
  "add.agentActivity": "新建活动卡片",
  "add.notInstalled": "未安装",
  "add.noTerminal": "画布上还没有终端",
  "add.group.terminal": "终端",
  "add.group.agent": "AI 助手",
  "add.group.ssh": "远程终端",
  "add.group.content": "内容",
  "add.group.canvas": "画布操作",

  /* 白板工具（tldraw 计划 §5 的 Dock 工具组） */
  "tool.select": "选择",
  "tool.hand": "手形",
  "tool.draw": "画笔",
  "tool.highlight": "高亮",
  "tool.geo": "形状",
  "tool.line": "直线",
  "tool.arrow": "箭头",
  "tool.text": "文字",
  "tool.frame": "画框",
  "tool.image": "图片",

  "geo.rectangle": "矩形",
  "geo.ellipse": "椭圆",
  "geo.diamond": "菱形",
  "geo.triangle": "三角形",
  "geo.hexagon": "六边形",
  "geo.star": "星形",

  /* 白板 shape 的右键菜单 */
  "shape.bringToFront": "置顶",
  "shape.sendToBack": "置底",
  "shape.duplicate": "复制",
  "shape.delete": "删除",
  "shape.toSticky": "转成便签",

  /* 内容链接（白板图形连到节点，§6.3）的标题里用的类型名 */
  "content.text": "文字",
  "content.note": "便签",
  "content.group": "组合",
  "shape.referenceAgent": "引用到 Agent",
  "shape.referenceLimit":
    "每个 Agent 最多引用 {limit} 个对象，请先移除一条引用。",
  "shape.referenceSyncFailed": "引用尚未同步到 Agent",
  "shape.referenceSyncFailureNote":
    "已停止自动重试。检查 Runtime 连接后重新同步。",
  "shape.noAgents": "先创建一个 Agent 终端",
  "shape.refreshReference": "重新同步引用",
  "content.geo": "图形",
  "content.draw": "手绘",
  "content.image": "图片",
  "content.line": "直线",
  "content.highlight": "高亮",
  "content.frame": "画框",
  "content.shape": "白板内容",

  /* 空白右键的添加菜单里的白板项 */
  "add.text": "新建文字",
  "add.frame": "新建画框",

  /* 画布动作 */
  "canvas.selectAll": "全选",
  "canvas.fitView": "适应视图",
  "canvas.tidy": "整理画布",
  "canvas.lock": "锁定视图",
  "canvas.unlock": "解锁视图",
  "canvas.minimap": "缩略图",

  /* 节点右键菜单（§3.2）。折叠/展开/最大化/还原/颜色/分组这些名字
     归 `nodes.ts`——合并表是扁平的，同名键只能有一个出处。 */
  "node.joinGroup": "加入组",
  "node.leaveGroup": "移出组",
  "node.duplicate": "复制",
  "node.delete": "删除",

  /* 连线（§3.3；标签按被读取的那一端的类型，§21） */
  "edge.context": "⇄ 上下文",
  "edge.sticky": "🗒 便签",
  "edge.file": "文件",
  "edge.dir": "目录",
  "edge.web": "网页",
  "edge.diff": "差异",
  "edge.remove": "删除连线",
  "edge.selfLink": "不能连到自己",
  "edge.duplicate": "这两个节点已经连过了",

  /* 白板快照超过上限时的保存失败提示（tldraw 计划 §6.1） */
  "canvas.whiteboardTooLarge": "白板内容超出上限，未保存",

  /* 资产上传（tldraw 计划 §6.2，Phase 3 content） */
  "canvas.assetTooLarge": "图片超过 {limit} MB，没有添加",
  "canvas.assetFailed": "{name} 上传失败",

  /* 画布偏好菜单（右上工具簇的滑块钮，2026-09-05 用户反馈）。
     这一组对齐 tldraw 原生「偏好」子菜单，值全部存在 `preferences-store`
     的 `whiteboard` 段里，与设置 → 白板是同一份。 */
  "wb.menu": "画布偏好",
  "wb.snap": "始终吸附",
  "wb.toolLock": "工具锁定",
  "wb.grid": "显示网格",
  "wb.wrap": "选择换行",
  "wb.focus": "专注模式",
  "wb.edgeScroll": "边缘滚动",
  "wb.dynamicSize": "动态尺寸",
  "wb.pasteAtCursor": "粘贴至光标处",
  "wb.debug": "调试模式",
  "wb.theme": "主题",
  "wb.background": "画布背景",
  "wb.a11y": "辅助功能",
  "wb.enhancedA11y": "增强辅助模式",
  "wb.animation": "动画",
  "wb.input": "输入设备",
  "wb.input.auto": "自动",
  "wb.input.mouse": "鼠标",
  "wb.input.trackpad": "触控板",
  "wb.zoomInverted": "缩放方向反转",

  /* 删除确认：只有节点里跑着会话时才弹 */
  "delete.session.title": "结束会话并删除？",
  "delete.session.confirm": "删除",
  "delete.cancel": "取消",
} as const;

const en: Record<keyof typeof zh, string> = {
  "canvas.expandMinimap": "Expand minimap",
  "canvas.collapseMinimap": "Collapse minimap",
  "canvas.label": "Canvas",
  "canvas.importLimit": "Import up to 256 files, 16 MB each and 64 MB total",
  "canvas.importFailed": "File import failed",
  "canvas.importSaved":
    "Files saved in the original workspace; no nodes added after switching boards",
  "canvas.importFolderUnsupported":
    "Drop files for now; folder import is not available yet",

  "add.terminal": "New terminal",
  "add.agent": "New {agent}",
  "add.sticky": "New sticky",
  "add.files": "New file browser",
  "add.openFile": "Open file…",
  "add.importFiles": "Import files…",
  "add.browser": "New browser",
  "add.automation": "New scheduled plan",
  "add.agentActivity": "New activity card",
  "add.notInstalled": "Not installed",
  "add.noTerminal": "No terminal on this canvas",
  "add.group.terminal": "Terminal",
  "add.group.agent": "AI assistants",
  "add.group.ssh": "Remote terminals",
  "add.group.content": "Content",
  "add.group.canvas": "Canvas actions",

  "tool.select": "Select",
  "tool.hand": "Hand",
  "tool.draw": "Draw",
  "tool.highlight": "Highlight",
  "tool.geo": "Shape",
  "tool.line": "Line",
  "tool.arrow": "Arrow",
  "tool.text": "Text",
  "tool.frame": "Frame",
  "tool.image": "Image",

  "geo.rectangle": "Rectangle",
  "geo.ellipse": "Ellipse",
  "geo.diamond": "Diamond",
  "geo.triangle": "Triangle",
  "geo.hexagon": "Hexagon",
  "geo.star": "Star",

  "shape.bringToFront": "Bring to front",
  "shape.sendToBack": "Send to back",
  "shape.duplicate": "Duplicate",
  "shape.delete": "Delete",
  "shape.toSticky": "Convert to sticky",

  "content.text": "Text",
  "content.note": "Note",
  "content.group": "Group",
  "shape.referenceAgent": "Reference in agent",
  "shape.referenceLimit":
    "An agent can reference at most {limit} objects. Remove a reference first.",
  "shape.referenceSyncFailed": "References have not synced to the agent",
  "shape.referenceSyncFailureNote":
    "Automatic retries stopped. Check the runtime connection and sync again.",
  "shape.noAgents": "Create an agent terminal first",
  "shape.refreshReference": "Sync references again",
  "content.geo": "Shape",
  "content.draw": "Drawing",
  "content.image": "Image",
  "content.line": "Line",
  "content.highlight": "Highlight",
  "content.frame": "Frame",
  "content.shape": "Whiteboard content",

  "add.text": "New text",
  "add.frame": "New frame",

  "canvas.selectAll": "Select all",
  "canvas.fitView": "Fit view",
  "canvas.tidy": "Tidy",
  "canvas.lock": "Lock camera",
  "canvas.unlock": "Unlock camera",
  "canvas.minimap": "Minimap",

  "node.joinGroup": "Add to group",
  "node.leaveGroup": "Remove from group",
  "node.duplicate": "Duplicate",
  "node.delete": "Delete",

  "edge.context": "⇄ Context",
  "edge.sticky": "🗒 Sticky",
  "edge.file": "File",
  "edge.dir": "Folder",
  "edge.web": "Web page",
  "edge.diff": "Diff",
  "edge.remove": "Remove link",
  "edge.selfLink": "A node cannot link to itself",
  "edge.duplicate": "These two nodes are already linked",

  "canvas.whiteboardTooLarge": "Whiteboard is too large to save",

  "canvas.assetTooLarge": "Image is over {limit} MB and was not added",
  "canvas.assetFailed": "Could not upload {name}",

  "wb.menu": "Canvas preferences",
  "wb.snap": "Always snap",
  "wb.toolLock": "Tool lock",
  "wb.grid": "Show grid",
  "wb.wrap": "Select on wrap",
  "wb.focus": "Distraction-free",
  "wb.edgeScroll": "Edge scrolling",
  "wb.dynamicSize": "Dynamic size",
  "wb.pasteAtCursor": "Paste at cursor",
  "wb.debug": "Debug mode",
  "wb.theme": "Theme",
  "wb.background": "Canvas background",
  "wb.a11y": "Accessibility",
  "wb.enhancedA11y": "Enhanced accessibility",
  "wb.animation": "Animation",
  "wb.input": "Input device",
  "wb.input.auto": "Auto",
  "wb.input.mouse": "Mouse",
  "wb.input.trackpad": "Trackpad",
  "wb.zoomInverted": "Invert zoom direction",

  "delete.session.title": "End the session and delete?",
  "delete.session.confirm": "Delete",
  "delete.cancel": "Cancel",
};

export const canvas: MessageModule = { "zh-CN": zh, en };

/** 补齐当前 tldraw 中文词典缺失的键。 */
export const canvasEditorTranslations = {
  "zh-cn": { "comments.link-copied": "链接已复制" },
};
