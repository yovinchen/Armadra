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

  /* 白板工具（React Flow 计划 F21 的 Dock 工具组） */
  "tool.select": "选择",
  "tool.hand": "手形",
  "tool.draw": "画笔",
  "tool.highlight": "高亮",
  "tool.geo": "形状",
  "tool.line": "直线",
  "tool.arrow": "箭头",
  "tool.text": "文字",
  "tool.import": "引入…",

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
  "content.frame": "画框",
  "content.shape": "白板内容",
  /* Frame 引用交给 Agent 的成员清单（canvas/frame-reference.ts） */
  "content.frameSummary": "画框「{title}」里的内容：",
  "content.frameEmpty": "画框「{title}」目前是空的。",
  "content.frameLine": "- {kind}：{text}",
  "content.frameLineBare": "- {kind}",
  "content.frameMore": "- 还有 {count} 项未列出",
  /* 画框清单里节点那几行的类型名 */
  "content.terminal": "终端",
  "content.editor": "文件",
  "content.diff": "差异",
  "content.files": "目录",
  "content.browser": "网页",
  "content.automation": "自动化",
  "content.agentActivity": "活动",

  /* B5 reference */
  "shape.removeReference": "移除引用",
  "shape.referenceExists": "已经引用过这个对象了",

  /* 空白右键的添加菜单里的白板项 */
  "add.text": "新建文字",
  "add.frame": "新建画框",
  "add.importMermaid": "导入 Mermaid…",

  /* 导入 Mermaid 对话框（design/mermaid-import.md §4.2 / §6） */
  "mermaid.title": "导入 Mermaid",
  "mermaid.description": "流程图落成可编辑的图形，其余图种落成图片。",
  "mermaid.source": "源码",
  "mermaid.preview": "预览",
  "mermaid.placeholder": "flowchart LR\n  A[开始] --> B[结束]",
  "mermaid.import": "导入",
  "mermaid.cancel": "取消",
  "mermaid.empty": "先粘贴或输入一段 Mermaid",
  "mermaid.errorAt": "第 {line} 行：{message}",
  "mermaid.renderFailed": "这张图渲染不出来",
  "mermaid.imported": "已导入 {count} 个对象",
  "mermaid.importedImage": "已按图片导入（{type} 暂不支持转成图形）",
  "mermaid.fileFailed": "读不到这个文件",

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

  /* 连线的角色：对等还是主从（`source` 是主）。 */
  "edge.role.title": "这条线的关系",
  "edge.role.peer": "对等",
  "edge.role.supervisesOption": "主 → 从",
  "edge.role.setPeer": "设为对等",
  "edge.role.setSupervises": "设为 主 → 从",
  "edge.role.setSupervisesReverse": "设为 从 ← 主",
  "edge.role.supervises": "主 @{supervisor} → 从 @{subordinate}",
  "edge.role.supervisorBadge": "主 · {count} 从",
  "edge.role.subordinateBadge": "从 @{name}",
  "edge.role.orphanBadge": "主已离开",

  /* 白板超过上限时的保存失败提示（React Flow 计划 F34） */
  "canvas.whiteboardTooLarge": "白板内容超出上限，未保存",

  /* 资产上传（React Flow 计划 F26） */
  "canvas.assetTooLarge": "图片超过 {limit} MB，没有添加",
  "canvas.assetFailed": "{name} 上传失败",

  /* 复制 / 剪切 / 粘贴的提示（React Flow 计划 F19）。
     `cmd.canvas.copy/cut/paste` 三条命令标签在 `i18n/commands.ts`，
     和命令表其余标签放在一起。 */
  "clipboard.copied": "已复制 {count} 项",
  "clipboard.cut": "已剪切 {count} 项",
  "clipboard.unavailable": "系统剪贴板不可用",

  /* 白板样式面板（React Flow 计划 F28） */
  "style.panel": "样式",
  "style.color": "颜色",
  "style.size": "粗细",
  "style.dash": "线型",
  "style.dash.solid": "实线",
  "style.dash.dashed": "虚线",
  "style.dash.dotted": "点线",
  "style.fill": "填充",
  "style.fill.none": "无填充",
  "style.fill.semi": "半透明",
  "style.fill.solid": "实心",
  "style.align": "对齐",
  "style.align.start": "左对齐",
  "style.align.middle": "居中",
  "style.align.end": "右对齐",
  "style.arrow": "箭头",
  "style.arrow.start": "起点箭头",
  "style.arrow.end": "终点箭头",

  /* 画布偏好菜单（右上工具簇的滑块钮，2026-09-05 用户反馈；F31）。
     值全部存在 `preferences-store` 的 `whiteboard` 段里，与设置 → 白板是
     同一份。换引擎删掉的四项（调试、增强辅助、缩放反转、风格档）连同
     文案一起删（§2.10）。 */
  "wb.menu": "画布偏好",
  "wb.snap": "始终吸附",
  "wb.toolLock": "工具锁定",
  "wb.grid": "显示网格",
  "wb.wrap": "整体框住才选中",
  "wb.focus": "专注模式",
  "wb.edgeScroll": "边缘滚动",
  "wb.dynamicSize": "动态尺寸",
  "wb.pasteAtCursor": "粘贴至光标处",
  "wb.animation": "动画",
  "wb.theme": "主题",
  "wb.background": "画布背景",
  "wb.input": "输入设备",
  "wb.input.auto": "自动",
  "wb.input.mouse": "鼠标",
  "wb.input.trackpad": "触控板",

  /* 删除确认：只有节点里跑着会话时才弹 */
  "delete.session.title": "结束会话并删除？",
  "delete.session.confirm": "删除",
  "delete.cancel": "取消",

  /* 在线设备与编辑租约（core JSON §9） */
  "presence.label": "在线设备",
  "presence.thisDevice": "本机",
  "presence.unnamed": "未命名设备",
  "presence.editing": "{device} 正在编辑",
  "presence.takeover": "接管",
  "presence.readOnly": "只读",
  "presence.takeoverTitle": "接管编辑？",
  "presence.takeoverDescription":
    "{device} 会变为只读，它还没保存的改动会丢失。",
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
  "tool.import": "Import…",

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
  "content.frame": "Frame",
  "content.shape": "Whiteboard content",
  "content.frameSummary": "Inside the frame \u201c{title}\u201d:",
  "content.frameEmpty": "The frame \u201c{title}\u201d is empty.",
  "content.frameLine": "- {kind}: {text}",
  "content.frameLineBare": "- {kind}",
  "content.frameMore": "- and {count} more",
  "content.terminal": "Terminal",
  "content.editor": "File",
  "content.diff": "Diff",
  "content.files": "Folder",
  "content.browser": "Web page",
  "content.automation": "Automation",
  "content.agentActivity": "Activity",

  /* B5 reference */
  "shape.removeReference": "Remove reference",
  "shape.referenceExists": "This object is already referenced",

  "add.text": "New text",
  "add.frame": "New frame",
  "add.importMermaid": "Import Mermaid…",

  /* Import Mermaid dialog */
  "mermaid.title": "Import Mermaid",
  "mermaid.description":
    "Flowcharts become editable shapes; other diagrams become an image.",
  "mermaid.source": "Source",
  "mermaid.preview": "Preview",
  "mermaid.placeholder": "flowchart LR\n  A[Start] --> B[End]",
  "mermaid.import": "Import",
  "mermaid.cancel": "Cancel",
  "mermaid.empty": "Paste or type some Mermaid first",
  "mermaid.errorAt": "Line {line}: {message}",
  "mermaid.renderFailed": "This diagram could not be rendered",
  "mermaid.imported": "Imported {count} objects",
  "mermaid.importedImage": "Imported as an image ({type} cannot become shapes)",
  "mermaid.fileFailed": "Could not read that file",

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

  "edge.role.title": "How these two relate",
  "edge.role.peer": "Peers",
  "edge.role.supervisesOption": "Lead → report",
  "edge.role.setPeer": "Make peers",
  "edge.role.setSupervises": "Make lead → report",
  "edge.role.setSupervisesReverse": "Make report ← lead",
  "edge.role.supervises": "Lead @{supervisor} → report @{subordinate}",
  "edge.role.supervisorBadge": "Lead · {count} reports",
  "edge.role.subordinateBadge": "Reports to @{name}",
  "edge.role.orphanBadge": "Lead is gone",

  "canvas.whiteboardTooLarge": "Whiteboard is too large to save",

  "canvas.assetTooLarge": "Image is over {limit} MB and was not added",
  "canvas.assetFailed": "Could not upload {name}",

  "clipboard.copied": "Copied {count} items",
  "clipboard.cut": "Cut {count} items",
  "clipboard.unavailable": "The system clipboard is unavailable",

  "style.panel": "Style",
  "style.color": "Colour",
  "style.size": "Weight",
  "style.dash": "Stroke",
  "style.dash.solid": "Solid",
  "style.dash.dashed": "Dashed",
  "style.dash.dotted": "Dotted",
  "style.fill": "Fill",
  "style.fill.none": "None",
  "style.fill.semi": "Semi",
  "style.fill.solid": "Solid",
  "style.align": "Align",
  "style.align.start": "Left",
  "style.align.middle": "Centre",
  "style.align.end": "Right",
  "style.arrow": "Arrows",
  "style.arrow.start": "Arrow at start",
  "style.arrow.end": "Arrow at end",

  "wb.menu": "Canvas preferences",
  "wb.snap": "Always snap",
  "wb.toolLock": "Tool lock",
  "wb.grid": "Show grid",
  "wb.wrap": "Select fully enclosed",
  "wb.focus": "Distraction-free",
  "wb.edgeScroll": "Edge scrolling",
  "wb.dynamicSize": "Dynamic size",
  "wb.pasteAtCursor": "Paste at cursor",
  "wb.animation": "Animation",
  "wb.theme": "Theme",
  "wb.background": "Canvas background",
  "wb.input": "Input device",
  "wb.input.auto": "Auto",
  "wb.input.mouse": "Mouse",
  "wb.input.trackpad": "Trackpad",

  "delete.session.title": "End the session and delete?",
  "delete.session.confirm": "Delete",
  "delete.cancel": "Cancel",

  "presence.label": "Devices online",
  "presence.thisDevice": "This device",
  "presence.unnamed": "Unnamed device",
  "presence.editing": "{device} is editing",
  "presence.takeover": "Take over",
  "presence.readOnly": "Read-only",
  "presence.takeoverTitle": "Take over editing?",
  "presence.takeoverDescription":
    "{device} becomes read-only and loses any unsaved changes.",
};

export const canvas: MessageModule = { "zh-CN": zh, en };
