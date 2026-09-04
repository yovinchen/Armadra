import { describe, expect, it } from "vitest";
import type { UsageProvider, UsageWindow } from "@armadra/shared";
import { t, usePreferencesStore } from "../app/preferences-store";
import { usagePercent, usageResetLabel, usageWindowLabel } from "./usage";

const now = Date.parse("2026-09-05T10:00:00Z");
const window: UsageWindow = {
  key: "other:primary",
  label: "12h",
  group: "Model quota",
  usedPercent: 21,
  resetsAt: "2026-09-05T11:00:00Z",
};
const provider: UsageProvider = {
  id: "codex",
  status: "ok",
  windows: [window],
  fetchedAt: "2026-09-05T09:59:00Z",
};

describe("usage presentation", () => {
  it("preserves model names and unknown duration labels", () => {
    expect(usageWindowLabel(t, window)).toBe("Model quota · 12h");
  });
  it("does not present expired or stale usage as live quota", () => {
    expect(usagePercent(provider, window, now)).toBe(21);
    expect(
      usagePercent(
        provider,
        { ...window, resetsAt: new Date(now).toISOString() },
        now,
      ),
    ).toBeNull();
    expect(
      usagePercent(
        { ...provider, fetchedAt: "2026-09-05T09:00:00Z" },
        window,
        now,
      ),
    ).toBeNull();
    expect(
      usagePercent({ ...provider, status: "error" }, window, now),
    ).toBeNull();
    expect(
      usagePercent(provider, { ...window, usedPercent: NaN }, now),
    ).toBeNull();
  });
  it("labels reset boundaries and absent timestamps explicitly", () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    expect(usageResetLabel(t, window, now)).toBe("重置于 1 小时后");
    expect(usageResetLabel(t, window, now + 3600_000)).toBe(
      "窗口已到期，等待刷新",
    );
    expect(usageResetLabel(t, { ...window, resetsAt: null }, now)).toBe(
      "重置时间未知",
    );
  });
});
