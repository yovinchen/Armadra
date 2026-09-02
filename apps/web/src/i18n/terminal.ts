import type { MessageModule } from "./index";

/** 终端节点与 xterm 表面（计划书 §15.5 / §15.7）。组件一律 `useT()` 取串。 */
const zh = {
  "terminal.label": "终端",
  "terminal.input": "终端输入",
  "terminal.interrupt": "中断",
  "terminal.more": "更多",
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
