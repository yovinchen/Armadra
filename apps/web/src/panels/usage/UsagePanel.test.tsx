import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AgentInfo } from "@armadra/shared";

const agents = vi.fn();

vi.mock("@/api/client", () => ({
  runtimeApi: { agents: (...args: unknown[]) => agents(...args) },
}));

import { UsagePanel } from "./UsagePanel";
import { HEAT_LEVELS, heatLevel, heatThresholds } from "./metrics";
import { sampleCostSummary } from "./cost-fixture";
import { TestProviders, installDomPolyfills } from "../../app/test-harness";
import { formatTokens, formatUsd, totalTokens } from "../../lib/cost";

/**
 * 用量面板的验收：
 *
 *  1. 卡片跟着范围走（默认 7 天，点 30 天换成 30 天的合计）；
 *  2. 指标开关切到费用时卡片给美元，且不再有「不完整」后缀；
 *  3. 没有本地来源的 Agent 走脚注，不画成空面积；
 *  4. 图例点一下聚焦那一条，其余变淡；
 *  5. 点柱子/热力格选中一个时间点，清除按钮与再点一次都能取消；
 *  6. 换范围时图表原地换数据，不重挂载；
 *  7. 统计栏给出会话数等九格，选中一个点时前六格跟着那个点走；
 *  8. 费用指标下环形图旁的图例列出模型名。
 *
 * jsdom 量不出尺寸，recharts 的 `ResponsiveContainer` 会渲染空；这里把
 * `ResizeObserver` 换成一个立刻回报固定尺寸的桩，图形才有 DOM 可断言。
 */

const registry: AgentInfo[] = [
  { id: "claude", label: "Claude Code", color: "#d97757" },
  { id: "codex", label: "Codex", color: "#10a37f" },
  { id: "opencode", label: "OpenCode", color: "#f59e0b" },
  { id: "pi", label: "Pi", color: "#8b5cf6" },
  { id: "omp", label: "Oh My Pi", color: "#22d3ee" },
  { id: "copilot", label: "GitHub Copilot", color: "#6b7280" },
].map((entry) => ({
  ...entry,
  launchCmd: entry.id,
  promptMode: "argv",
  capabilities: [],
  args: [],
  resolvedPath: null,
  installed: true,
})) as AgentInfo[];

const SIZE = { width: 320, height: 120 };
const originalObserver = globalThis.ResizeObserver;
const originalRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  installDomPolyfills();
  class SizedObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [
          {
            target,
            contentRect: { ...SIZE } as DOMRectReadOnly,
          } as ResizeObserverEntry,
        ],
        this,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = SizedObserver as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = function rect() {
    return {
      ...SIZE,
      top: 0,
      left: 0,
      right: SIZE.width,
      bottom: SIZE.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterAll(() => {
  globalThis.ResizeObserver = originalObserver;
  Element.prototype.getBoundingClientRect = originalRect;
});

afterEach(() => {
  cleanup();
  agents.mockReset();
});

function renderPanel() {
  agents.mockResolvedValue(registry);
  const summary = sampleCostSummary();
  render(
    <TestProviders>
      <UsagePanel summary={summary} />
    </TestProviders>,
  );
  return summary;
}

function card(metric: "tokens" | "cost"): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    `[data-slot="usage-card"][data-metric="${metric}"]`,
  );
  if (!node) throw new Error(`no ${metric} card`);
  return node;
}

function skylineWrapper(): Element {
  const node = document.querySelector(
    '[data-slot="usage-timeline"] .recharts-wrapper',
  );
  if (!node) throw new Error("no timeline wrapper");
  return node;
}

function stat(name: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    `[data-slot="usage-stat"][data-stat="${name}"]`,
  );
  if (!node) throw new Error(`no ${name} stat`);
  return node;
}

describe("用量面板", () => {
  it("默认 7 天，切到 30 天后卡片换成那一段的合计", async () => {
    const summary = renderPanel();
    const seven = summary.ranges["7d"];
    const thirty = summary.ranges["30d"];
    expect(formatTokens(totalTokens(seven.totals.tokens))).not.toBe(
      formatTokens(totalTokens(thirty.totals.tokens)),
    );

    expect(card("tokens").textContent).toContain(
      formatTokens(totalTokens(seven.totals.tokens)),
    );
    expect(card("tokens")).toHaveProperty("dataset.active", "true");

    fireEvent.click(screen.getByRole("radio", { name: "30 天" }));
    await waitFor(() =>
      expect(card("tokens").textContent).toContain(
        formatTokens(totalTokens(thirty.totals.tokens)),
      ),
    );
  });

  it("切到费用时卡片显示美元", async () => {
    const summary = renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: "费用" }));
    await waitFor(() =>
      expect(card("cost")).toHaveProperty("dataset.active", "true"),
    );
    await waitFor(() =>
      expect(card("cost").textContent).toContain(
        formatUsd(summary.ranges["7d"].totals.costUsd),
      ),
    );
    expect(summary.ranges["7d"].totals.complete).toBe(false);
    expect(card("cost").textContent).not.toContain("不完整");
  });

  it("没有本地来源的 Agent 只出现在脚注里", async () => {
    renderPanel();
    const section = await screen.findByRole("region", { name: "按 Agent" });
    // 名字来自 `/api/agents`，等注册表到了再看脚注。
    const note = await within(section).findByText(/OpenCode/);
    expect(note.textContent).toContain("暂无本地用量数据");
    expect(note.textContent).toContain("GitHub Copilot");
    const labels = within(section)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
    expect(labels.some((label) => label.includes("Claude Code"))).toBe(true);
    expect(labels.some((label) => label.includes("Pi"))).toBe(false);
  });

  it("点图例聚焦一条系列，其余变淡", async () => {
    renderPanel();
    const section = await screen.findByRole("region", { name: "按模型" });
    const items = within(section).getAllByRole("button");
    expect(items.length).toBeGreaterThan(1);
    expect(items.every((item) => item.dataset.dimmed === "false")).toBe(true);

    fireEvent.click(items[0] as HTMLElement);
    await waitFor(() => {
      expect(items[0]?.dataset.dimmed).toBe("false");
      expect(items[1]?.dataset.dimmed).toBe("true");
    });

    const areas = document.querySelectorAll(".recharts-area-area");
    expect(areas.length).toBeGreaterThan(0);

    fireEvent.click(items[0] as HTMLElement);
    await waitFor(() =>
      expect(items.every((item) => item.dataset.dimmed === "false")).toBe(true),
    );
  });

  it("点柱子选中那个时间点，清除按钮与再点一次都能取消", async () => {
    const summary = renderPanel();
    const seven = summary.ranges["7d"];
    const target = seven.points[2];
    if (!target) throw new Error("no point");

    const bars = document.querySelectorAll(".recharts-bar-rectangle");
    expect(bars.length).toBe(seven.points.length);
    fireEvent.click(bars[2] as Element);

    const clear = await screen.findByRole("button", { name: "清除选中" });
    await waitFor(() =>
      expect(card("tokens").textContent).toContain(
        formatTokens(totalTokens(target.tokens)),
      ),
    );
    expect(card("cost").textContent).toContain(formatUsd(target.costUsd));

    fireEvent.click(clear);
    await waitFor(() =>
      expect(card("tokens").textContent).toContain(
        formatTokens(totalTokens(seven.totals.tokens)),
      ),
    );
    expect(screen.queryByRole("button", { name: "清除选中" })).toBeNull();

    fireEvent.click(document.querySelectorAll(".recharts-bar-rectangle")[2]!);
    await screen.findByRole("button", { name: "清除选中" });
    fireEvent.click(document.querySelectorAll(".recharts-bar-rectangle")[2]!);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "清除选中" })).toBeNull(),
    );
  });

  it("全部档画热力图，点格子选中那一天", async () => {
    const summary = renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: "全部" }));

    const heatmap = await waitFor(() => {
      const node = document.querySelector('[data-slot="usage-heatmap"]');
      if (!node) throw new Error("no heatmap");
      return node;
    });
    expect(document.querySelector('[data-slot="usage-timeline"]')).toBeNull();
    expect(document.querySelector('[data-slot="usage-donut"]')).toBeTruthy();

    const cells = heatmap.querySelectorAll<HTMLElement>(
      '[data-slot="usage-heatmap-cell"]',
    );
    expect(cells.length).toBe(summary.ranges.all.points.length);

    const last = summary.ranges.all.points.at(-1);
    if (!last) throw new Error("no point");
    const cell = cells[cells.length - 1] as HTMLElement;
    expect(cell.dataset.key).toBe(last.key);
    expect(cell.getAttribute("aria-label")).toContain(last.key);

    fireEvent.click(cell);
    await waitFor(() => expect(cell.dataset.selected).toBe("true"));
    await waitFor(() =>
      expect(card("tokens").textContent).toContain(
        formatTokens(totalTokens(last.tokens)),
      ),
    );
    expect(card("tokens").textContent).toContain("9/20");

    fireEvent.click(cell);
    await waitFor(() => expect(cell.dataset.selected).toBe("false"));
  });

  it("换范围时图表原地换数据，不重挂载", async () => {
    const summary = renderPanel();
    const before = skylineWrapper();
    const areas = document.querySelectorAll('[data-slot="chart"]').length;

    fireEvent.click(screen.getByRole("radio", { name: "30 天" }));
    await waitFor(() =>
      expect(document.querySelectorAll(".recharts-bar-rectangle").length).toBe(
        summary.ranges["30d"].points.length,
      ),
    );
    expect(skylineWrapper()).toBe(before);

    fireEvent.click(screen.getByRole("radio", { name: "24 小时" }));
    await waitFor(() =>
      expect(document.querySelectorAll(".recharts-bar-rectangle").length).toBe(
        summary.ranges["24h"].points.length,
      ),
    );
    expect(skylineWrapper()).toBe(before);
    expect(document.querySelectorAll('[data-slot="chart"]').length).toBe(areas);
  });

  it("统计栏给出会话数，选中一个点后换成该点的会话数", async () => {
    const summary = renderPanel();
    const seven = summary.ranges["7d"];
    expect(seven.sessions).toBeGreaterThan(0);
    await waitFor(() =>
      expect(stat("sessions").textContent).toContain(String(seven.sessions)),
    );
    expect(stat("streak").textContent).toContain(String(seven.longestStreak));
    expect(stat("active").textContent).toContain(
      `${seven.activeIntervals}/${seven.points.length}`,
    );

    const target = seven.points[3];
    if (!target) throw new Error("no point");
    expect(target.sessions).not.toBe(seven.sessions);
    fireEvent.click(document.querySelectorAll(".recharts-bar-rectangle")[3]!);

    await waitFor(() =>
      expect(stat("sessions").textContent).toContain(String(target.sessions)),
    );
    await waitFor(() =>
      expect(stat("total").textContent).toContain(
        formatTokens(totalTokens(target.tokens)),
      ),
    );
    // 峰值/活跃/最长连续是范围的性质，选中一个点不改它们。
    expect(stat("streak").textContent).toContain(String(seven.longestStreak));
  });

  it("费用指标下环形图图例列出模型名", async () => {
    const summary = renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: "费用" }));
    const top = summary.ranges["7d"].byModel[0];
    if (!top) throw new Error("no model");
    await waitFor(() => {
      const labels = [
        ...document.querySelectorAll('[data-slot="usage-donut-legend-item"]'),
      ].map((node) => node.textContent ?? "");
      expect(labels.some((label) => label.includes(top.model))).toBe(true);
    });

    fireEvent.click(screen.getByRole("radio", { name: "Token" }));
    await waitFor(() => {
      const labels = [
        ...document.querySelectorAll('[data-slot="usage-donut-legend-item"]'),
      ].map((node) => node.textContent ?? "");
      expect(labels.some((label) => label.includes("缓存读"))).toBe(true);
    });
  });

  it("全部档的格子按四分位上色，不用不透明度", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: "全部" }));
    const cells = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>(
        '[data-slot="usage-heatmap-cell"]',
      );
      if (found.length === 0) throw new Error("no cells");
      return [...found];
    });
    const colors = new Set(cells.map((cell) => cell.style.backgroundColor));
    expect(colors.size).toBeGreaterThan(2);
    for (const color of colors) expect(HEAT_LEVELS).toContain(color);
    expect(cells.every((cell) => cell.style.opacity === "")).toBe(true);
  });
});

describe("热力分档", () => {
  it("按非零值的四分位分 1–4 档，极端峰值不会把其余压成最浅", () => {
    const levels = heatThresholds([1, 2, 3, 4, 100]);
    const got = [1, 2, 3, 4, 100].map((value) => heatLevel(value, levels));
    expect(got).toEqual([1, 1, 2, 3, 4]);
    expect(new Set(got).size).toBe(4);
    expect(heatLevel(0, levels)).toBe(0);
  });

  it("没有非零值时所有格子都是 0 档", () => {
    const levels = heatThresholds([0, 0, 0]);
    expect(heatLevel(0, levels)).toBe(0);
    expect(heatLevel(5, levels)).toBe(4);
  });
});
