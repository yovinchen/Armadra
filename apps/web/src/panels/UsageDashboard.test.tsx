import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const getSettings = vi.fn();
const getUsage = vi.fn();
const refreshUsage = vi.fn();
const usageCost = vi.fn();
const refreshUsageCost = vi.fn();
const agents = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: {
    settings: () => getSettings(),
    updateSettings: vi.fn(),
    usage: () => getUsage(),
    refreshUsage: () => refreshUsage(),
    usageCost: () => usageCost(),
    refreshUsageCost: () => refreshUsageCost(),
    agents: () => agents(),
  },
}));

import { TestProviders, installDomPolyfills } from "../app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { UsageDashboard } from "./UsageDashboard";

installDomPolyfills();
afterEach(cleanup);

const tokens = (input: number) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
});

/** 30 天轴，只有最后一天（今天）有活动。 */
function daily() {
  return Array.from({ length: 30 }, (_, index) => {
    const last = index === 29;
    return {
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      tokens: tokens(last ? 1_000_000 : 0),
      costUsd: last ? 5 : 0,
      complete: !last,
      models: last
        ? [
            { model: "claude-opus-5", tokens: tokens(1_000_000), costUsd: 5 },
            { model: "gpt-5-codex", tokens: tokens(400), costUsd: null },
          ]
        : [],
    };
  });
}

const window30 = {
  tokens: tokens(1_000_400),
  costUsd: 5,
  complete: false,
  models: [
    { model: "claude-opus-5", tokens: tokens(1_000_000), costUsd: 5 },
    { model: "gpt-5-codex", tokens: tokens(400), costUsd: null },
  ],
};

/** 多维度范围：形状照契约给全，断言只用得上合计与 `byAgent` 的来源标记。 */
function range(points: ReturnType<typeof daily>) {
  return {
    granularity: "day" as const,
    points: points.map((day) => ({
      key: day.date,
      sessions: day.costUsd > 0 ? 3 : 0,
      tokens: day.tokens,
      costUsd: day.costUsd,
      complete: day.complete,
      models: day.models,
      agents: [
        {
          agent: "claude",
          tokens: day.tokens,
          costUsd: day.costUsd,
          complete: day.complete,
          source: "local" as const,
        },
        {
          agent: "opencode",
          tokens: tokens(0),
          costUsd: 0,
          complete: true,
          source: "none" as const,
        },
      ],
    })),
    totals: window30,
    byModel: window30.models,
    byAgent: [
      {
        agent: "claude",
        tokens: tokens(1_000_400),
        costUsd: 5,
        complete: false,
        source: "local" as const,
      },
      {
        agent: "opencode",
        tokens: tokens(0),
        costUsd: 0,
        complete: true,
        source: "none" as const,
      },
    ],
    peak: { key: "2026-08-30", tokens: tokens(1_000_000), costUsd: 5 },
    activeIntervals: 1,
    longestStreak: 1,
    sessions: 3,
  };
}

const summary = {
  status: "ok" as const,
  today: window30,
  last30Days: window30,
  daily: daily(),
  ranges: {
    "24h": range(daily().slice(-1)),
    "7d": range(daily().slice(-7)),
    "30d": range(daily()),
    all: range(daily()),
  },
  unpricedModels: ["gpt-5-codex"],
  files: { claude: 1, codex: 1 },
  truncated: false,
  scannedAt: "2026-09-05T10:00:00Z",
};

describe("UsageDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({ locale: "zh-CN" });
    useCanvasStore.setState((state) => ({
      panels: { ...state.panels, usage: "pinned" },
    }));
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    agents.mockResolvedValue([]);
    getUsage.mockResolvedValue({ providers: [] });
    refreshUsage.mockResolvedValue({ providers: [] });
    usageCost.mockResolvedValue(summary);
    refreshUsageCost.mockResolvedValue(summary);
  });

  it("本地成本走新面板：金额不带后缀，没有价格的模型进脚注", async () => {
    render(
      <TestProviders>
        <UsageDashboard />
      </TestProviders>,
    );
    await screen.findByRole("heading", { name: "用量分布" });
    expect(screen.getAllByText("$5.00").length).toBeGreaterThan(0);
    // 模型在「按模型」的图例里，加上下方「没有价格的模型」那句提示。
    expect(screen.getAllByText(/gpt-5-codex/).length).toBe(2);
    expect(screen.getByText(/没有价格的模型只统计 token/)).toBeTruthy();
  });

  it("范围开关在看板里可用，切到 24 小时不丢卡片", async () => {
    render(
      <TestProviders>
        <UsageDashboard />
      </TestProviders>,
    );
    await screen.findByRole("heading", { name: "用量分布" });
    fireEvent.click(screen.getByRole("radio", { name: "24 小时" }));
    expect(
      screen.getByRole("radio", { name: "24 小时" }).getAttribute("data-state"),
    ).toBe("on");
    expect(screen.getAllByText("$5.00").length).toBeGreaterThan(0);
  });

  it("provider 卡上的错误与过期状态不会显示成 0%", async () => {
    getUsage.mockResolvedValue({
      providers: [
        {
          id: "copilot",
          status: "error",
          credentialSource: "file",
          windows: [],
          fetchedAt: null,
        },
        {
          id: "claude",
          status: "ok",
          credentialSource: "keychain",
          // 很久以前采集的：`lib/usage` 判定为过期。
          fetchedAt: "2020-01-01T00:00:00Z",
          windows: [
            { key: "5h", label: "5h", usedPercent: 40, resetsAt: null },
          ],
        },
      ],
    });
    const { container } = render(
      <TestProviders>
        <UsageDashboard />
      </TestProviders>,
    );
    await screen.findByText("取不到用量");
    expect(screen.getByText("数据已过期，请刷新")).toBeTruthy();
    const stale = container.querySelector(
      "[data-provider='claude'] [role='progressbar']",
    );
    expect(stale?.getAttribute("aria-valuenow")).toBeNull();
    expect(stale?.textContent).toBe("");
  });

  /**
   * 「没有凭据」过去只有一句陈述。登录入口不在这块面板里——Copilot 在设置
   * 页，其余在各自的 CLI——所以这一行必须说清楚去哪儿登。
   */
  it("没有凭据的 provider 也要说清楚去哪儿登录", async () => {
    getUsage.mockResolvedValue({
      providers: [
        {
          id: "copilot",
          status: "unavailable",
          credentialSource: "none",
          windows: [],
          fetchedAt: null,
        },
        {
          id: "codex",
          status: "unavailable",
          credentialSource: "none",
          windows: [],
          fetchedAt: null,
        },
      ],
    });
    render(
      <TestProviders>
        <UsageDashboard />
      </TestProviders>,
    );
    await screen.findByText(
      "在「设置 → 账号与用量」里登录 Copilot，然后回来刷新",
    );
    expect(
      screen.getByText("在 Codex 的 CLI 里登录一次，然后回来刷新"),
    ).toBeTruthy();
  });

  it("关掉成本统计时说明原因，不显示 $0.00", async () => {
    getSettings.mockResolvedValue({
      usage: { enabled: true, cost: { enabled: false } },
    });
    render(
      <TestProviders>
        <UsageDashboard />
      </TestProviders>,
    );
    await screen.findByText("已关闭本地成本统计");
    expect(screen.queryByText("用量分布")).toBeNull();
    expect(usageCost).not.toHaveBeenCalled();
  });
});
