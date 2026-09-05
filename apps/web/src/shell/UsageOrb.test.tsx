import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { UsageOrb } from "./UsageOrb";
import { useUsage } from "../app/use-usage";

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

  it("键盘激活打开详情，刷新可聚焦，Escape 关闭并恢复焦点", async () => {
    renderOrb();
    const button = await orb();
    act(() => button.focus());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // Native buttons dispatch a detail=0 click for Enter/Space activation.
    fireEvent.click(button, { detail: 0 });
    await panel();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // 面板头部的第一个控件是「打开用量看板」，自动聚焦落在它身上。
    const first = screen.getByRole("button", { name: "打开用量看板" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    const refresh = screen.getByRole("button", { name: "刷新" });
    expect(refresh.tabIndex).toBe(0);
    act(() => refresh.focus());
    expect(document.activeElement).toBe(refresh);
    fireEvent.keyDown(refresh, { key: "Escape" });
    await waitFor(() =>
      expect(button.getAttribute("aria-expanded")).toBe("false"),
    );
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("悬停预览不抢焦点，点击已展开的预览不会立即关闭", async () => {
    renderOrb();
    const button = await orb();
    const previousFocus = document.activeElement;
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    await panel();
    expect(document.activeElement).toBe(previousFocus);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "打开用量看板" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭用量详情" }));
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
  it("模型额度按名称展示，并区分更新时间与重置时间", async () => {
    fetchUsage.mockResolvedValue({
      providers: [
        {
          id: "codex",
          status: "ok",
          fetchedAt: new Date().toISOString(),
          windows: [
            {
              key: "model:primary",
              group: "Model quota",
              label: "12h",
              usedPercent: 33,
              resetsAt,
            },
          ],
        },
      ],
      refreshAvailableAt: new Date(Date.now() + 30_000).toISOString(),
    } satisfies Usage);
    renderOrb();
    fireEvent.click(await orb());
    const text = (await panel()).textContent ?? "";
    expect(text).toContain("Model quota · 12h");
    expect(text).toContain("已用 33%");
    expect(text).toContain("更新于 刚刚");
    expect(text).toContain("重置于 3 小时后");
    expect(
      (screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("到期窗口不再贡献球心数字，刷新失败可见", async () => {
    fetchUsage.mockResolvedValue({
      providers: [
        {
          id: "codex",
          status: "ok",
          fetchedAt: new Date().toISOString(),
          windows: [
            {
              key: "primary",
              label: "5h",
              usedPercent: 99,
              resetsAt: new Date(Date.now() - 1000).toISOString(),
            },
          ],
        },
      ],
    } satisfies Usage);
    refreshUsage.mockRejectedValue(new Error("offline"));
    renderOrb();
    expect((await orb()).textContent).toBe("—");
    fireEvent.click(await orb());
    expect((await panel()).textContent).toContain("窗口已到期，等待刷新");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("刷新失败，请稍后重试")).toBeTruthy();
  });

  it("Gemini 保留模型名称，进度条准确表达已用配额", async () => {
    fetchUsage.mockResolvedValue({
      providers: [
        {
          id: "gemini",
          status: "ok",
          fetchedAt: new Date().toISOString(),
          windows: [
            {
              key: "gemini-pro:0",
              group: "gemini-pro",
              label: "quota",
              usedPercent: 24.6,
              resetsAt: null,
            },
          ],
        },
      ],
    } satisfies Usage);
    renderOrb();
    fireEvent.click(await orb());
    const text = (await panel()).textContent ?? "";
    expect(text).toContain("gemini-pro · 模型额度");
    expect(text).toContain("重置时间未知");
    const bar = screen.getByRole("progressbar", {
      name: "Gemini · gemini-pro · 模型额度",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("24.6");
    expect((await orb()).textContent).toBe("25%");
  });

  it("不同用量入口共享刷新状态和服务端冷却时间", async () => {
    let finish: (value: Usage) => void = () => {};
    refreshUsage.mockImplementation(
      () =>
        new Promise<Usage>((resolve) => {
          finish = resolve;
        }),
    );
    function OtherUsageSurface() {
      const { refreshing, cooldown } = useUsage();
      return (
        <button disabled={refreshing || cooldown > 0}>Other refresh</button>
      );
    }
    render(
      <TestProviders>
        <UsageOrb />
        <OtherUsageSurface />
      </TestProviders>,
    );
    fireEvent.click(await orb());
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Other refresh",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    finish({
      ...usage,
      refreshAvailableAt: new Date(Date.now() + 30_000).toISOString(),
    });
    await screen.findByText(/秒后可刷新/);
    expect(
      (
        screen.getByRole("button", {
          name: "Other refresh",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  it("另一入口刷新成功后清除之前的失败状态", async () => {
    refreshUsage
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(usage);
    function OtherUsageSurface() {
      const { refresh } = useUsage();
      return <button onClick={() => refresh.mutate()}>Other refresh</button>;
    }
    render(
      <TestProviders>
        <UsageOrb />
        <OtherUsageSurface />
      </TestProviders>,
    );
    fireEvent.click(await orb());
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("刷新失败，请稍后重试");
    fireEvent.click(screen.getByRole("button", { name: "Other refresh" }));
    await waitFor(() => expect(refreshUsage).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("刷新失败，请稍后重试")).toBeNull(),
    );
  });
});
