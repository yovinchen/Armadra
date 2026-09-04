import type { MessageModule } from "./index";

/**
 * 用量球（计划书 §19 + §19.1）。
 *
 * 球体只有一个百分比数字，没有文字标签；完整摘要走 `usage.orbLabel`
 * 的无障碍名称，明细全在 Popover 面板里（§14 第 1 条）；
 * Claude / Codex 是 CLI 名，保留原文（§14 第 2 条）。
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
    "usage.summaryHint": "显示所有额度窗口中的最高已用比例",
    "usage.status.unavailable": "未找到可用的登录凭据",
    "usage.recoveryHint": "请稍后刷新，或在对应 CLI 中查看",
    "usage.source.opencode": "请在 OpenCode 或所用服务商查看",
    "usage.source.copilot": "请在 GitHub 的 Copilot 用量页查看",
    "usage.source.provider": "额度随所选模型的服务商计算",

    "usage.label": "用量",
    "usage.close": "关闭用量详情",
    "usage.paused": "已暂停用量查询",
    "usage.refresh": "刷新",
    "usage.orbLabel": "用量 {value}",
    "usage.provider.claude": "Claude", // i18n-exempt
    "usage.provider.codex": "Codex", // i18n-exempt
    "usage.provider.gemini": "Gemini", // i18n-exempt
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
    "usage.summaryHint": "Highest usage across all quota windows",
    "usage.status.unavailable": "No usable sign-in credentials found",
    "usage.recoveryHint": "Refresh later, or check usage in the CLI",
    "usage.source.opencode": "View in OpenCode or your model provider",
    "usage.source.copilot": "View on GitHub’s Copilot usage page",
    "usage.source.provider": "Quota belongs to the selected model provider",

    "usage.label": "Usage",
    "usage.close": "Close usage details",
    "usage.paused": "Usage checks are paused",
    "usage.refresh": "Refresh",
    "usage.orbLabel": "Usage {value}",
    "usage.provider.claude": "Claude",
    "usage.provider.codex": "Codex",
    "usage.provider.gemini": "Gemini",
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
