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
const copilotAuth = vi.fn();
const copilotLogin = vi.fn();
const copilotPoll = vi.fn();
const copilotLogout = vi.fn();
vi.mock("../../../api/client", () => ({
  runtimeApi: {
    settings: () => getSettings(),
    updateSettings: (patch: unknown) => updateSettings(patch),
    usage: () => getUsage(),
    refreshUsage: () => refreshUsage(),
    copilotAuth: () => copilotAuth(),
    copilotLogin: () => copilotLogin(),
    copilotPoll: () => copilotPoll(),
    copilotLogout: () => copilotLogout(),
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
    copilotAuth.mockResolvedValue({ signedIn: false, backend: "keychain" });
  });

  /** 总开关：其余开关都有各自的 `aria-label`，只有它叫「获取用量」。 */
  const fetchSwitch = () => screen.getByRole("switch", { name: "获取用量" });

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
    const toggle = fetchSwitch();
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
  it("单个 provider 关掉后立刻重新取用量，只发那一个键", async () => {
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    updateSettings.mockResolvedValue({
      usage: { enabled: true, providers: { copilot: false } },
    });
    render(
      <TestProviders>
        <AccountPage />
      </TestProviders>,
    );
    const copilot = await screen.findByRole("switch", { name: "Copilot" });
    // 设置还没到之前每个控件都是禁用的，先等它可用再点。
    await waitFor(() =>
      expect((copilot as HTMLButtonElement).disabled).toBe(false),
    );
    // 归一化后 Runtime 会补齐四个键，但补丁只带用户动过的那一个。
    fireEvent.click(copilot);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        usage: { providers: { copilot: false } },
      }),
    );
    await waitFor(() => expect(refreshUsage).toHaveBeenCalledTimes(1));
  });

  it("刷新节奏选「手动」时保存 0 分钟", async () => {
    getSettings.mockResolvedValue({
      usage: { enabled: true, refreshMinutes: 5 },
    });
    updateSettings.mockResolvedValue({ usage: { refreshMinutes: 0 } });
    render(
      <TestProviders>
        <AccountPage />
      </TestProviders>,
    );
    // Radix Select 在 jsdom 里不好驱动，所以直接断言它读到的当前值，
    // 保存路径由下面的 Copilot 用例覆盖同一条 `save.mutate`。
    await screen.findByText("每 5 分钟");
    expect(screen.getByText("刷新节奏")).toBeTruthy();
  });

  it("Copilot 登录显示用户码，且不显示任何 device code", async () => {
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    copilotLogin.mockResolvedValue({
      signedIn: false,
      backend: "keychain",
      pending: {
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        intervalSeconds: 5,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
    render(
      <TestProviders>
        <AccountPage />
      </TestProviders>,
    );
    const signIn = await screen.findByRole("button", { name: "登录" });
    await waitFor(() =>
      expect((signIn as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(signIn);
    await screen.findByText("WDJB-MJHT");
    expect(screen.getByText(/github\.com\/login\/device/)).toBeTruthy();
    // 登录进行中按钮变成登出的前提是已登录；这里还没有。
    expect(screen.queryByRole("button", { name: "登出" })).toBeNull();
  });

  it("已登录时提供登出，文件后端会说明这是降级", async () => {
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    copilotAuth.mockResolvedValue({ signedIn: true, backend: "file" });
    copilotLogout.mockResolvedValue({ signedIn: false, backend: "file" });
    render(
      <TestProviders>
        <AccountPage />
      </TestProviders>,
    );
    const signOut = await screen.findByRole("button", { name: "登出" });
    await waitFor(() =>
      expect((signOut as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(signOut);
    await waitFor(() => expect(copilotLogout).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText("本平台没有可用的钥匙串，令牌存在权限 0600 的文件里。"),
    ).toBeTruthy();
  });
});
