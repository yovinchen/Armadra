import type { MessageModule } from "./index";

/**
 * 命令名（`keybindings.ts` 的 `COMMANDS[].labelKey`）与按键符号。
 *
 * 命令表本身是纯数据、模块级常量，所以它只存键；命令面板与设置页里的
 * 快捷键表在渲染时用 `useT()` 翻译，切语言立刻跟着变。
 */
export const commands: MessageModule = {
  "zh-CN": {
    "cmd.app.commandPalette": "命令面板",
    "cmd.app.settings": "设置",
    "cmd.app.sidebar": "侧栏",
    "cmd.app.explorer": "资源管理器",
    "cmd.app.sourceControl": "源码控制",
    "cmd.app.quickOpen": "快速打开",
    "cmd.app.projectSearch": "项目搜索",

    "cmd.canvas.newTerminal": "新建终端",
    "cmd.canvas.newAgent": "新建 Agent",
    "cmd.canvas.focusMode": "焦点模式",
    "cmd.canvas.maximize": "最大化节点",
    "cmd.canvas.closeNode": "关闭节点",
    "cmd.canvas.undo": "撤销",
    "cmd.canvas.redo": "重做",
    "cmd.canvas.tidy": "整理画布",
    "cmd.canvas.zoomIn": "放大",
    "cmd.canvas.zoomOut": "缩小",
    "cmd.canvas.zoom100": "实际大小",
    "cmd.canvas.fitView": "适应视图",
    "cmd.canvas.focusLeft": "选中左侧节点",
    "cmd.canvas.focusRight": "选中右侧节点",
    "cmd.canvas.focusUp": "选中上方节点",
    "cmd.canvas.focusDown": "选中下方节点",
    "cmd.canvas.delete": "删除所选",

    /* tldraw 偏好（2026-09-05） */
    "cmd.canvas.toggleToolLock": "工具锁定",
    "cmd.canvas.toggleGrid": "显示网格",
    "cmd.canvas.toggleFocus": "专注模式",

    /* 白板工具（tldraw 计划 §5） */
    "cmd.canvas.tool.select": "选择工具",
    "cmd.canvas.tool.hand": "手形工具",
    "cmd.canvas.tool.draw": "画笔工具",
    "cmd.canvas.tool.highlight": "高亮工具",
    "cmd.canvas.tool.geo": "形状工具",
    "cmd.canvas.tool.line": "直线工具",
    "cmd.canvas.tool.arrow": "箭头工具",
    "cmd.canvas.tool.text": "文字工具",
    "cmd.canvas.tool.frame": "画框工具",

    "cmd.terminal.search": "终端内搜索",

    "cmd.scm.commit": "提交",

    /* 按键展示：其余键位是符号或拉丁字母，不需要翻译 */
    "keys.space": "空格",
  },
  en: {
    "cmd.app.commandPalette": "Command palette",
    "cmd.app.settings": "Settings",
    "cmd.app.sidebar": "Sidebar",
    "cmd.app.explorer": "Explorer",
    "cmd.app.sourceControl": "Source control",
    "cmd.app.quickOpen": "Quick open",
    "cmd.app.projectSearch": "Search in project",

    "cmd.canvas.newTerminal": "New terminal",
    "cmd.canvas.newAgent": "New agent",
    "cmd.canvas.focusMode": "Focus mode",
    "cmd.canvas.maximize": "Maximise node",
    "cmd.canvas.closeNode": "Close node",
    "cmd.canvas.undo": "Undo",
    "cmd.canvas.redo": "Redo",
    "cmd.canvas.tidy": "Tidy canvas",
    "cmd.canvas.zoomIn": "Zoom in",
    "cmd.canvas.zoomOut": "Zoom out",
    "cmd.canvas.zoom100": "Actual size",
    "cmd.canvas.fitView": "Fit view",
    "cmd.canvas.focusLeft": "Select node to the left",
    "cmd.canvas.focusRight": "Select node to the right",
    "cmd.canvas.focusUp": "Select node above",
    "cmd.canvas.focusDown": "Select node below",
    "cmd.canvas.delete": "Delete selection",

    "cmd.canvas.toggleToolLock": "Tool lock",
    "cmd.canvas.toggleGrid": "Show grid",
    "cmd.canvas.toggleFocus": "Distraction-free",

    "cmd.canvas.tool.select": "Select tool",
    "cmd.canvas.tool.hand": "Hand tool",
    "cmd.canvas.tool.draw": "Draw tool",
    "cmd.canvas.tool.highlight": "Highlighter tool",
    "cmd.canvas.tool.geo": "Shape tool",
    "cmd.canvas.tool.line": "Line tool",
    "cmd.canvas.tool.arrow": "Arrow tool",
    "cmd.canvas.tool.text": "Text tool",
    "cmd.canvas.tool.frame": "Frame tool",

    "cmd.terminal.search": "Find in terminal",

    "cmd.scm.commit": "Commit",

    "keys.space": "Space",
  },
};
