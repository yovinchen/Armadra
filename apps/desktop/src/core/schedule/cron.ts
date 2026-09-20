/**
 * 五段 cron，带时区。
 *
 * 移植自 Go Host 的 合并前的实现，那边靠
 * `robfig/cron` 加 `time/tzdata`。Node 自带完整 ICU，所以时区表不用另外带一份；
 * 要自己写的是解析和「下一次」的搜索，以及 Go 那边花了两个函数说清楚的两件事：
 *
 *   * **不存在的本地分钟直接跳过**。春天向前拨的那一小时里没有 02:30，一个每天
 *     02:30 的计划那天不跑，而不是跑在 01:30 或者 03:30。
 *   * **重复出现的本地分钟只认第一次**。秋天回拨之后 01:30 来两遍，第二遍不
 *     算——否则一个日程会在一年里的某一天凭空多跑一次。Go 那边是
 *     `firstCivilOccurrence`，靠 `ZoneBounds` 找到前一个偏移，不假设一定是一
 *     小时（有半小时的折返）。这里等价地做：把本地时间按两个候选偏移都换算
 *     一次，取更早的那个；只有当结果就是更早那个时才算数。
 *
 * 不支持秒段、`@every`、`@daily` 这些扩展：Host 用的解析器只开了五段
 * （分 时 日 月 周），前端的向导也只产生五段，多认一种拼法就是多一种两边算出
 * 不同时刻的可能。
 */

/** 一个字段的取值集合，已展开成布尔表。 */
type Field = readonly boolean[];

export interface CronSchedule {
  readonly minute: Field;
  readonly hour: Field;
  readonly dayOfMonth: Field;
  readonly month: Field;
  readonly dayOfWeek: Field;
  /** 日与周都写了具体值时是「或」，这是 cron 的历史怪癖，两端必须一致。 */
  readonly dayUnion: boolean;
  readonly timezone: string;
}

/** 上界，和 Go 的 `maxTimestampMS` 同一个数：9999-12-31T23:59:59.999Z。 */
export const MAX_TIMESTAMP_MS = 253_402_300_799_999;

const BOUNDS: Record<string, { readonly min: number; readonly max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 },
};

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function named(value: string, name: keyof typeof BOUNDS): string {
  const lower = value.toLowerCase();
  if (name === "month") {
    const index = MONTH_NAMES.indexOf(lower);
    return index < 0 ? value : String(index + 1);
  }
  if (name === "dayOfWeek") {
    const index = DAY_NAMES.indexOf(lower);
    return index < 0 ? value : String(index);
  }
  return value;
}

/** 一段表达式 → 布尔表。返回 `undefined` 表示这一段不合法。 */
function parseField(raw: string, name: keyof typeof BOUNDS): Field | undefined {
  const { min, max } = BOUNDS[name] as { min: number; max: number };
  const table = new Array<boolean>(max + 1).fill(false);
  for (const part of raw.split(",")) {
    if (part === "") return undefined;
    const [range, stepText] = part.split("/") as [string, string | undefined];
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return undefined;
      step = Number(stepText);
      if (step < 1 || step > max + 1) return undefined;
    }
    let low: number;
    let high: number;
    if (range === "*") {
      low = min;
      high = max;
    } else {
      const ends = range.split("-");
      if (ends.length > 2) return undefined;
      const first = named(ends[0] as string, name);
      if (!/^\d+$/.test(first)) return undefined;
      low = Number(first);
      if (ends.length === 1) {
        // `5/2` 在 cron 里是「从 5 起每 2 个」，不是「只有 5」。
        high = stepText === undefined ? low : max;
      } else {
        const second = named(ends[1] as string, name);
        if (!/^\d+$/.test(second)) return undefined;
        high = Number(second);
      }
    }
    // 周日两种写法：`7` 和 `0` 是同一天。
    if (name === "dayOfWeek") {
      if (low === 7) low = 0;
      if (high === 7) high = 0;
    }
    if (low < min || high > max || low > high) return undefined;
    for (let value = low; value <= high; value += step) table[value] = true;
  }
  return table;
}

/** 解析五段表达式。时区必须是一个 Node 认得的 IANA 名字，`Local` 不算。 */
export function parseCron(
  expression: string,
  timezone: string,
): CronSchedule | undefined {
  const fields = expression.trim().split(/\s+/);
  if (
    fields.length !== 5 ||
    expression.length > 256 ||
    timezone === "" ||
    timezone === "Local" ||
    timezone.length > 128 ||
    !knownTimezone(timezone)
  ) {
    return undefined;
  }
  const minute = parseField(fields[0] as string, "minute");
  const hour = parseField(fields[1] as string, "hour");
  const dayOfMonth = parseField(fields[2] as string, "dayOfMonth");
  const month = parseField(fields[3] as string, "month");
  const dayOfWeek = parseField(fields[4] as string, "dayOfWeek");
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return undefined;
  }
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    // 「日」和「周」都被限制过时取并集，两段都是 `*` 时取交集（也就是每天）。
    dayUnion: fields[2] !== "*" && fields[4] !== "*",
    timezone,
  };
}

const timezones = new Map<string, boolean>();

export function knownTimezone(timezone: string): boolean {
  const cached = timezones.get(timezone);
  if (cached !== undefined) return cached;
  let valid = true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    valid = false;
  }
  timezones.set(timezone, valid);
  return valid;
}

export interface Civil {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatters.set(timezone, made);
  return made;
}

/** 一个瞬间在某个时区看起来是几点。 */
export function toCivil(atMs: number, timezone: string): Civil {
  const parts = formatter(timezone).formatToParts(new Date(atMs));
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value ?? "0";
    return Number(found);
  };
  // `hour12: false` 在某些实现里把午夜报成 24，归一成 0。
  const hour = read("hour") % 24;
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
}

/** 某个时区在某个瞬间的 UTC 偏移（毫秒）。 */
function offsetAt(atMs: number, timezone: string): number {
  const civil = toCivil(atMs, timezone);
  const asUtc = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );
  // 毫秒位不参与：`formatToParts` 只报到秒，两边都按整秒对齐再相减。
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/**
 * 本地民用时间 → 瞬间。
 *
 * 迭代两次收敛：先用「当作 UTC」那个瞬间的偏移试一次，再用试出来的瞬间的偏移修
 * 正一次。跨过 DST 边界时第二次就到位，因为偏移在一次转换之内最多变一回。
 */
export function fromCivil(civil: Civil, timezone: string): number {
  const naive = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );
  let guess = naive - offsetAt(naive, timezone);
  guess = naive - offsetAt(guess, timezone);
  return guess;
}

function sameCivil(a: Civil, b: Civil): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * 这个瞬间是不是它那个本地分钟的第一次出现。
 *
 * 回拨之后同一个本地分钟会出现两次；第二次不算一个新槽位。判据不假设偏移差是
 * 一小时：拿转换点之前的偏移重算一次，如果那个更早的瞬间也落在同一个本地分钟
 * 上，说明手里这个是第二次。
 */
export function firstCivilOccurrence(atMs: number, timezone: string): boolean {
  const civil = toCivil(atMs, timezone);
  // 往前找 48 小时内的偏移变化点。够了：没有哪个时区一天之内变两次以上。
  const before = offsetAt(atMs - 48 * 3_600_000, timezone);
  const here = offsetAt(atMs, timezone);
  if (before === here) return true;
  const naive = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );
  const alternative = naive - before;
  if (alternative >= atMs) return true;
  return !sameCivil(toCivil(alternative, timezone), civil);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function matchesDay(
  schedule: CronSchedule,
  year: number,
  month: number,
  day: number,
): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const byMonth = schedule.dayOfMonth[day] === true;
  const byWeek = schedule.dayOfWeek[weekday] === true;
  return schedule.dayUnion ? byMonth || byWeek : byMonth && byWeek;
}

/** 最多往前找多少天。五年——比任何一个合法表达式的最长间隔都长。 */
const SEARCH_DAYS = 366 * 5;

/**
 * `after` 之后下一次触发的瞬间，毫秒。找不到（比如 2 月 30 日）返回
 * `undefined`。
 *
 * 搜索是按日历走的，不是一分钟一分钟试：先定日，再在那一天里定时和分。一个每年
 * 只跑一次的表达式因此也只看几百次，而不是五十万次。
 */
export function nextCron(
  schedule: CronSchedule,
  afterMs: number,
): number | undefined {
  // 候选从 `after` 的下一分钟开始：cron 的语义是「严格之后」。
  const start = toCivil(
    afterMs + 60_000 - (afterMs % 60_000),
    schedule.timezone,
  );
  let { year, month, day } = start;
  let hour = start.hour;
  let minute = start.minute;
  for (let scanned = 0; scanned < SEARCH_DAYS; scanned += 1) {
    if (
      schedule.month[month] !== true ||
      !matchesDay(schedule, year, month, day)
    ) {
      ({ year, month, day } = nextDay(year, month, day));
      hour = 0;
      minute = 0;
      continue;
    }
    for (; hour < 24; hour += 1) {
      if (schedule.hour[hour] !== true) {
        minute = 0;
        continue;
      }
      for (; minute < 60; minute += 1) {
        if (schedule.minute[minute] !== true) continue;
        const civil = { year, month, day, hour, minute, second: 0 };
        const candidate = fromCivil(civil, schedule.timezone);
        if (candidate <= afterMs) continue;
        if (candidate > MAX_TIMESTAMP_MS) return undefined;
        // 不存在的本地分钟：换算回去对不上，说明它落在向前拨掉的那一小时里。
        if (!sameCivil(toCivil(candidate, schedule.timezone), civil)) continue;
        if (!firstCivilOccurrence(candidate, schedule.timezone)) continue;
        return candidate;
      }
      minute = 0;
    }
    ({ year, month, day } = nextDay(year, month, day));
    hour = 0;
    minute = 0;
  }
  return undefined;
}

function nextDay(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  if (day < daysInMonth(year, month)) return { year, month, day: day + 1 };
  if (month < 12) return { year, month: month + 1, day: 1 };
  return { year: year + 1, month: 1, day: 1 };
}
