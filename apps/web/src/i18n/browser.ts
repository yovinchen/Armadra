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
  "browser.stop": "停止",
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
  "browser.unavailable.desktopOnly":
    "浏览器节点只在桌面应用里可用；在浏览器里打开画布时它没有可以嵌入的页面。",
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

  /* 标签条（§2.2） */
  "browser.tabs.label": "标签",
  "browser.tabs.new": "新建标签",
  "browser.tabs.close": "关闭标签",
  "browser.tabs.untitled": "新标签页",
  "browser.tabs.failed": "标签操作失败",

  /* 对话框（§2.4） */
  "browser.dialog.alert": "页面提示",
  "browser.dialog.confirm": "页面询问",
  "browser.dialog.prompt": "页面要求输入",
  "browser.dialog.beforeunload": "离开此页？",
  "browser.dialog.answer": "回答",
  "browser.dialog.accept": "确定",
  "browser.dialog.dismiss": "取消",
  "browser.dialog.leave": "离开",
  "browser.dialog.stay": "留在此页",
  "browser.dialog.failed": "对话框已经被答复",

  /* 文件选择（§2.3） */
  "browser.chooser.title": "页面要选择文件",
  "browser.chooser.input": "要提交的文件",
  "browser.chooser.nativeHint": "只能选工作空间里的文件。",
  "browser.chooser.importHint": "选中的文件会先导入到 .armadra/imports/。",
  "browser.chooser.choose": "选择文件",
  "browser.chooser.later": "暂不选择",
  "browser.chooser.filled": "已提交 {count} 个文件",
  "browser.chooser.outsideRoot": "文件不在这个工作空间里",
  "browser.chooser.failed": "文件提交失败",

  /* 帧流（§2.9） */
  "browser.stream.reconnecting": "画面重连中",

  /* 隐藏回收（electron-migration.md §4.1）。说的是「为省内存释放了」，
     不是权限错误——人看到的应当是一个可以直接恢复的状态，而不是被挡住。 */
  "browser.discarded":
    "页面隐藏超过 {minutes} 分钟，已为省内存释放；回到这里会重新加载。",

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
  "browser.stop": "Stop",
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
  "browser.unavailable.desktopOnly":
    "Browser nodes only work in the desktop app; opened in a browser tab there is no page for one to embed.",
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

  "browser.tabs.label": "Tabs",
  "browser.tabs.new": "New tab",
  "browser.tabs.close": "Close tab",
  "browser.tabs.untitled": "New tab",
  "browser.tabs.failed": "That tab action failed",

  "browser.dialog.alert": "The page says",
  "browser.dialog.confirm": "The page asks",
  "browser.dialog.prompt": "The page wants an answer",
  "browser.dialog.beforeunload": "Leave this page?",
  "browser.dialog.answer": "Answer",
  "browser.dialog.accept": "OK",
  "browser.dialog.dismiss": "Cancel",
  "browser.dialog.leave": "Leave",
  "browser.dialog.stay": "Stay",
  "browser.dialog.failed": "That dialog has already been answered",

  "browser.chooser.title": "The page is asking for a file",
  "browser.chooser.input": "Files to send",
  "browser.chooser.nativeHint": "Only files inside this workspace can be sent.",
  "browser.chooser.importHint":
    "The files you pick are imported into .armadra/imports/ first.",
  "browser.chooser.choose": "Choose files",
  "browser.chooser.later": "Not now",
  "browser.chooser.filled": "Sent {count} file(s)",
  "browser.chooser.outsideRoot": "That file is outside this workspace",
  "browser.chooser.failed": "Sending the files failed",

  "browser.stream.reconnecting": "Reconnecting the picture",

  "browser.discarded":
    "Hidden for over {minutes} minutes, so the page was freed to save memory; coming back reloads it.",

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
