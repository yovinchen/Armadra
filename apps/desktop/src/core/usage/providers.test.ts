import { describe, expect, it } from "vitest";

import {
  accountIdFromJwt,
  claudeWindows,
  clampPercent,
  codexCliWindows,
  codexCredits,
  codexReport,
  copilotResetTimestamp,
  copilotWindows,
  durationLabel,
  failureFromStatus,
  selectCredential,
  tokenFromPayload,
  type ClaudeUsageResponse,
} from "./providers";

const NOW = Date.parse("2026-09-20T00:00:00Z");

/** 移植自 合并前实现的用例。 */
describe("凭据载荷里的令牌", () => {
  it("expiresAt 为 0 是「不按时钟过期」，不是 1970 年就过期了", () => {
    const payload = JSON.stringify({
      claudeAiOauth: { accessToken: "tok", expiresAt: 0 },
    });
    expect(tokenFromPayload(payload, NOW)).toBe("tok");
    const stale = JSON.stringify({
      claudeAiOauth: { accessToken: "tok", expiresAt: NOW - 1 },
    });
    expect(tokenFromPayload(stale, NOW)).toBeUndefined();
    const fresh = JSON.stringify({
      claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 60_000 },
    });
    expect(tokenFromPayload(fresh, NOW)).toBe("tok");
  });
});

describe("共用的换算", () => {
  it("窗口秒数变成 CLI 打印的那个短标签", () => {
    expect(durationLabel(604_800)).toBe("7d");
    expect(durationLabel(18_000)).toBe("5h");
    expect(durationLabel(90)).toBe("1m");
    expect(durationLabel(0)).toBeUndefined();
    expect(durationLabel(-1)).toBeUndefined();
  });

  it("百分比夹在 0–100 并保留一位小数", () => {
    expect(clampPercent(36.4499)).toBe(36.4);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(1_000)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  it("状态码变成一个原因码，而不是一句消息", () => {
    expect(failureFromStatus(401)).toBe("unauthorized");
    expect(failureFromStatus(403)).toBe("forbidden");
    expect(failureFromStatus(429)).toBe("rate_limited");
    expect(failureFromStatus(502)).toBe("provider_error");
  });
});

describe("Claude", () => {
  it("一条过期的钥匙串条目不会盖住一份可用的文件凭据", () => {
    const { token, source } = selectCredential(
      [
        [
          JSON.stringify({
            claudeAiOauth: { accessToken: "old", expiresAt: 1 },
          }),
          "keychain",
        ],
        [JSON.stringify({ claudeAiOauth: { accessToken: "valid" } }), "file"],
      ],
      NOW,
    );
    expect(token).toBe("valid");
    expect(source).toBe("file");
  });

  it("两处都没有可用令牌时仍然报出找到载荷的那个来源", () => {
    const { token, source } = selectCredential(
      [
        [
          JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: 1 } }),
          "keychain",
        ],
        [undefined, "file"],
      ],
      NOW,
    );
    expect(token).toBeUndefined();
    // 一个过期的钥匙串令牌仍然该说「钥匙串」，而不是「未找到」。
    expect(source).toBe("keychain");
  });

  it("载荷解析不出来就是没有令牌", () => {
    expect(tokenFromPayload("not json", NOW)).toBeUndefined();
    expect(tokenFromPayload("{}", NOW)).toBeUndefined();
  });

  it("映射 CLI 显示的那两个窗口", () => {
    const usage = JSON.parse(`{
      "five_hour": {"utilization": 24.0, "resets_at": "2026-09-04T05:59:59.533960+00:00"},
      "seven_day": {"utilization": 36.4499, "resets_at": null},
      "seven_day_opus": null,
      "limits": [],
      "spend": {"used": {"amount_minor": 0}}
    }`) as ClaudeUsageResponse;
    const windows = claudeWindows(usage);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({
      key: "5h",
      label: "5h",
      usedPercent: 24,
      resetsAt: "2026-09-04T05:59:59.533960+00:00",
    });
    expect(windows[1]?.usedPercent).toBe(36.4);
    expect(windows[1]?.resetsAt).toBeNull();
  });

  it("保留每个模型自己的窗口，账号细节一个字都不带出来", () => {
    const usage = JSON.parse(`{
      "five_hour": {"utilization": 21, "resets_at": null},
      "seven_day_sonnet": {"utilization": 82, "resets_at": "2026-09-11T00:00:00Z"},
      "seven_day_opus": null,
      "seven_day_other": {"utilization": null},
      "extra_usage": {"utilization": 99},
      "account": {"email": "private@example.com"}
    }`) as ClaudeUsageResponse;
    const windows = claudeWindows(usage);
    expect(windows).toHaveLength(2);
    expect(windows[1]?.key).toBe("seven_day_sonnet");
    expect(windows[1]?.group).toBe("Sonnet");
    expect(windows[1]?.usedPercent).toBe(82);
    expect(JSON.stringify(windows)).not.toContain("private@example.com");
  });

  it("没有 utilization 的窗口被丢掉", () => {
    const usage = JSON.parse(
      `{"five_hour": {"utilization": null}, "seven_day": null}`,
    ) as ClaudeUsageResponse;
    expect(claudeWindows(usage)).toHaveLength(0);
  });
});

describe("Codex", () => {
  it("account_id 缺席时从未验证的 JWT 载荷里恢复", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      "utf8",
    ).toString("base64url");
    expect(accountIdFromJwt(`header.${payload}.signature`)).toBe("acct-1");
    expect(accountIdFromJwt("not.a.jwt")).toBeUndefined();
  });

  it("余额是字符串或数字都读得出来，负数被丢掉", () => {
    expect(codexCredits({ balance: 12.299_999_999_999_999 })).toEqual({
      balance: 12.3,
    });
    expect(codexCredits({ balance: "5.50" })).toEqual({ balance: 5.5 });
    expect(codexCredits({ balance: -1 })).toBeUndefined();
    expect(codexCredits({})).toBeUndefined();
  });

  it("主窗口与每个计费特性的窗口都被映射", () => {
    const report = codexReport(
      {
        rate_limit: {
          primary_window: { used_percent: 12.5, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 40, reset_after_seconds: 60 },
        },
        additional_rate_limits: [
          {
            metered_feature: "code",
            limit_name: "Code",
            rate_limit: {
              primary_window: {
                used_percent: 7,
                limit_window_seconds: 604_800,
              },
            },
          },
        ],
        credits: { balance: 3 },
      },
      NOW,
    );
    expect(report.windows.map((one) => one.key)).toEqual([
      "primary",
      "secondary",
      "code:primary",
    ]);
    expect(report.windows[0]?.label).toBe("5h");
    expect(report.windows[1]?.resetsAt).toBe(
      new Date(NOW + 60_000).toISOString(),
    );
    expect(report.windows[2]?.group).toBe("Code");
    expect(report.credits).toEqual({ balance: 3 });
  });

  it("CLI 兜底认两种拼法，认不出来就没有窗口而不是一个零", () => {
    expect(
      codexCliWindows(
        {
          rateLimits: {
            primary: { usedPercent: 33, windowMinutes: 300 },
            secondary: { used_percent: 12, limit_window_seconds: 604_800 },
          },
        },
        NOW,
      ).map((one) => [one.key, one.label, one.usedPercent]),
    ).toEqual([
      ["primary", "5h", 33],
      ["secondary", "7d", 12],
    ]);
    expect(codexCliWindows({ rateLimits: { primary: {} } }, NOW)).toHaveLength(
      0,
    );
    expect(codexCliWindows("nonsense", NOW)).toHaveLength(0);
  });
});

describe("Copilot", () => {
  const SAMPLE = JSON.parse(`{
    "access_type_sku": "copilot_enterprise_seat",
    "analytics_tracking_id": "tracking-1234",
    "assigned_date": "2026-01-04",
    "copilot_plan": "enterprise",
    "quota_reset_date": "2026-10-01",
    "quota_snapshots": {
      "chat": {"entitlement": 0, "percent_remaining": 100, "unlimited": true},
      "completions": {"entitlement": 0, "percent_remaining": 100, "unlimited": true},
      "premium_interactions": {"entitlement": 300, "percent_remaining": 17.4499, "unlimited": false}
    }
  }`);

  it("映射 premium interactions 并标出无上限的桶", () => {
    const windows = copilotWindows(SAMPLE);
    expect(windows).toHaveLength(3);
    const premium = windows.find((one) => one.key === "premium_interactions");
    expect(premium?.usedPercent).toBe(82.6);
    expect(premium?.unlimited).toBeUndefined();
    expect(premium?.label).toBe("premium interactions");
    expect(premium?.resetsAt).toBe("2026-10-01T00:00:00Z");
    // 无上限的桶带 `usedPercent: 0` **和** `unlimited: true`，好让看板打印
    // 「无限制」而不是一条空条。
    expect(windows.find((one) => one.key === "chat")?.unlimited).toBe(true);
    // 账号细节一个都不映射。
    expect(JSON.stringify(windows)).not.toContain("tracking-1234");
  });

  it("重置日期是 UTC 午夜，不是一个凭空发明的时区", () => {
    expect(copilotResetTimestamp("2026-10-01")).toBe("2026-10-01T00:00:00Z");
    expect(copilotResetTimestamp("not a date")).toBeNull();
  });
});
