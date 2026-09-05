import type { CostTokens, UsageWindow } from "@armadra/shared";

/**
 * 用量看板里的纯计算（§4.2）。全部可注入 `now`，组件只负责渲染。
 */

/** `5h` → 18000，`7d` → 604800。认不出的标签没有时长，返回 `null`。 */
export function windowSeconds(label: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(label.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value * { m: 60, h: 3600, d: 86400 }[match[2] as "m" | "h" | "d"];
}

/**
 * pace：窗口走到现在**应该**用掉多少。
 *
 * 需要窗口时长与重置时间才能算——两者缺一，就没有可信的预期值，返回
 * `null` 让界面留白，而不是拿 0 当答案。
 */
export function expectedPercent(
  window: UsageWindow,
  now: number,
): number | null {
  const seconds = windowSeconds(window.label);
  const resetsAt = Date.parse(window.resetsAt ?? "");
  if (seconds === null || !Number.isFinite(resetsAt)) return null;
  const remaining = (resetsAt - now) / 1000;
  // 窗口已过期（等待刷新）或时钟明显不对时不给结论。
  if (remaining <= 0 || remaining > seconds) return null;
  return Math.min(100, Math.max(0, ((seconds - remaining) / seconds) * 100));
}

/** 实际减预期：正数表示比时间走得快。窗口信息不全时是 `null`。 */
export function paceDelta(window: UsageWindow, now: number): number | null {
  const expected = expectedPercent(window, now);
  if (expected === null) return null;
  return Math.round((window.usedPercent - expected) * 10) / 10;
}

export function totalTokens(tokens: CostTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

/** `1234` → `1.2K`，`1234567` → `1.2M`。柱状图与表格共用一个刻度。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [scale, suffix] of units) {
    if (value >= scale) {
      const scaled = value / scale;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/**
 * 金额。低于 1 分钱但不是 0 时显示 `<$0.01`——四舍五入成 `$0.00`
 * 会让人以为没花钱。
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** `2026-09-05` → `9/5`。柱状图的横轴只需要月日。 */
export function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : date;
}
