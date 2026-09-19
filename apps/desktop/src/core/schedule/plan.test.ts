/**
 * 配置的归一化与预览，对着 `apps/host/internal/automation/schedule_test.go`。
 *
 * 归一化必须**幂等**：存进去的配置会被再归一化一次来算摘要，做两遍要得到同一份
 * 字节。不然一个刚刚被批准的计划，在第一次 tick 时就会因为「摘要对不上」而作废。
 */

import { canonicalJson, planConfigToJson } from "./json";
import { describe, expect, it } from "vitest";

import { config } from "./fixture";
import {
  MAX_PREVIEW,
  ScheduleError,
  configHash,
  normalize,
  num,
  preview,
  validId,
  validText,
} from "./plan";
import { AutomationConcurrencyPolicy, AutomationMisfirePolicy } from "./types";

const MINUTE = 60_000;

describe("归一化", () => {
  it("是幂等的——摘要靠这一条才算得准", () => {
    const once = normalize(config());
    const twice = normalize(once);
    expect(canonicalJson(planConfigToJson(twice))).toEqual(
      canonicalJson(planConfigToJson(once)),
    );
    expect(configHash(twice)).toEqual(configHash(once));
  });

  it("把未指定的策略与时限填成默认值", () => {
    const normalized = normalize(config());
    expect(num(normalized.misfireGraceMs)).toBe(60_000);
    expect(num(normalized.busyTtlMs)).toBe(300_000);
    expect(num(normalized.retryBackoffMs)).toBe(1_000);
    expect(normalized.misfirePolicy).toBe(AutomationMisfirePolicy.SKIP);
    expect(normalized.concurrencyPolicy).toBe(
      AutomationConcurrencyPolicy.FORBID,
    );
  });

  it("超出界限的时限被拒，而不是被夹回范围内", () => {
    expect(() => normalize(config({ busyTtlMs: 10 }))).toThrow(ScheduleError);
    expect(() => normalize(config({ misfireGraceMs: 999_999_999 }))).toThrow(
      ScheduleError,
    );
  });

  it("循环计划必须有终点", () => {
    const looping = config();
    looping.schedule = {
      kind: {
        case: "loopAfterCompletion",
        value: {
          delayMs: BigInt(MINUTE),
        },
      },
    };
    expect(() => normalize(looping)).toThrow(ScheduleError);
    looping.maxRuns = 3n;
    expect(() => normalize(looping)).not.toThrow();
  });

  it("坏时区与坏表达式在定义时就被拒", () => {
    const cron = config();
    cron.schedule = {
      kind: {
        case: "cron",
        value: {
          expression: "不是 cron",
          timezone: "UTC",
        },
      },
    };
    expect(() => normalize(cron)).toThrow(ScheduleError);
  });
});

describe("文本与标识", () => {
  it("控制字符一个都不许有", () => {
    expect(validText("ok", 10, false)).toBe(true);
    expect(validText("ab", 10, false)).toBe(false);
    expect(validText("", 10, false)).toBe(false);
    expect(validText("", 10, true)).toBe(true);
  });

  it("标识里不能有分隔符——游标靠它分段", () => {
    expect(validId("plan-1")).toBe(true);
    expect(validId("plan/1")).toBe(false);
    expect(validId("plan 1")).toBe(false);
  });
});

describe("预览", () => {
  it("只算不动，给出接下来的几个时刻", () => {
    const cron = config();
    cron.schedule = {
      kind: {
        case: "cron",
        value: {
          expression: "0 9 * * *",
          timezone: "UTC",
        },
      },
    };
    const values = preview(cron, Date.parse("2026-09-20T00:00:00Z"), 3);
    expect(values.map((value) => new Date(value).toISOString())).toEqual([
      "2026-09-20T09:00:00.000Z",
      "2026-09-21T09:00:00.000Z",
      "2026-09-22T09:00:00.000Z",
    ]);
  });

  it("间隔计划从锚点往后数", () => {
    const every = config();
    every.schedule = {
      kind: {
        case: "interval",
        value: {
          anchorUnixMs: BigInt(Date.parse("2026-09-20T00:00:00Z")),
          intervalMs: BigInt(MINUTE),
        },
      },
    };
    const values = preview(every, Date.parse("2026-09-20T00:00:30Z"), 2);
    expect(values.map((value) => new Date(value).toISOString())).toEqual([
      "2026-09-20T00:01:00.000Z",
      "2026-09-20T00:02:00.000Z",
    ]);
  });

  it("循环计划没有可预览的日程，老实说不支持", () => {
    const looping = config({ maxRuns: 3 });
    looping.schedule = {
      kind: {
        case: "loopAfterCompletion",
        value: {
          delayMs: BigInt(MINUTE),
        },
      },
    };
    expect(() => preview(looping, Date.now(), 3)).toThrowError(
      /循环计划没有可预览的日程/,
    );
  });

  it("数量有上下界", () => {
    expect(() => preview(config(), Date.now(), 0)).toThrow(ScheduleError);
    expect(() => preview(config(), Date.now(), MAX_PREVIEW + 1)).toThrow(
      ScheduleError,
    );
  });
});
