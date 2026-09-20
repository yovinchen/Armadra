import type { MessageModule } from "./index";

/**
 * 桌面壳自己的文案：托盘菜单、应用菜单、用量迷你条。
 *
 * 这个模块的读者不止页面——Electron 主进程**直接 import 这个文件**
 * （`apps/desktop/src/main/tray.ts`、`menu.ts`），经 `app:locale` 选一种语言
 * 取词。迁移设计 §2.3 的最后一条要的就是这个：壳里原本硬编码在
 * 旧壳的 Rust 源码里硬编码的中英两套串搬到这里来，
 * 壳不再有自己的第二份消息目录。
 *
 * 因此这个文件只允许 `import type`：主进程的 bundle 会把它整个打进去，
 * 多一个运行时依赖就是多一份被拖进主进程的前端代码。
 */
export const desktop: MessageModule = {
  "zh-CN": {
    "tray.showWindow": "显示窗口",
    "tray.quit": "退出并停止后台",
    "tray.updateRestart": "重启以完成更新",
    "tray.usage.signedOut": "未登录",
    "tray.usage.noData": "暂无用量数据",
    "tray.usage.costToday": "今日本地成本",
    "tray.usage.reason.expired_credentials":
      "登录已过期，在 CLI 里跑一次任何命令即可续期",
    "tray.usage.reason.unreadable_credentials": "本机凭据读不出来",
    "tray.usage.reason.unauthorized": "用量接口拒绝了登录（401）",
    "tray.usage.reason.forbidden": "用量接口拒绝了这个账号（403）",
    "tray.usage.reason.rate_limited": "用量接口限流，稍后再试",
    "tray.usage.reason.provider_error": "用量接口出错",
    "tray.usage.reason.network": "连不上用量接口",
    "tray.usage.reason.parse": "用量接口的返回无法解析",
    "tray.usage.reason.no_windows": "用量接口没有返回窗口",

    "menu.file": "文件",
    "menu.edit": "编辑",
    "menu.window": "窗口",
    "menu.showWindow": "显示窗口",
    "menu.closeWindow": "关闭窗口",
    "menu.quit": "退出并停止后台",
    "menu.undo": "撤销",
    "menu.redo": "重做",
    "menu.cut": "剪切",
    "menu.copy": "复制",
    "menu.paste": "粘贴",
    "menu.selectAll": "全选",
    "menu.minimize": "最小化",
    "menu.zoom": "缩放",
  },
  en: {
    "tray.showWindow": "Show window",
    "tray.quit": "Quit and stop background services",
    "tray.updateRestart": "Restart to finish updating",
    "tray.usage.signedOut": "signed out",
    "tray.usage.noData": "no usage data yet",
    "tray.usage.costToday": "Local cost today",
    "tray.usage.reason.expired_credentials":
      "login expired; run any CLI command to renew",
    "tray.usage.reason.unreadable_credentials": "local credentials unreadable",
    "tray.usage.reason.unauthorized": "usage endpoint rejected the login (401)",
    "tray.usage.reason.forbidden": "usage endpoint rejected this account (403)",
    "tray.usage.reason.rate_limited": "usage endpoint rate-limited; try later",
    "tray.usage.reason.provider_error": "usage endpoint error",
    "tray.usage.reason.network": "cannot reach the usage endpoint",
    "tray.usage.reason.parse": "usage endpoint answer unreadable",
    "tray.usage.reason.no_windows": "usage endpoint returned no windows",

    "menu.file": "File",
    "menu.edit": "Edit",
    "menu.window": "Window",
    "menu.showWindow": "Show window",
    "menu.closeWindow": "Close window",
    "menu.quit": "Quit and stop background services",
    "menu.undo": "Undo",
    "menu.redo": "Redo",
    "menu.cut": "Cut",
    "menu.copy": "Copy",
    "menu.paste": "Paste",
    "menu.selectAll": "Select all",
    "menu.minimize": "Minimize",
    "menu.zoom": "Zoom",
  },
};
