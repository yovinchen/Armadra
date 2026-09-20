/**
 * cron 的时区语义，逐条对着 合并前的实现。
 *
 * 三件事是这个文件真正在守的：不存在的本地分钟跳过、重复的本地分钟只认第一次、
 * 以及「下一次」永远严格晚于给定的瞬间。其余的解析用例是为了让一条写错的表达式
 * 在定义时就被拒，而不是在第一次该跑的时候安静地不跑。
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TIMESTAMP_MS,
  firstCivilOccurrence,
  nextCron,
  parseCron,
} from "./cron";

function at(schedule: string, timezone: string, from: string): string {
  const parsed = parseCron(schedule, timezone);
  if (parsed === undefined) throw new Error(`拒绝了合法表达式：${schedule}`);
  const next = nextCron(parsed, Date.parse(from));
  if (next === undefined) throw new Error("没有下一次");
  return new Date(next).toISOString();
}

describe("cron 解析", () => {
  it("只认五段", () => {
    expect(parseCron("* * * *", "UTC")).toBeUndefined();
    expect(parseCron("0 0 * * * *", "UTC")).toBeUndefined();
    expect(parseCron("@daily", "UTC")).toBeUndefined();
    expect(parseCron("0 0 * * *", "UTC")).toBeDefined();
  });

  it("拒绝未知时区，也拒绝 Local", () => {
    expect(parseCron("0 0 * * *", "Local")).toBeUndefined();
    expect(parseCron("0 0 * * *", "Mars/Olympus")).toBeUndefined();
    expect(parseCron("0 0 * * *", "Asia/Shanghai")).toBeDefined();
  });

  it("认名字、步长、范围和列表", () => {
    expect(parseCron("0 9 * jan-mar mon,fri", "UTC")).toBeDefined();
    expect(parseCron("*/15 * * * *", "UTC")).toBeDefined();
    expect(parseCron("0 0 1 13 *", "UTC")).toBeUndefined();
    expect(parseCron("60 0 * * *", "UTC")).toBeUndefined();
    expect(parseCron("0 0 * * 8", "UTC")).toBeUndefined();
  });

  it("周日写 0 和写 7 是同一天", () => {
    expect(at("0 0 * * 0", "UTC", "2026-09-20T12:00:00Z")).toBe(
      at("0 0 * * 7", "UTC", "2026-09-20T12:00:00Z"),
    );
  });
});

describe("下一次", () => {
  it("严格晚于给定的瞬间", () => {
    // 正好压在触发点上时给出的是下一个，不是这一个。
    expect(at("0 * * * *", "UTC", "2026-09-20T10:00:00Z")).toBe(
      "2026-09-20T11:00:00.000Z",
    );
  });

  it("日与周都写了具体值时取并集", () => {
    // 每月 1 号或者每周一，先到哪个算哪个。
    expect(at("0 0 1 * mon", "UTC", "2026-09-20T00:00:00Z")).toBe(
      "2026-09-21T00:00:00.000Z",
    );
    expect(at("0 0 1 * mon", "UTC", "2026-09-22T00:00:00Z")).toBe(
      "2026-09-28T00:00:00.000Z",
    );
  });

  it("按本地时区，不是按 UTC", () => {
    // 上海 09:00 是 UTC 01:00，全年无夏令时。
    expect(at("0 9 * * *", "Asia/Shanghai", "2026-09-20T00:00:00Z")).toBe(
      "2026-09-20T01:00:00.000Z",
    );
  });

  it("跳过春天向前拨掉的那一小时里的本地分钟", () => {
    // 纽约 2026-03-08 02:30 不存在：那天 02:00 直接跳到 03:00。
    expect(at("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z")).toBe(
      "2026-03-09T06:30:00.000Z",
    );
  });

  it("回拨那天的本地分钟只算第一次", () => {
    // 2026-11-01 纽约 01:30 出现两次；日程取更早的那个（EDT，UTC-4）。
    const value = at("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z");
    expect(value).toBe("2026-11-01T05:30:00.000Z");
    expect(firstCivilOccurrence(Date.parse(value), "America/New_York")).toBe(
      true,
    );
    // 第二次出现（EST，UTC-5）不是一个新槽位。
    expect(
      firstCivilOccurrence(
        Date.parse("2026-11-01T06:30:00Z"),
        "America/New_York",
      ),
    ).toBe(false);
  });

  it("跨年也找得到", () => {
    expect(at("0 0 29 2 *", "UTC", "2026-09-20T00:00:00Z")).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("永远不到的表达式老实说没有", () => {
    const schedule = parseCron("0 0 30 2 *", "UTC");
    expect(schedule).toBeDefined();
    expect(nextCron(schedule!, Date.now())).toBeUndefined();
  });

  it("不越过时间上界", () => {
    const schedule = parseCron("0 0 * * *", "UTC");
    expect(nextCron(schedule!, MAX_TIMESTAMP_MS - 1)).toBeUndefined();
  });
});
