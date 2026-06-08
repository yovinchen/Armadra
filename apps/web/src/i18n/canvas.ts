import type { MessageModule } from "./index";

/** Canvas surface: empty state, toolbar, zoom, edge picker, focus/summary. */
export const canvas: MessageModule = {
  "zh-CN": {
    "canvas.label": "AI Coding Canvas 画布",
    "canvas.empty.title": "{board} 是空看板",
    "canvas.empty.body":
      "从左侧拖入文件、文件夹或节点类型；粘贴一段文字会直接创建便签。拖文件到 Agent 上会自动建立「引用」连线。",
    "canvas.empty.task": "从任务开始",
    "canvas.empty.agent": "新建 Agent (ACP)",
    "canvas.empty.command": "命令",

    "canvas.toolbar": "画布工具栏",
    "canvas.tool.select": "选择",
    "canvas.tool.select.hint": "选择 / 拖动 / 平移",
    "canvas.tool.pen": "画笔",
    "canvas.tool.pen.hint": "在画布上手绘标注",
    "canvas.pen.color": "画笔颜色 {color}",
    "canvas.pen.clear": "清除笔迹",
    "canvas.arrange": "一键整理",
    "canvas.arrange.hint": "按连线流向分列排布并适应画布",

    "canvas.zoom.group": "画布缩放",
    "canvas.zoom.in": "放大",
    "canvas.zoom.out": "缩小",
    "canvas.zoom.reset": "回到 100%",
    "canvas.zoom.fit": "适应画布",
    "canvas.summary.hint": "缩放 {zoom} · 摘要视图",
    "canvas.summary.reset": "回到 100%",
    "canvas.summaryMode": "缩放低于 {threshold} 时切换为摘要",
    "canvas.focus.hint": "聚焦：{title}",
    "canvas.focus.exit": "退出 (Esc)",

    "canvas.edge.title": "选择连线语义",
    "canvas.edge.desc.link": "引用对方内容，不产生依赖",
    "canvas.edge.desc.dispatch": "把任务交给目标执行",
    "canvas.edge.desc.produce": "目标是本节点的结果",
    "canvas.edge.desc.write": "变更应用到目标文件",
    "canvas.edge.desc.trigger": "完成后自动运行目标",
    "canvas.edge.desc.ref": "作为上下文提供给 Agent",

    "canvas.delete.title": "删除画布内容？",
    "canvas.delete.confirm": "确认删除",
    "canvas.delete.nodes": "{count} 个节点",
    "canvas.delete.edges": "{count} 条连线",
    "canvas.delete.description":
      "将删除{summary}。与节点关联的连线也会一并移除。",
  },
  en: {
    "canvas.label": "AI Coding Canvas board",
    "canvas.empty.title": "{board} is empty",
    "canvas.empty.body":
      "Drag in files, folders or node types from the left; pasting text creates a note. Dropping a file on an Agent adds a reference link.",
    "canvas.empty.task": "Start from a task",
    "canvas.empty.agent": "New Agent (ACP)",
    "canvas.empty.command": "Commands",

    "canvas.toolbar": "Canvas toolbar",
    "canvas.tool.select": "Select",
    "canvas.tool.select.hint": "Select / drag / pan",
    "canvas.tool.pen": "Pen",
    "canvas.tool.pen.hint": "Sketch annotations on the canvas",
    "canvas.pen.color": "Pen colour {color}",
    "canvas.pen.clear": "Clear strokes",
    "canvas.arrange": "Arrange",
    "canvas.arrange.hint": "Lay out by link direction, then fit the view",

    "canvas.zoom.group": "Canvas zoom",
    "canvas.zoom.in": "Zoom in",
    "canvas.zoom.out": "Zoom out",
    "canvas.zoom.reset": "Back to 100%",
    "canvas.zoom.fit": "Fit view",
    "canvas.summary.hint": "Zoom {zoom} · summary view",
    "canvas.summary.reset": "Back to 100%",
    "canvas.summaryMode": "Nodes collapse to summaries below {threshold}",
    "canvas.focus.hint": "Focused: {title}",
    "canvas.focus.exit": "Exit (Esc)",

    "canvas.edge.title": "Pick a link semantic",
    "canvas.edge.desc.link": "References the other side without a dependency",
    "canvas.edge.desc.dispatch": "Hands the task to the target",
    "canvas.edge.desc.produce": "The target is this node's result",
    "canvas.edge.desc.write": "Applies the change to the target file",
    "canvas.edge.desc.trigger": "Runs the target once this finishes",
    "canvas.edge.desc.ref": "Provided to the agent as context",

    "canvas.delete.title": "Delete canvas content?",
    "canvas.delete.confirm": "Delete",
    "canvas.delete.nodes": "{count} nodes",
    "canvas.delete.edges": "{count} links",
    "canvas.delete.description":
      "This will delete {summary}, including links attached to deleted nodes.",
  },
};
