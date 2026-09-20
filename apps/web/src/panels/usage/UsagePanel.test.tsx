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
import { sampleCostSummary } from "./cost-fixture";
import { TestProviders, installDomPolyfills } from "../../app/test-harness";
import { formatTokens, formatUsd, totalTokens } from "../../lib/cost";

/**
 * 用量面板的四条验收：
 *
 *  1. 卡片跟着范围走（默认 7 天，点 30 天换成 30 天的合计）；
 *  2. 指标开关切到费用时卡片给美元；
 *  3. 没有本地来源的 Agent 走脚注，不画成空面积；
 *  4. 图例点一下聚焦那一条，其余变淡。
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
});
