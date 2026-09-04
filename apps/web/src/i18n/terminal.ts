import type { MessageModule } from "./index";

/** 终端节点与 xterm 表面（计划书 §15.5 / §15.7）。组件一律 `useT()` 取串。 */
const zh = {
  "terminal.label": "终端",
  "terminal.input": "终端输入",
  "terminal.interrupt": "中断",
  "terminal.more": "更多",
  "terminal.collaboration": "Agent 协作",
  "terminal.collaborationHint":
    "连接节点后，助手可主动读取上下文、发送消息和查看收件箱。在此终端中运行帮助命令即可开始；消息不会自动输入其他终端。",
  "terminal.copyHelpCommand": "复制帮助命令",
  "terminal.commandCopied": "帮助命令已复制",
  "terminal.copyFailed": "无法复制，请手动选择命令复制",
  "terminal.killProcess": "结束进程",
  "terminal.destroySession": "销毁会话",
  "terminal.recycle": "回收会话",
  "terminal.rerun": "重新运行",
  "terminal.find": "搜索",
  "terminal.findNext": "下一个",
  "terminal.findPrev": "上一个",
  "terminal.exited": "已退出",
  "terminal.failed": "终端操作失败",

  /* 设置页「终端」一组（§18.3 设置项行）。 */
  "terminal.settings.font": "字体",
  "terminal.settings.fontSize": "字号",
  "terminal.settings.lineHeight": "行高",
  "terminal.settings.cursor": "光标",
  "terminal.settings.cursorBlink": "光标闪烁",
  "terminal.settings.optionAsMeta": "Option 作 Meta",
  "terminal.settings.webgl": "WebGL 渲染",
  "terminal.settings.copyOnSelect": "选中即复制",
  "terminal.copy": "复制",
  "terminal.paste": "粘贴",
  "terminal.cursor.block": "方块",
  "terminal.cursor.bar": "竖线",
  "terminal.cursor.underline": "下划线",
} as const;

const en: Record<keyof typeof zh, string> = {
  "terminal.label": "Terminal",
  "terminal.input": "Terminal input",
  "terminal.interrupt": "Interrupt",
  "terminal.more": "More",
  "terminal.collaboration": "Agent collaboration",
  "terminal.collaborationHint":
    "Connect nodes to let agents read context, send messages and check their inbox on demand. Run the help command in this terminal to get started. Messages are never typed into another terminal automatically.",
  "terminal.copyHelpCommand": "Copy help command",
  "terminal.commandCopied": "Help command copied",
  "terminal.copyFailed":
    "Could not copy. Select the command and copy it manually.",
  "terminal.killProcess": "Kill process",
  "terminal.destroySession": "Destroy session",
  "terminal.recycle": "Recycle session",
  "terminal.rerun": "Run again",
  "terminal.find": "Find",
  "terminal.findNext": "Next",
  "terminal.findPrev": "Previous",
  "terminal.exited": "Exited",
  "terminal.failed": "Terminal operation failed",

  "terminal.settings.font": "Font",
  "terminal.settings.fontSize": "Font size",
  "terminal.settings.lineHeight": "Line height",
  "terminal.settings.cursor": "Cursor",
  "terminal.settings.cursorBlink": "Cursor blink",
  "terminal.settings.optionAsMeta": "Option as Meta",
  "terminal.settings.webgl": "WebGL renderer",
  "terminal.settings.copyOnSelect": "Copy on select",
  "terminal.copy": "Copy",
  "terminal.paste": "Paste",
  "terminal.cursor.block": "Block",
  "terminal.cursor.bar": "Bar",
  "terminal.cursor.underline": "Underline",
};

export const terminal: MessageModule = { "zh-CN": zh, en };
