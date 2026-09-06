import { describe, expect, it } from "vitest";
import type { NativeRecurrence } from "@armadra/shared";

import { translateNativeRecurrence } from "./native-recurrence";

/**
 * 这份测试钉的不是「翻得多准」，而是「翻不动的时候不许瞎翻」：每一条拒绝都
 * 必须带着原文回来，而不是被凑成一个差不多的周期。
 */

const rule = (patch: Partial<NativeRecurrence>): NativeRecurrence => ({
  dialect: "cron",
  rule: "0 3 * * *",
  timezone: "Asia/Shanghai",
  ...patch,
});

describe("cron", () => {
  it("五字段表达式直接成为计划的 cron 日程，时区照抄", () => {
    const result = translateNativeRecurrence(rule({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toEqual({
      scheduleKind: "cron",
      cron: "0 3 * * *",
      timezone: "Asia/Shanghai",
    });
  });

  it("crontab 行后面的命令被丢掉，只留日程", () => {
    const result = translateNativeRecurrence(
      rule({ rule: "*/15 2 * * 1-5 /usr/local/bin/backup --all" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.cron).toBe("*/15 2 * * 1-5");
  });

  it("固定别名展开成五字段", () => {
    for (const [alias, expanded] of [
      ["@daily", "0 0 * * *"],
      ["@hourly", "0 * * * *"],
      ["@weekly", "0 0 * * 0"],
    ] as const) {
      const result = translateNativeRecurrence(rule({ rule: alias }));
      expect(result.ok, alias).toBe(true);
      if (result.ok) expect(result.draft.cron).toBe(expanded);
    }
  });

  it("时区无效时留空，不拿设备时区顶上", () => {
    const result = translateNativeRecurrence(
      rule({ timezone: "Middle/Earth" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.timezone).toBe("");
  });

  it("@reboot 是事件不是周期，拒绝并保留原文", () => {
    const result = translateNativeRecurrence(rule({ rule: "@reboot" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupportedSyntax");
    expect(result.source.rule).toBe("@reboot");
  });

  it("带秒的六字段不会被当成五字段整体右移一列", () => {
    const result = translateNativeRecurrence(rule({ rule: "0 30 2 * * 1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupportedSyntax");
  });

  it("Quartz 的 L / W / # 扩展没有等价物，拒绝", () => {
    for (const expression of ["0 3 L * *", "0 3 * * 5#2", "0 3 15W * *"]) {
      const result = translateNativeRecurrence(rule({ rule: expression }));
      expect(result.ok, expression).toBe(false);
    }
  });

  it("字段不够或者是注释就是读不出来", () => {
    for (const expression of ["0 3 *", "# 0 3 * * *", "   "]) {
      const result = translateNativeRecurrence(rule({ rule: expression }));
      expect(result.ok, expression).toBe(false);
    }
  });
});

describe("launchd", () => {
  const job = (value: unknown): NativeRecurrence => ({
    dialect: "launchd",
    rule: JSON.stringify(value),
    timezone: "",
  });

  it("StartCalendarInterval 逐字段映射成 cron，缺省的键就是 *", () => {
    const result = translateNativeRecurrence(
      job({ StartCalendarInterval: { Hour: 3, Minute: 30 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.cron).toBe("30 3 * * *");
    // launchd 跑在本机时区，而任务里根本没写下来，所以这里留空让人去选。
    expect(result.draft.timezone).toBe("");
  });

  it("launchd 的 Weekday 7 是周日，cron 里写 0", () => {
    const result = translateNativeRecurrence(
      job({ StartCalendarInterval: { Weekday: 7, Hour: 0, Minute: 0 } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.cron).toBe("0 0 * * 0");
  });

  it("只有一个时刻的数组照常翻；多个时刻交回给人", () => {
    const single = translateNativeRecurrence(
      job({ StartCalendarInterval: [{ Hour: 9, Minute: 0 }] }),
    );
    expect(single.ok).toBe(true);
    if (single.ok) expect(single.draft.cron).toBe("0 9 * * *");

    const several = translateNativeRecurrence(
      job({ StartCalendarInterval: [{ Hour: 9 }, { Hour: 18 }] }),
    );
    expect(several.ok).toBe(false);
    if (!several.ok) expect(several.reason).toBe("multipleTimes");
  });

  it("StartInterval 是秒，换成毫秒的 interval，且不带时区", () => {
    const result = translateNativeRecurrence(job({ StartInterval: 900 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toEqual({
      scheduleKind: "interval",
      intervalMs: "900000",
    });
  });

  it("超出 Host 上下限的 interval 不被夹到边界，直接拒绝", () => {
    for (const seconds of [0, -5, 400_000_000]) {
      const result = translateNativeRecurrence(job({ StartInterval: seconds }));
      expect(result.ok, String(seconds)).toBe(false);
    }
  });

  it("只有事件触发的任务没有周期可翻", () => {
    const result = translateNativeRecurrence(
      job({ RunAtLoad: true, WatchPaths: ["/tmp"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("noSchedule");
  });

  it("一个没有任何已知键的字典不会被当成「每分钟」", () => {
    const result = translateNativeRecurrence(
      job({ StartCalendarInterval: { Nonsense: 1 } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("noSchedule");
  });

  it("越界或者非整数的字段是读不出来，不是取最近值", () => {
    for (const entry of [{ Hour: 25 }, { Minute: 1.5 }, { Month: 0 }]) {
      const result = translateNativeRecurrence(
        job({ StartCalendarInterval: entry }),
      );
      expect(result.ok, JSON.stringify(entry)).toBe(false);
      if (!result.ok) expect(result.reason).toBe("malformed");
    }
  });

  it("不是 JSON 就是读不出来，原文照样带回去", () => {
    const source: NativeRecurrence = {
      dialect: "launchd",
      rule: "<plist>not json</plist>",
      timezone: "",
    };
    const result = translateNativeRecurrence(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
      expect(result.source.rule).toBe("<plist>not json</plist>");
    }
  });
});

describe("其他调度器", () => {
  it("不认识的方言直接拒绝，不猜", () => {
    const result = translateNativeRecurrence({
      dialect: "systemd" as NativeRecurrence["dialect"],
      rule: "OnCalendar=daily",
      timezone: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupportedDialect");
  });
});
