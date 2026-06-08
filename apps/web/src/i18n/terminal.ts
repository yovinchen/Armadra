import type { MessageModule } from "./index";

/** Terminal node body and the xterm surface. */
export const terminal: MessageModule = {
  "zh-CN": {
    "terminal.start": "启动终端",
    "terminal.starting": "在 {cwd} 启动 {shell}",
    "terminal.failed": "终端操作失败",
    "terminal.live": "已连接",
    "terminal.linking": "连接中",
    "terminal.offline": "已断开",
    "terminal.stop": "停止",
    "terminal.clear": "清屏",
    "terminal.reconnect": "重连",
    "terminal.rerun": "重新运行",
    "terminal.label": "终端",
    "terminal.summaryRunning": "正在运行 · {count} 行输出",
    "terminal.summaryExit": "退出码 {code}",
    "terminal.summaryIdle": "会话空闲",
    "terminal.summaryOffline": "会话不可用，请重连",
  },
  en: {
    "terminal.start": "Start terminal",
    "terminal.starting": "Start {shell} in {cwd}",
    "terminal.failed": "Terminal operation failed",
    "terminal.live": "connected",
    "terminal.linking": "connecting",
    "terminal.offline": "disconnected",
    "terminal.stop": "Stop",
    "terminal.clear": "Clear",
    "terminal.reconnect": "Reconnect",
    "terminal.rerun": "Run again",
    "terminal.label": "Terminal",
    "terminal.summaryRunning": "Running · {count} output lines",
    "terminal.summaryExit": "Exit code {code}",
    "terminal.summaryIdle": "Session idle",
    "terminal.summaryOffline": "Session unavailable — reconnect",
  },
};
