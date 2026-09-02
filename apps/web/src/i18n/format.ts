import type { MessageModule } from "./index";

/**
 * 相对时间与时长（`lib/format.ts`）。
 *
 * 这些串短、固定、没有复数变化，所以不引 i18n 库，直接走同一张消息表；
 * 单位与数字之间的空格是中文排版规则，英文里由各自的模板决定。
 */
export const format: MessageModule = {
  "zh-CN": {
    "time.now": "刚刚",
    "time.soon": "马上",
    "time.minutesAgo": "{count} 分钟前",
    "time.minutesAhead": "{count} 分钟后",
    "time.hoursAgo": "{count} 小时前",
    "time.hoursAhead": "{count} 小时后",
    "time.yesterday": "昨天",
    "time.tomorrow": "明天",
    "time.daysAgo": "{count} 天前",
    "time.daysAhead": "{count} 天后",
    "time.monthDay": "{month} 月 {day} 日",
    "time.yearMonthDay": "{year} 年 {month} 月 {day} 日",

    "duration.ms": "{value} 毫秒",
    "duration.seconds": "{value} 秒",
    "duration.minutes": "{minutes} 分 {seconds} 秒",
    "duration.hours": "{hours} 时 {minutes} 分",
  },
  en: {
    "time.now": "just now",
    "time.soon": "in a moment",
    "time.minutesAgo": "{count} min ago",
    "time.minutesAhead": "in {count} min",
    "time.hoursAgo": "{count} h ago",
    "time.hoursAhead": "in {count} h",
    "time.yesterday": "yesterday",
    "time.tomorrow": "tomorrow",
    "time.daysAgo": "{count} d ago",
    "time.daysAhead": "in {count} d",
    "time.monthDay": "{month}/{day}",
    "time.yearMonthDay": "{year}/{month}/{day}",

    "duration.ms": "{value} ms",
    "duration.seconds": "{value} s",
    "duration.minutes": "{minutes}m {seconds}s",
    "duration.hours": "{hours}h {minutes}m",
  },
};
