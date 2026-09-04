import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const getSettings = vi.fn();
const updateSettings = vi.fn();
const getUsage = vi.fn();
const refreshUsage = vi.fn();
vi.mock("../../../api/client", () => ({
  runtimeApi: {
    settings: () => getSettings(),
    updateSettings: (patch: unknown) => updateSettings(patch),
    usage: () => getUsage(),
    refreshUsage: () => refreshUsage(),
  },
}));

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { usePreferencesStore } from "../../../app/preferences-store";
import { AccountPage } from "./AccountPage";

installDomPolyfills();
afterEach(cleanup);

const emptyUsage = {
  providers: [
    { id: "claude", status: "unavailable", windows: [], fetchedAt: null },
  ],
};

describe("AccountPage usage controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({ locale: "zh-CN" });
    getSettings.mockResolvedValue({ usage: { enabled: false } });
    getUsage.mockResolvedValue(emptyUsage);
    refreshUsage.mockResolvedValue(emptyUsage);
  });

  it("暂停查询时不会把空快照显示成凭据丢失", async () => {
    render(
      <TestProviders>
        <AccountPage />
      </TestProviders>,
    );
    await screen.findByText("已暂停用量查询");
    expect(screen.queryByText("未找到可用的登录凭据")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("开关保存期间禁用，启用成功后才请求刷新", async () => {
    let finish: (value: unknown) => void = () => {};
    updateSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <TestProviders>
        <AccountPage />
      </TestProviders>,
    );
    await screen.findByText("已暂停用量查询");
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(true),
    );
    expect(refreshUsage).not.toHaveBeenCalled();
    finish({ usage: { enabled: true } });
    await waitFor(() => expect(refreshUsage).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ usage: { enabled: true } });
    expect(screen.queryByText("已暂停用量查询")).toBeNull();
  });
});
