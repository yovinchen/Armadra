/**
 * 展示层格式化。文案全部走 `i18n/format.ts`，这里只算数值。
 *
 * 用非响应式的 `t()` 而不是 `useT()`：这几个函数也被非组件代码调用。
 * 调用它们的组件（会话行、便签底栏、子代理卡片）自己都订阅了语言，
 * 所以切语言时它们会重渲染，格式化结果跟着变。
 *
 * 三个函数都刻意做成纯函数并允许注入 `now`，因为会话侧栏、便签底栏和
 * 子代理卡片都会在测试里断言具体文案。
 */
import { t } from "../app/preferences-store";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toMillis(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * 相对时间（zh-CN）：`刚刚` / `3 分钟前` / `2 小时前` / `昨天` / `3 天前` /
 * 日期。未来时间用「后」。无法解析时返回空串，调用方自行决定占位。
 */
export function formatRelativeTime(
  value: Date | number | string,
  now: Date | number = Date.now(),
): string {
  const then = toMillis(value);
  if (Number.isNaN(then)) return "";
  const base = toMillis(now);
  const diff = base - then;
  const ahead = diff < 0;
  const abs = Math.abs(diff);
  const when = (unit: "minutes" | "hours" | "days", count: number) =>
    t(`time.${unit}${ahead ? "Ahead" : "Ago"}`, { count });

  if (abs < 45_000) return t(ahead ? "time.soon" : "time.now");
  if (abs < HOUR) return when("minutes", Math.round(abs / MINUTE));
  if (abs < DAY) return when("hours", Math.round(abs / HOUR));
  if (abs < 2 * DAY) return t(ahead ? "time.tomorrow" : "time.yesterday");
  if (abs < 7 * DAY) return when("days", Math.round(abs / DAY));

  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(base).getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return sameYear
    ? t("time.monthDay", { month, day })
    : t("time.yearMonthDay", { year: date.getFullYear(), month, day });
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * 字节数。用 1024 进制（文件大小语境下用户预期如此），
 * 保留一位小数但整数不显示 `.0`。
 */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes)) return "—";
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  if (value < 1024) return `${sign}${Math.round(value)} B`;

  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value.toFixed(value >= 100 ? 0 : fractionDigits);
  return `${sign}${rounded.replace(/\.0+$/, "")} ${BYTE_UNITS[unit]}`;
}

/**
 * 时长（毫秒 → 人类可读）。用于状态胶囊的「已运行 xx」与子代理卡片计时：
 * `820 毫秒` / `4.2 秒` / `3 分 05 秒` / `1 时 20 分`。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return t("duration.ms", { value: Math.round(ms) });

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    const seconds = totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0);
    return t("duration.seconds", { value: seconds.replace(/\.0$/, "") });
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (totalMinutes < 60) {
    return t("duration.minutes", {
      minutes: totalMinutes,
      seconds: String(seconds).padStart(2, "0"),
    });
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return t("duration.hours", {
    hours,
    minutes: String(minutes).padStart(2, "0"),
  });
}

/** 紧凑计时，给节点头部这种横向空间很紧的地方用：`0:07` / `12:40` / `1:02:03`。 */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, "0")}`
    : `${mm}:${String(seconds).padStart(2, "0")}`;
}
