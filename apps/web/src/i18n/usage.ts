import type { MessageModule } from "./index";

/**
 * 用量（计划书 §19 + §19.1；并进 Dock 见用户实测反馈 F9）。
 *
 * Dock 里那一格只有一个百分比数字，没有文字标签；完整摘要走
 * `usage.dockLabel` 的无障碍名称与悬停提示，明细全在用量面板里
 * （§14 第 1 条）；Claude / Codex 是 CLI 名，保留原文（§14 第 2 条）。
 */
export const usage: MessageModule = {
  "zh-CN": {
    "usage.used": "已用 {value}%",
    "usage.updated": "更新于 {value}",
    "usage.resetUnknown": "重置时间未知",
    "usage.awaitingRefresh": "窗口已到期，等待刷新",
    "usage.stale": "数据已过期，请刷新",
    "usage.refreshError": "刷新失败，请稍后重试",
    "usage.cooldown": "{seconds} 秒后可刷新",
    "usage.cadence": "每 5 分钟自动更新",
    "usage.status.unavailable": "未找到可用的登录凭据",
    "usage.recoveryHint": "请稍后刷新，或在对应 CLI 中查看",
    "usage.reason.expired_credentials":
      "登录已过期。在 {provider} 的 CLI 里跑一次任何命令，它会自动续期，然后再刷新",
    "usage.reason.unreadable_credentials": "本机的凭据文件读不出来或没有令牌",
    "usage.reason.unauthorized":
      "用量接口拒绝了这份登录（401），请在 CLI 里重新登录",
    "usage.reason.forbidden": "用量接口拒绝了这个账号（403）",
    "usage.reason.rate_limited": "用量接口限流（429），稍后再刷新",
    "usage.reason.provider_error": "用量接口出错，请稍后刷新，或在 CLI 中查看",
    "usage.reason.network": "连不上用量接口，检查网络或代理后再刷新",
    "usage.reason.parse": "用量接口的返回无法解析，可能是接口改了",
    "usage.reason.no_windows": "用量接口没有返回任何窗口",
    "usage.source.opencode": "请在 OpenCode 或所用服务商查看",
    "usage.source.copilot": "请在 GitHub 的 Copilot 用量页查看",
    "usage.source.provider": "额度随所选模型的服务商计算",

    "usage.provider.copilot": "Copilot", // i18n-exempt
    "usage.unlimited": "无限制",
    "usage.credits": "余额",
    "usage.viaCli": "数据来自本地 CLI",
    "usage.paceAhead": "比进度快 {value}%",
    "usage.paceBehind": "比进度慢 {value}%",

    "usage.dashboard.title": "用量看板",
    "usage.dashboard.open": "打开用量看板",
    "usage.dashboard.pin": "固定用量看板",
    "usage.dashboard.unpin": "取消固定",

    "usage.cost.title": "本地成本",
    "usage.cost.today": "今日",
    "usage.cost.window": "最近 30 天",
    "usage.cost.session": "当前会话（{value}）",
    "usage.cost.daily": "每日用量",
    "usage.cost.dailyHint": "指向柱子查看当天",
    "usage.cost.date": "日期",
    "usage.cost.tokens": "Token",
    "usage.cost.spend": "费用",
    "usage.cost.tokenCount": "{value} token",
    "usage.cost.models": "模型分解",
    "usage.cost.partial": "{value}（不完整）",
    "usage.cost.unpricedShort": "仅 token",
    "usage.cost.separator": "、",
    "usage.cost.unpriced": "没有价格的模型只统计 token：{value}",
    "usage.cost.truncated": "转录文件过多，较旧的没有统计",
    "usage.cost.scannedAt": "扫描于 {value}",
    "usage.cost.disabled": "已关闭本地成本统计",
    "usage.cost.empty": "本机没有可读的转录",
    "usage.cost.error": "读取本地成本失败",

    "usage.close": "关闭用量详情",
    "usage.paused": "已暂停用量查询",
    "usage.refresh": "刷新",
    "usage.dockLabel": "用量 {value}",
    "usage.provider.claude": "Claude", // i18n-exempt
    "usage.provider.codex": "Codex", // i18n-exempt
    "usage.window.quota": "模型额度",
    "usage.window.5h": "5 小时",
    "usage.window.7d": "7 天",
    "usage.window.primary": "主窗口",
    "usage.window.secondary": "次窗口",
    "usage.status.error": "取不到用量",
    "usage.resetIn": "重置于 {value}",
    "usage.percent": "{value}%",
  },
  en: {
    "usage.used": "{value}% used",
    "usage.updated": "Updated {value}",
    "usage.resetUnknown": "Reset time unknown",
    "usage.awaitingRefresh": "Window ended; awaiting refresh",
    "usage.stale": "Data is out of date. Refresh to update.",
    "usage.refreshError": "Refresh failed. Try again later.",
    "usage.cooldown": "Refresh in {seconds}s",
    "usage.cadence": "Updates automatically every 5 minutes",
    "usage.status.unavailable": "No usable sign-in credentials found",
    "usage.recoveryHint": "Refresh later, or check usage in the CLI",
    "usage.reason.expired_credentials":
      "Sign-in has expired. Run any command in the {provider} CLI and it renews itself; then refresh",
    "usage.reason.unreadable_credentials":
      "The credential file on this machine could not be read or holds no token",
    "usage.reason.unauthorized":
      "The usage endpoint rejected this sign-in (401); sign in again in the CLI",
    "usage.reason.forbidden": "The usage endpoint refused this account (403)",
    "usage.reason.rate_limited":
      "The usage endpoint is rate-limiting (429); refresh later",
    "usage.reason.provider_error":
      "The usage endpoint failed; refresh later, or check usage in the CLI",
    "usage.reason.network":
      "The usage endpoint could not be reached; check the network or proxy, then refresh",
    "usage.reason.parse":
      "The usage endpoint's answer could not be parsed; it may have changed",
    "usage.reason.no_windows": "The usage endpoint returned no windows",
    "usage.source.opencode": "View in OpenCode or your model provider",
    "usage.source.copilot": "View on GitHub’s Copilot usage page",
    "usage.source.provider": "Quota belongs to the selected model provider",

    "usage.provider.copilot": "Copilot",
    "usage.unlimited": "Unlimited",
    "usage.credits": "Credits",
    "usage.viaCli": "Read from the local CLI",
    "usage.paceAhead": "{value}% ahead of pace",
    "usage.paceBehind": "{value}% behind pace",

    "usage.dashboard.title": "Usage dashboard",
    "usage.dashboard.open": "Open usage dashboard",
    "usage.dashboard.pin": "Pin usage dashboard",
    "usage.dashboard.unpin": "Unpin",

    "usage.cost.title": "Local cost",
    "usage.cost.today": "Today",
    "usage.cost.window": "Last 30 days",
    "usage.cost.session": "Current session ({value})",
    "usage.cost.daily": "Daily usage",
    "usage.cost.dailyHint": "Point at a bar for that day",
    "usage.cost.date": "Date",
    "usage.cost.tokens": "Tokens",
    "usage.cost.spend": "Spend",
    "usage.cost.tokenCount": "{value} tokens",
    "usage.cost.models": "By model",
    "usage.cost.partial": "{value} (incomplete)",
    "usage.cost.unpricedShort": "tokens only",
    "usage.cost.separator": ", ",
    "usage.cost.unpriced": "Models with no price count tokens only: {value}",
    "usage.cost.truncated": "Too many transcripts; older ones were skipped",
    "usage.cost.scannedAt": "Scanned {value}",
    "usage.cost.disabled": "Local cost tracking is off",
    "usage.cost.empty": "No readable transcripts on this machine",
    "usage.cost.error": "Could not read local cost",

    "usage.close": "Close usage details",
    "usage.paused": "Usage checks are paused",
    "usage.refresh": "Refresh",
    "usage.dockLabel": "Usage {value}",
    "usage.provider.claude": "Claude",
    "usage.provider.codex": "Codex",
    "usage.window.quota": "Model quota",
    "usage.window.5h": "5h",
    "usage.window.7d": "7d",
    "usage.window.primary": "Primary",
    "usage.window.secondary": "Secondary",
    "usage.status.error": "Usage unavailable",
    "usage.resetIn": "Resets {value}",
    "usage.percent": "{value}%",
  },
};
