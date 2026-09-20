import type { MessageModule } from "./index";

/** 终端节点与 xterm 表面（计划书 §15.5 / §15.7）。组件一律 `useT()` 取串。 */
const zh = {
  "terminal.label": "终端",
  "terminal.input": "终端输入",
  "terminal.rerun": "重新运行",
  "terminal.find": "搜索",
  "terminal.findNext": "下一个",
  "terminal.findPrev": "上一个",
  "terminal.exited": "已退出",
  "terminal.failed": "终端操作失败",

  /*
   * 视图状态胶囊（终端宿主设计 §7.1）。两个都不表示进程结束了：
   * 「已断开」是连接掉了正在重连，「已分离」是我们主动收了前端实例。
   */
  /*
   * 谁在驱动这个终端（`agent-delivery.md` §6）。人敲一个键就抢占，停手十秒
   * 自然过期；显式接管一直持有到交还。
   */
  "terminal.drive.you": "你在驱动",
  "terminal.drive.takeover": "你已接管",
  "terminal.drive.agent": "Agent {name} 在驱动",
  "terminal.drive.take": "接管",
  "terminal.drive.giveBack": "交还",

  "terminal.render.disconnected": "已断开",
  "terminal.render.detached": "已分离",

  /* 设置页「终端」一组（§18.3 设置项行）。 */
  "terminal.settings.font": "字体",
  "terminal.settings.fontSize": "字号",
  "terminal.settings.lineHeight": "行高",
  "terminal.settings.cursor": "光标",
  "terminal.settings.cursorBlink": "光标闪烁",
  "terminal.settings.optionAsMeta": "Option 作 Meta",
  "terminal.settings.webgl": "WebGL 渲染",
  "terminal.settings.copyOnSelect": "选中即复制",
  "terminal.settings.renderBudget": "渲染名额",
  "terminal.settings.renderBudgetHint":
    "同时全速渲染的终端数量，超出的批量刷新；聚焦的终端始终全速。",
  "terminal.settings.dormantAfter": "会话休眠",
  "terminal.settings.dormantAfterHint":
    "无人附着这么久后放慢输出投递。进程照跑，回放不丢，重新打开即恢复。",
  "terminal.settings.dormant.off": "关闭",
  "terminal.settings.dormant.30s": "30 秒",
  "terminal.settings.dormant.2m": "2 分钟",
  "terminal.settings.dormant.10m": "10 分钟",
  "terminal.copy": "复制",
  "terminal.paste": "粘贴",
  "terminal.cursor.block": "方块",
  "terminal.cursor.bar": "竖线",
  "terminal.cursor.underline": "下划线",
} as const;

const en: Record<keyof typeof zh, string> = {
  "terminal.label": "Terminal",
  "terminal.input": "Terminal input",
  "terminal.rerun": "Run again",
  "terminal.find": "Find",
  "terminal.findNext": "Next",
  "terminal.findPrev": "Previous",
  "terminal.exited": "Exited",
  "terminal.failed": "Terminal operation failed",

  "terminal.drive.you": "You are driving",
  "terminal.drive.takeover": "You took over",
  "terminal.drive.agent": "Agent {name} is driving",
  "terminal.drive.take": "Take over",
  "terminal.drive.giveBack": "Hand back",

  "terminal.render.disconnected": "Disconnected",
  "terminal.render.detached": "Detached",

  "terminal.settings.font": "Font",
  "terminal.settings.fontSize": "Font size",
  "terminal.settings.lineHeight": "Line height",
  "terminal.settings.cursor": "Cursor",
  "terminal.settings.cursorBlink": "Cursor blink",
  "terminal.settings.optionAsMeta": "Option as Meta",
  "terminal.settings.webgl": "WebGL renderer",
  "terminal.settings.copyOnSelect": "Copy on select",
  "terminal.settings.renderBudget": "Render slots",
  "terminal.settings.renderBudgetHint":
    "Terminals rendered at full speed at once; the rest refresh in batches. The focused terminal always renders at full speed.",
  "terminal.settings.dormantAfter": "Session dormancy",
  "terminal.settings.dormantAfterHint":
    "Slow output delivery down after nothing has been attached this long. The process keeps running, no output is lost, and reopening resumes it.",
  "terminal.settings.dormant.off": "Off",
  "terminal.settings.dormant.30s": "30 seconds",
  "terminal.settings.dormant.2m": "2 minutes",
  "terminal.settings.dormant.10m": "10 minutes",
  "terminal.copy": "Copy",
  "terminal.paste": "Paste",
  "terminal.cursor.block": "Block",
  "terminal.cursor.bar": "Bar",
  "terminal.cursor.underline": "Underline",
};

export const terminal: MessageModule = { "zh-CN": zh, en };
