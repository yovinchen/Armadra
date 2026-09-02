import type { MessageModule } from "./index";

/**
 * 用量球（计划书 §19 + §19.1）。
 *
 * 球体只有一个百分比数字，没有文字标签；完整摘要走 `usage.orbLabel`
 * 的无障碍名称，明细全在 HoverCard 面板里（§14 第 1 条）；
 * Claude / Codex 是 CLI 名，保留原文（§14 第 2 条）。
 */
export const usage: MessageModule = {
  "zh-CN": {
    "usage.label": "用量",
    "usage.refresh": "刷新",
    "usage.orbLabel": "用量 {value}",
    "usage.provider.claude": "Claude", // i18n-exempt
    "usage.provider.codex": "Codex", // i18n-exempt
    "usage.window.5h": "5 小时",
    "usage.window.7d": "7 天",
    "usage.window.primary": "主窗口",
    "usage.window.secondary": "次窗口",
    "usage.status.error": "取不到用量",
    "usage.resetIn": "重置于 {value}",
    "usage.percent": "{value}%",
  },
  en: {
    "usage.label": "Usage",
    "usage.refresh": "Refresh",
    "usage.orbLabel": "Usage {value}",
    "usage.provider.claude": "Claude",
    "usage.provider.codex": "Codex",
    "usage.window.5h": "5h",
    "usage.window.7d": "7d",
    "usage.window.primary": "Primary",
    "usage.window.secondary": "Secondary",
    "usage.status.error": "Usage unavailable",
    "usage.resetIn": "Resets {value}",
    "usage.percent": "{value}%",
  },
};
