import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Usage } from "@ai-coding-canvas/shared";

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
import { UsageOrb } from "./UsageOrb";

installDomPolyfills();
afterEach(cleanup);

/** 未来的重置时间，让倒计时有东西可算。 */
const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();

const usage: Usage = {
  providers: [
    {
      id: "claude",
      status: "ok",
      fetchedAt: new Date().toISOString(),
      windows: [
        { key: "5h", label: "5h", usedPercent: 24, resetsAt },
        { key: "7d", label: "7d", usedPercent: 82, resetsAt: null },
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

function renderOrb() {
  return render(
    <TestProviders>
      <UsageOrb />
    </TestProviders>,
  );
}

const orb = () => screen.findByRole("button", { name: /^用量/ });
const panel = () =>
  screen.findByText(
    (_, node) => node?.getAttribute("data-slot") === "usage-panel",
  );

describe("UsageOrb", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ showUsage: true, locale: "zh-CN" });
    fetchUsage.mockReset().mockResolvedValue(usage);
    refreshUsage.mockReset().mockResolvedValue(usage);
  });

  it("球心显示最高占用，环色按阈值取危险色", async () => {
    renderOrb();
    const button = await orb();
    expect(button.textContent).toBe("96%");
    expect(button.getAttribute("data-level")).toBe("danger");
    expect(button.getAttribute("style")).toContain("conic-gradient");
  });

  it("无障碍名称里带完整摘要", async () => {
    renderOrb();
    const label = (await orb()).getAttribute("aria-label") ?? "";
    expect(label).toContain("Claude");
    expect(label).toContain("24%");
    expect(label).toContain("82%");
    expect(label).toContain("Codex");
    expect(label).toContain("96%");
  });

  it("<80 用品牌色，80–95 用警告色", async () => {
    fetchUsage.mockResolvedValue({
      providers: [
        {
          id: "claude",
          status: "ok",
          fetchedAt: new Date().toISOString(),
          windows: [{ key: "5h", label: "5h", usedPercent: 81, resetsAt }],
        },
      ],
    } satisfies Usage);
    renderOrb();
    expect((await orb()).getAttribute("data-level")).toBe("warn");

    cleanup();
    fetchUsage.mockResolvedValue({
      providers: [
        {
          id: "claude",
          status: "ok",
          fetchedAt: new Date().toISOString(),
          windows: [{ key: "5h", label: "5h", usedPercent: 12, resetsAt }],
        },
      ],
    } satisfies Usage);
    renderOrb();
    expect((await orb()).getAttribute("data-level")).toBe("normal");
  });

  it("悬停展开面板：每个窗口一行 + 重置倒计时 + 刷新按钮", async () => {
    renderOrb();
    fireEvent.pointerEnter(await orb(), { pointerType: "mouse" });

    const text = (await panel()).textContent ?? "";
    expect(text).toContain("Claude");
    expect(text).toContain("5 小时");
    expect(text).toContain("Codex");
    expect(text).toContain("重置于 3 小时后");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(refreshUsage).toHaveBeenCalledTimes(1));
  });

  it("键盘聚焦也展开，再点击可收起", async () => {
    renderOrb();
    const button = await orb();
    fireEvent.focus(button);
    await panel();
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    await waitFor(() =>
      expect(button.getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("设置里关掉时整体不渲染，也不请求", async () => {
    usePreferencesStore.setState({ showUsage: false });
    const { container } = renderOrb();
    await waitFor(() =>
      expect(container.querySelector("[data-slot='usage-orb']")).toBeNull(),
    );
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("所有 provider 都没有凭据时不渲染", async () => {
    fetchUsage.mockResolvedValue({
      providers: [
        { id: "claude", status: "unavailable", windows: [], fetchedAt: null },
        { id: "codex", status: "unavailable", windows: [], fetchedAt: null },
      ],
    } satisfies Usage);
    const { container } = renderOrb();
    await waitFor(() => expect(fetchUsage).toHaveBeenCalled());
    expect(container.querySelector("[data-slot='usage-orb']")).toBeNull();
  });

  it("全部取不到时球心显示横线，环走中性色", async () => {
    fetchUsage.mockResolvedValue({
      providers: [
        {
          id: "claude",
          status: "error",
          windows: [],
          fetchedAt: new Date().toISOString(),
        },
        { id: "codex", status: "unavailable", windows: [], fetchedAt: null },
      ],
    } satisfies Usage);
    renderOrb();
    const button = await orb();
    expect(button.textContent).toBe("—");
    expect(button.getAttribute("data-level")).toBe("none");
    expect(button.getAttribute("aria-label")).toContain("取不到用量");
  });
});
