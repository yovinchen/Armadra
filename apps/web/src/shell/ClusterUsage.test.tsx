import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Usage } from "@armadra/shared";

const fetchUsage = vi.fn();
const refreshUsage = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: {
    usage: () => fetchUsage(),
    refreshUsage: () => refreshUsage(),
  },
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { ClusterUsage } from "./ClusterUsage";

installDomPolyfills();
afterEach(cleanup);

/** 未来的重置时间，让窗口不算作已过期。 */
const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();

const usage: Usage = {
  providers: [
    {
      id: "claude",
      status: "ok",
      fetchedAt: new Date().toISOString(),
      windows: [
        { key: "5h", label: "5h", usedPercent: 24, resetsAt },
        { key: "7d", label: "7d", usedPercent: 82, resetsAt },
      ],
    },
    {
      id: "codex",
      status: "ok",
      fetchedAt: new Date().toISOString(),
      windows: [{ key: "primary", label: "7d", usedPercent: 96, resetsAt }],
    },
  ],
};

function renderDock() {
  return render(
    <TestProviders>
      <ClusterUsage />
    </TestProviders>,
  );
}

describe("ClusterUsage", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ showUsage: true, locale: "zh-CN" });
    useCanvasStore.setState((state) => ({
      panels: { ...state.panels, usage: "closed" },
    }));
    fetchUsage.mockReset().mockResolvedValue(usage);
    refreshUsage.mockReset().mockResolvedValue(usage);
  });

  /**
   * F9：环取所有 provider 所有窗口里的**最高**占用，颜色按 §19 的
   * 80 / 95 两道阈值；数字之外的一切走无障碍名。
   */
  it("shows the highest window as a ring coloured by the thresholds", async () => {
    renderDock();
    const button = await screen.findByRole("button", { name: /^用量/ });
    expect(button.textContent).toBe("96");
    expect(button.getAttribute("data-level")).toBe("danger");
    expect(button.getAttribute("aria-label")).toContain("Claude");
    expect(button.getAttribute("aria-label")).toContain("Codex");
  });

  it("opens the usage panel rather than a floating popover", async () => {
    renderDock();
    fireEvent.click(await screen.findByRole("button", { name: /^用量/ }));
    expect(useCanvasStore.getState().panels.usage).toBe("drawer");
  });

  /**
   * 关掉「显示用量」之后不再轮询，也不画一个永远是 `—` 的环——但面板仍然
   * 要够得到：重新打开轮询的开关就在里面那一页的隔壁。
   */
  it("falls back to a plain gauge when usage is switched off", () => {
    usePreferencesStore.setState({ showUsage: false });
    renderDock();
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^用量 / })).toBeNull();
    const button = screen.getByRole("button", { name: "打开用量看板" });
    fireEvent.click(button);
    expect(useCanvasStore.getState().panels.usage).toBe("drawer");
  });
});
