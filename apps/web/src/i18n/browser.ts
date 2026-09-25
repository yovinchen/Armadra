import type { MessageModule } from "./index";

/**
 * 浏览器节点的文案。
 *
 * 从 `nodes.ts` 分出来是因为这个节点自己就有租约、活动、标签与设置四组串，
 * 再堆在节点总表里就没法一眼看出哪一组归谁。
 *
 * 受管 Chromium、帧流与页面接管的对话框 / 文件选择器 UI 随实现一起删掉了，
 * 它们的文案也是（复查 §3.1）。`browser.dialog.*` 与 `browser.chooser.title`
 * 留下的那几条现在只做一件事：告诉人页面被什么挡住了，不再有按钮。
 */
const zh = {
  "browser.address": "网址",
  "browser.back": "后退",
  "browser.forward": "前进",
  "browser.reload": "刷新",
  "browser.stop": "停止",
  "browser.openExternal": "外部打开",
  "browser.preview": "预览",
  "browser.state.unsupported": "不可用",

  /* 远程画面流（R6c）：服务器壳上没有窗口，画的是 headless 浏览器的帧。 */
  "browser.stream.live": "远程画面",
  "browser.stream.connecting": "正在连接",
  "browser.stream.occupied": "已有人在看",
  "browser.stream.occupiedHint":
    "这个浏览器节点同时只接受一个观看者，关掉另一处再回来。",
  "browser.stream.unavailableHint":
    "服务端没有找到可用的 Chromium。装一个，或用 ARMADRA_BROWSER_PATH 指定路径。",

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

  /* 页面被什么挡住了（动态拼 `browser.dialog.${kind}`） */
  "browser.dialog.alert": "页面提示",
  "browser.dialog.confirm": "页面询问",
  "browser.dialog.prompt": "页面要求输入",
  "browser.dialog.beforeunload": "离开此页？",

  /* 页面在要文件 */
  "browser.chooser.title": "页面要选择文件",

  /* 隐藏回收（electron-migration.md §4.1）。说的是「为省内存释放了」，
     不是权限错误——人看到的应当是一个可以直接恢复的状态，而不是被挡住。 */
  "browser.discarded":
    "页面隐藏超过 {minutes} 分钟，已为省内存释放；回到这里会重新加载。",
  /* guest 渲染出错时的兜底：只让这个节点降级，不让整棵画布空白。 */
  "browser.guestFailed": "这个页面的显示出错了；关闭节点后重开即可恢复。",

  /* 打不开的那一页（`did-fail-load`）。四句，按 `failureKind` 分类——
     Chromium 的几十个 net:: 码里，能改变人下一步动作的只有这四种。 */
  "browser.failed.offline": "连不上网络，这一页打不开。",
  "browser.failed.notFound": "这个站点没有响应。",
  "browser.failed.certificate": "这个站点的安全证书有问题，已停止加载。",
  "browser.failed.unknown": "这一页加载失败了。",
  "browser.failed.retry": "重试",

  /* 人自己点下来的下载。Agent 引起的那些不走这条路（进暂存目录）。 */
  "browser.download.done": "已下载 {name}",
  "browser.download.doneWithSize": "已下载 {name}（{size}）",
  "browser.download.failed": "{name} 下载中断",
  "browser.download.reveal": "在文件夹里显示",
  "browser.download.unnamed": "文件",

  /* 设置 → 浏览器（复查 §5.2）。三项都是内存开关，说的是「这台机器愿意为
     看不见的页面留多少」。 */
  "browser.settings.discard": "隐藏后回收页面",
  "browser.settings.discardHint":
    "回收会释放那个页面的进程；回到它时整页重新加载。正在加载、正在出声、Agent 正在操作的页面不回收。",
  "browser.settings.discardMinutes": "隐藏多少分钟后回收",
  "browser.settings.backgroundMax": "后台页面上限",
  "browser.settings.backgroundMaxHint": "超过上限时释放最久没回去的那个页面。",
  "browser.settings.startPage": "新节点起始页",
  "browser.settings.startPageDefault": "默认",
  "browser.settings.clearData": "清理浏览数据",
  "browser.settings.clearDataHint":
    "清除所有浏览器节点的 Cookie、网站存储、缓存和地址历史，已登录的站点需要重新登录。",
  "browser.settings.clear": "清理",
  "browser.settings.clearConfirm": "清理所有浏览器节点的浏览数据？",
  "browser.settings.cleared": "浏览数据已清理",
  "browser.settings.clearFailed": "有部分浏览数据没能清理",

  /* 地址栏旁的项目内历史。 */
  "browser.history": "历史",
  "browser.history.clear": "清空本项目历史",
} as const;

const en: Record<keyof typeof zh, string> = {
  "browser.address": "Address",
  "browser.back": "Back",
  "browser.forward": "Forward",
  "browser.reload": "Reload",
  "browser.stop": "Stop",
  "browser.openExternal": "Open externally",
  "browser.preview": "Preview",
  "browser.state.unsupported": "Unavailable",

  "browser.stream.live": "Remote view",
  "browser.stream.connecting": "Connecting",
  "browser.stream.occupied": "Somebody is watching",
  "browser.stream.occupiedHint":
    "A browser node takes one viewer at a time; close the other one and come back.",
  "browser.stream.unavailableHint":
    "The server found no Chromium to run. Install one, or point ARMADRA_BROWSER_PATH at it.",

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

  "browser.chooser.title": "The page is asking for a file",

  "browser.discarded":
    "Hidden for over {minutes} minutes, so the page was freed to save memory; coming back reloads it.",
  "browser.guestFailed":
    "This page failed to render; close the node and reopen it to recover.",

  "browser.failed.offline": "No network connection, so this page cannot load.",
  "browser.failed.notFound": "This site did not respond.",
  "browser.failed.certificate":
    "This site's security certificate is not valid, so loading stopped.",
  "browser.failed.unknown": "This page failed to load.",
  "browser.failed.retry": "Retry",

  "browser.download.done": "Downloaded {name}",
  "browser.download.doneWithSize": "Downloaded {name} ({size})",
  "browser.download.failed": "{name} stopped downloading",
  "browser.download.reveal": "Show in folder",
  "browser.download.unnamed": "file",

  "browser.settings.discard": "Free hidden pages",
  "browser.settings.discardHint":
    "Freeing a page releases its process; coming back reloads it. Pages that are loading, making sound, or being driven by an agent are never freed.",
  "browser.settings.discardMinutes": "Free after this many minutes hidden",
  "browser.settings.backgroundMax": "Background page limit",
  "browser.settings.backgroundMaxHint":
    "Past the limit, the page you went back to least recently is released.",
  "browser.settings.startPage": "New node start page",
  "browser.settings.startPageDefault": "Default",
  "browser.settings.clearData": "Clear browsing data",
  "browser.settings.clearDataHint":
    "Clears cookies, site storage, cache and address history for every browser node. Signed-in sites will ask you to sign in again.",
  "browser.settings.clear": "Clear",
  "browser.settings.clearConfirm":
    "Clear browsing data for every browser node?",
  "browser.settings.cleared": "Browsing data cleared",
  "browser.settings.clearFailed": "Some browsing data could not be cleared",

  "browser.history": "History",
  "browser.history.clear": "Clear this project's history",
};

export const browser: MessageModule = { "zh-CN": zh, en };
