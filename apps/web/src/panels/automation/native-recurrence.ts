import type { AutomationScheduleKind, NativeRecurrence } from "@armadra/shared";

import { validCron, validTimezone } from "./model";

/**
 * 把原生调度器的重复规则翻成平台计划的 recurrence（自动化设计 §1 的
 * `nativeRecurrence`、§3 的活动卡片）。
 *
 * 三条规矩，都是「不许猜」的不同写法：
 *
 * 1. **翻不了就说翻不了。** 返回 `ok: false` 加一个机器码，原文照样带回去。
 *    把一个「每 7 分钟一次」的 cron 步长硬凑成 7 分钟的 interval 会在小时
 *    边界上偏移，一个悄悄跑错点的计划比一个建不出来的计划糟得多。
 * 2. **时区不猜。** crontab 行本身不带时区，launchd 用的是本机时区。源头没
 *    说的时候留空，由人在向导里选——用读者设备的时区替它填，正是计划在错误
 *    的钟点触发的原因。
 * 3. **翻出来的是草稿。** 这里只产出向导的初始值；没有任何东西被创建、被
 *    启用，原生任务也一个字节都没动。
 *
 * 这是纯函数：不读时钟、不读设备时区、不发请求。
 */

/** 向导能接受的初始值；字段名与 `WizardState` 对齐。 */
export interface RecurrenceDraft {
  scheduleKind: AutomationScheduleKind;
  /** `cron` 时是五字段表达式。 */
  cron?: string;
  /** IANA 时区；源头没说时是空串，向导会要求人选一个。 */
  timezone?: string;
  /** `interval` 时的毫秒周期。 */
  intervalMs?: string;
}

export type RecurrenceTranslation =
  | { ok: true; draft: RecurrenceDraft; source: NativeRecurrence }
  | { ok: false; reason: RecurrenceRefusal; source: NativeRecurrence };

/**
 * 为什么翻不了。机器码，界面按它取文案，不显示解析器的原始输出。
 *
 * - `unsupportedDialect` —— 不认识的调度器。
 * - `unsupportedSyntax` —— 是 cron，但用了平台计划没有的写法（`@reboot`、
 *   六字段带秒、`L`/`W`/`#` 这类扩展）。
 * - `noSchedule` —— launchd 任务里根本没有重复规则（只有 `RunAtLoad`、
 *   `WatchPaths` 之类的触发方式），那不是一个「多久跑一次」。
 * - `multipleTimes` —— launchd 的 `StartCalendarInterval` 是一个数组，描述
 *   多个时刻。一份计划一条 recurrence，拆成几份是人的决定。
 * - `malformed` —— 读不出来。
 */
export type RecurrenceRefusal =
  | "unsupportedDialect"
  | "unsupportedSyntax"
  | "noSchedule"
  | "multipleTimes"
  | "malformed";

/** Vixie cron 的固定别名，展开成五字段。`@reboot` 不在其中：它不是周期。 */
const CRON_ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 31_536_000_000;

export function translateNativeRecurrence(
  source: NativeRecurrence,
): RecurrenceTranslation {
  const refuse = (reason: RecurrenceRefusal): RecurrenceTranslation => ({
    ok: false,
    reason,
    source,
  });
  const accept = (draft: RecurrenceDraft): RecurrenceTranslation => ({
    ok: true,
    draft,
    source,
  });
  const timezone = validTimezone(source.timezone) ? source.timezone : "";

  if (source.dialect === "cron") {
    const expression = normalizeCron(source.rule);
    if (expression === "unsupported") return refuse("unsupportedSyntax");
    if (expression === null) return refuse("malformed");
    // The Host's own parser is the authority on what it will accept, so the
    // wizard's check runs here rather than a second, looser copy of it.
    if (!validCron(expression)) return refuse("unsupportedSyntax");
    return accept({ scheduleKind: "cron", cron: expression, timezone });
  }

  if (source.dialect === "launchd")
    return translateLaunchd(source.rule, accept, refuse);

  return refuse("unsupportedDialect");
}

/**
 * A crontab line reduced to the five fields the Host accepts.
 *
 * `"unsupported"` means it *is* cron but says something a five-field schedule
 * cannot: `@reboot` (an event, not a period), a seconds or year column, or the
 * Quartz-style `L` / `W` / `#` extensions. `null` means it did not parse.
 */
function normalizeCron(rule: string): string | null | "unsupported" {
  const trimmed = rule.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("@")) {
    const alias = CRON_ALIASES[lowered.split(/\s+/)[0]!];
    // `@reboot` and `@every 5m` land here: real crontab syntax, but not a
    // five-field period, and there is nothing honest to translate them into.
    return alias ?? "unsupported";
  }
  const fields = trimmed.split(/\s+/);
  // A crontab line carries a command after the schedule; a bare expression
  // does not. Both are accepted, and anything shorter than five fields is not
  // a schedule this parser can claim to understand.
  if (fields.length < 5) return null;
  const expression = fields.slice(0, 5);
  if (expression.some((field) => /[LW#?]/i.test(field))) return "unsupported";
  // A six-field line whose first column is a seconds field would silently
  // shift every subsequent column by one. Refuse rather than misread it.
  if (fields.length >= 6 && looksLikeSecondsColumn(fields))
    return "unsupported";
  return expression.join(" ");
}

/**
 * Whether a six-or-more-field line is `<sec> <min> <hour> <dom> <mon> <dow>`
 * rather than a five-field schedule followed by a command.
 *
 * A command starts with something that is not a cron field — a path, a word,
 * an environment assignment. Six *cron-shaped* fields in a row is the tell.
 */
function looksLikeSecondsColumn(fields: string[]): boolean {
  return fields.slice(0, 6).every((field) => /^[\d*,/-]+$/.test(field));
}

/**
 * launchd's two repeat mechanisms.
 *
 * `StartInterval` is seconds between runs — an interval. A
 * `StartCalendarInterval` dictionary is a calendar rule, which maps onto cron
 * field by field; unset keys mean "every", which is exactly `*`. An *array* of
 * them is several distinct times, and one plan carries one recurrence, so that
 * one is handed back to the reader rather than collapsed into a rule that
 * fires more often than the job does.
 */
function translateLaunchd(
  rule: string,
  accept: (draft: RecurrenceDraft) => RecurrenceTranslation,
  refuse: (reason: RecurrenceRefusal) => RecurrenceTranslation,
): RecurrenceTranslation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rule);
  } catch {
    return refuse("malformed");
  }
  if (!parsed || typeof parsed !== "object") return refuse("malformed");
  const job = parsed as Record<string, unknown>;

  const calendar = job.StartCalendarInterval;
  if (Array.isArray(calendar)) {
    if (calendar.length === 0) return refuse("noSchedule");
    if (calendar.length > 1) return refuse("multipleTimes");
    return fromCalendar(calendar[0], accept, refuse);
  }
  if (calendar && typeof calendar === "object") {
    return fromCalendar(calendar, accept, refuse);
  }

  const interval = job.StartInterval;
  if (typeof interval === "number") {
    if (!Number.isInteger(interval) || interval <= 0)
      return refuse("malformed");
    const ms = interval * 1_000;
    // The Host's own bounds. An interval outside them cannot be stored, and a
    // clamped one would be a different schedule wearing the same label.
    if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS)
      return refuse("unsupportedSyntax");
    // No timezone: an interval is a period, not a wall-clock time, so there is
    // no zone to carry and none to invent.
    return accept({ scheduleKind: "interval", intervalMs: String(ms) });
  }
  // `RunAtLoad`, `WatchPaths`, `QueueDirectories` and friends are triggers,
  // not periods. There is no "how often" in them to translate.
  return refuse("noSchedule");
}

/** `StartCalendarInterval` keys, in cron field order. Unset means `*`. */
const CALENDAR_FIELDS: [string, number, number][] = [
  ["Minute", 0, 59],
  ["Hour", 0, 23],
  ["Day", 1, 31],
  ["Month", 1, 12],
  ["Weekday", 0, 7],
];

function fromCalendar(
  value: unknown,
  accept: (draft: RecurrenceDraft) => RecurrenceTranslation,
  refuse: (reason: RecurrenceRefusal) => RecurrenceTranslation,
): RecurrenceTranslation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return refuse("malformed");
  const entry = value as Record<string, unknown>;
  const fields: string[] = [];
  let named = 0;
  for (const [key, low, high] of CALENDAR_FIELDS) {
    const raw = entry[key];
    if (raw === undefined || raw === null) {
      fields.push("*");
      continue;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return refuse("malformed");
    }
    if (raw < low || raw > high) return refuse("malformed");
    named += 1;
    // launchd allows Weekday 7 for Sunday; cron spells that 0.
    fields.push(String(key === "Weekday" && raw === 7 ? 0 : raw));
  }
  // A dictionary with no recognised key is not "every minute" — it is a job
  // whose schedule this parser did not find, and claiming the busiest possible
  // cron line for it would be the worst available guess.
  if (named === 0) return refuse("noSchedule");
  // launchd runs in the machine's local zone. It is not written down anywhere
  // in the job, so the wizard asks rather than this code deciding.
  return accept({ scheduleKind: "cron", cron: fields.join(" "), timezone: "" });
}
