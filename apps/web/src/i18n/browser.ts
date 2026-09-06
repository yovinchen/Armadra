import type { MessageModule } from "./index";

/**
 * 受控浏览器文案（B01，remote-and-browser-completion.md §2.6–§2.9）。
 *
 * 从 `nodes.ts` 分出来是因为浏览器节点自己已经有租约、活动徽标、帧流状态
 * 和受管安装四组串，再堆在节点总表里就没法一眼看出哪一组归谁。
 */
const zh = {
  "browser.address": "网址",
  "browser.back": "后退",
  "browser.forward": "前进",
  "browser.reload": "刷新",
  "browser.openExternal": "外部打开",
  "browser.preview": "预览",
  "browser.screenshot": "截图",
  "browser.mode": "浏览模式",
  "browser.modeControlled": "受控",
  "browser.modeCompatibility": "兼容",
  "browser.surface": "页面画面",
  "browser.keyboard": "页面键盘输入",
  "browser.state.starting": "启动中",
  "browser.state.ready": "就绪",
  "browser.state.disconnected": "已断开",
  "browser.state.terminated": "已结束",
  "browser.state.unsupported": "不可用",
  "browser.sessionFailed": "无法启动受控浏览器",
  "browser.captureSaved": "截图已保存到 {path}",
  "browser.captureFailed": "截图失败",
  "browser.unavailable.chrome_not_found": "没有找到可用的 Chrome / Chromium",
  "browser.unavailable.launch_failed": "浏览器启动失败",
  "browser.unavailable.cdp_closed": "浏览器调试连接已断开",
  "browser.unavailable.unknown": "受控浏览器在这台机器上不可用",
  "browser.searched": "已查找的可执行文件路径",
  "browser.searchedNone": "没有可查找的路径",

  /* 控制租约（§2.6）与活动徽标（§2.8） */
  "browser.lease.free": "无人控制",
  "browser.lease.you": "你在控制",
  "browser.lease.otherDevice": "其他设备在控制",
  "browser.lease.agent": "Agent {name} 在操作",
  "browser.lease.takeover": "接管",
  "browser.lease.handback": "交还",
  "browser.lease.failed": "租约操作失败",
  "browser.activity.refused": "被拒",
  "browser.activity.unknown": "结果未知",

  /* 帧流（§2.9） */
  "browser.stream.reconnecting": "画面重连中",

  /* 受管浏览器（§2.1） */
  "browser.managed.install": "安装受管浏览器 {version}（{megabytes} MB）",
  "browser.managed.installing": "正在安装…",
  "browser.managed.installed": "受管浏览器已安装",
  "browser.managed.installFailed": "受管浏览器安装失败：{reason}",
  "browser.managed.unsupported": "这个构建没有本平台的受管浏览器（{reason}）",
} as const;

const en: Record<keyof typeof zh, string> = {
  "browser.address": "Address",
  "browser.back": "Back",
  "browser.forward": "Forward",
  "browser.reload": "Reload",
  "browser.openExternal": "Open externally",
  "browser.preview": "Preview",
  "browser.screenshot": "Screenshot",
  "browser.mode": "Browsing mode",
  "browser.modeControlled": "Controlled",
  "browser.modeCompatibility": "Compatibility",
  "browser.surface": "Page view",
  "browser.keyboard": "Page keyboard input",
  "browser.state.starting": "Starting",
  "browser.state.ready": "Ready",
  "browser.state.disconnected": "Disconnected",
  "browser.state.terminated": "Ended",
  "browser.state.unsupported": "Unavailable",
  "browser.sessionFailed": "Could not start the controlled browser",
  "browser.captureSaved": "Screenshot saved to {path}",
  "browser.captureFailed": "Screenshot failed",
  "browser.unavailable.chrome_not_found":
    "No usable Chrome / Chromium was found",
  "browser.unavailable.launch_failed": "The browser failed to start",
  "browser.unavailable.cdp_closed": "The browser debugging connection closed",
  "browser.unavailable.unknown":
    "The controlled browser is unavailable on this machine",
  "browser.searched": "Executable paths searched",
  "browser.searchedNone": "No paths were searched",

  "browser.lease.free": "Nobody is driving",
  "browser.lease.you": "You are driving",
  "browser.lease.otherDevice": "Another device is driving",
  "browser.lease.agent": "Agent {name} is driving",
  "browser.lease.takeover": "Take over",
  "browser.lease.handback": "Hand back",
  "browser.lease.failed": "That lease request failed",
  "browser.activity.refused": "refused",
  "browser.activity.unknown": "outcome unknown",

  "browser.stream.reconnecting": "Reconnecting the picture",

  "browser.managed.install":
    "Install managed browser {version} ({megabytes} MB)",
  "browser.managed.installing": "Installing…",
  "browser.managed.installed": "Managed browser installed",
  "browser.managed.installFailed":
    "The managed browser install failed: {reason}",
  "browser.managed.unsupported":
    "This build has no managed browser for this platform ({reason})",
};

export const browser: MessageModule = { "zh-CN": zh, en };
