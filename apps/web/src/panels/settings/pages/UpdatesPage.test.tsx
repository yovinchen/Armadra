import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  ShellOffer,
  ShellUpdateState,
} from "../../../updates/shell-updater";

const session = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
  connect: vi.fn(async () => {}),
  reset: vi.fn(),
}));

const store = vi.hoisted(() => ({
  panels: { settings: true },
  setPanel: vi.fn(),
}));

const health = vi.hoisted(() => ({ version: "0.1.0" as string | undefined }));

/** The two halves the page merges, driven directly. */
const updates = vi.hoisted(() => ({
  host: { kind: "notAsked" } as Record<string, unknown>,
  shell: { state: "idle" } as Record<string, unknown>,
  restart: null as Record<string, unknown> | null,
  start: vi.fn(() => () => undefined),
  check: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  acknowledgeRestart: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  data: {
    updates: {
      channel: "stable",
      autoCheck: true,
      autoDownload: false,
      notify: true,
    },
  },
}));
const save = vi.hoisted(() => ({ mutate: vi.fn() }));

const opened = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock("../../../host/updates-session", () => {
  const useUpdatesSession = <T,>(selector: (state: typeof session) => T) =>
    selector(session);
  useUpdatesSession.getState = () => session;
  return { useUpdatesSession, UPDATES_PERMISSION: "updates:read" };
});

vi.mock("../../../store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("../../../api/client", () => ({
  runtimeApi: { health: async () => ({ version: health.version }) },
}));

vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({ settings, save }),
}));

vi.mock("../../../platform", () => ({
  openExternal: async (url: string) => {
    opened.urls.push(url);
  },
  isDesktop: () => true,
  // `updates/shell-updater.ts` 还在用旧名字（W5 之前不动它），而它是
  // `isDesktop()` 的别名，所以这里两个名字都给。
  isTauri: () => true,
}));

vi.mock("../../../updates/use-update-state", () => {
  const useUpdateState = <T,>(selector: (state: typeof updates) => T) =>
    selector(updates);
  useUpdateState.getState = () => updates;
  return {
    useUpdateState,
    CHECK_INTERVAL_MS: 21_600_000,
    FIRST_CHECK_DELAY_MS: 30_000,
  };
});

import { UpdatesPage } from "./UpdatesPage";
import { usePreferencesStore } from "../../../app/preferences-store";
import { SETTINGS_SECTIONS } from "../nav";

const offer: ShellOffer = {
  version: "0.2.0",
  target: "darwin-aarch64",
  manifestUrl: "https://releases.invalid/download/v0.2.0/latest.json",
  packageUrl:
    "https://releases.invalid/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
  sha256: "a".repeat(64),
  sizeBytes: 4_194_304,
  signed: true,
  notesUrl: "https://releases.invalid/v0.2.0",
};

function draw(shell: ShellUpdateState, host?: Record<string, unknown>) {
  updates.shell = shell as unknown as Record<string, unknown>;
  if (host) updates.host = host;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdatesPage />
    </QueryClientProvider>,
  );
}

function answered(verdict: string, reasonCode = "") {
  return {
    kind: "answered",
    verdict,
    reasonCode,
    retryAfterMs: 0,
    checkedAtMs: 1,
    release: null,
  };
}

function status() {
  return screen.getByRole("status").textContent;
}

beforeEach(() => {
  session.state = { status: "ready", client: { check: vi.fn() } };
  session.connect.mockClear();
  store.setPanel.mockClear();
  save.mutate.mockClear();
  updates.check.mockClear();
  updates.download.mockClear();
  updates.install.mockClear();
  updates.dismiss.mockClear();
  updates.cancel.mockClear();
  updates.host = { kind: "notAsked" };
  updates.restart = null;
  settings.data = {
    updates: {
      channel: "stable",
      autoCheck: true,
      autoDownload: false,
      notify: true,
    },
  };
  opened.urls.length = 0;
  health.version = "0.1.0";
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

describe("UpdatesPage", () => {
  it("is an advanced settings section and stays idle until asked", async () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === "updates");
    expect(section?.groupKey).toBe("settings.group.advanced");
    expect(section?.labelKey).toBe("updates.nav");
    draw({ state: "idle" });
    await waitFor(() => expect(status()).toBe("尚未检查更新"));
    expect(updates.check).not.toHaveBeenCalled();
    expect(session.connect).toHaveBeenCalled();
  });

  /** One rendering assertion per state of design §4.1. */
  it("renders each of the eleven states with its own sentence", async () => {
    const cases: [ShellUpdateState, Record<string, unknown>, string][] = [
      [
        { state: "notConfigured", missing: { pubkey: true, endpoints: true } },
        answered("upToDate"),
        "未配置",
      ],
      [{ state: "localBuild" }, answered("upToDate"), "本地构建"],
      [
        { state: "unsupported", reason: "notDesktop" },
        answered("available"),
        "此环境不能自动更新",
      ],
      [{ state: "idle" }, { kind: "notAsked" }, "尚未检查更新"],
      [{ state: "checking" }, { kind: "checking" }, "正在检查…"],
      [
        { state: "upToDate", checkedAtMs: 1 },
        answered("upToDate"),
        "已是最新版本",
      ],
      [
        {
          state: "unavailable",
          reason: "sourceUnreachable",
          retryAfterMs: 900_000,
          checkedAtMs: 1,
        },
        answered("unavailable", "SOURCE_UNREACHABLE"),
        "无法确认",
      ],
      [{ state: "available", offer }, answered("available"), "有新版本可用"],
      [
        {
          state: "downloading",
          offer,
          receivedBytes: 1_048_576,
          totalBytes: 4_194_304,
        },
        answered("available"),
        "正在下载",
      ],
      [
        { state: "downloaded", offer, phase: "ready", problem: null },
        answered("available"),
        "已下载，重启后生效",
      ],
      [
        { state: "failed", reason: "digestMismatch", offer },
        answered("available"),
        "更新失败",
      ],
    ];
    for (const [shell, host, expected] of cases) {
      draw(shell, host);
      await waitFor(() => expect(status()).toBe(expected));
      cleanup();
    }
  });

  // The whole point of the contract: a check nobody completed must never be
  // rendered as "up to date".
  it("never says 已是最新 when only one side answered", async () => {
    draw(
      { state: "upToDate", checkedAtMs: 1 },
      answered("unavailable", "SOURCE_UNREACHABLE"),
    );
    await waitFor(() => expect(status()).toBe("无法确认"));
    expect(screen.queryByText("已是最新版本")).toBeNull();
    expect(screen.getByText("后台服务未给出结果。")).toBeTruthy();
    expect(screen.getByText("无法读取发布来源，请稍后重试。")).toBeTruthy();
  });

  it("says which half of the updater configuration is missing", async () => {
    draw(
      { state: "notConfigured", missing: { pubkey: true, endpoints: false } },
      answered("upToDate"),
    );
    await waitFor(() => expect(status()).toBe("未配置"));
    expect(
      screen.getByText("此构建没有内置签名公钥，无法验证任何安装包。"),
    ).toBeTruthy();
    expect(screen.queryByText(/没有内置发布地址/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "前往后台服务设置" }));
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("host");
  });

  it("routes a blocked session to the background service settings", async () => {
    session.state = { status: "blocked", reason: "signedOut" };
    draw({ state: "idle" }, { kind: "blocked", reason: "signedOut" });
    expect(await screen.findByText("此设备尚未登录后台服务。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  });

  it("downloads, skips and restarts through the shell", async () => {
    draw({ state: "available", offer }, answered("available"));
    await waitFor(() => expect(status()).toBe("有新版本可用"));
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(updates.download).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "跳过此版本" }));
    expect(updates.dismiss).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看发布说明" }));
    await waitFor(() =>
      expect(opened.urls).toEqual(["https://releases.invalid/v0.2.0"]),
    );

    cleanup();
    draw(
      { state: "downloaded", offer, phase: "ready", problem: null },
      answered("available"),
    );
    await waitFor(() => expect(status()).toBe("已下载，重启后生效"));
    expect(screen.getByText(/终端会话会保留/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重启并更新" }));
    expect(updates.install).toHaveBeenCalled();
  });

  it("offers nothing to press while the restart is under way", async () => {
    draw(
      { state: "downloaded", offer, phase: "installing", problem: null },
      answered("available"),
    );
    await waitFor(() => expect(status()).toBe("已下载，重启后生效"));
    expect(screen.queryByRole("button", { name: "重启并更新" })).toBeNull();
  });

  it("cancels a transfer and keeps the offer to restart it from", async () => {
    draw(
      {
        state: "downloading",
        offer,
        receivedBytes: 1_048_576,
        totalBytes: 4_194_304,
      },
      answered("available"),
    );
    await waitFor(() => expect(status()).toBe("正在下载"));
    // Downloading again is not on offer: it would start a second transfer.
    expect(screen.queryByRole("button", { name: "下载" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(updates.cancel).toHaveBeenCalled();
  });

  it("cancels a check that is still in flight", async () => {
    draw({ state: "checking" }, { kind: "checking" });
    await waitFor(() => expect(status()).toBe("正在检查…"));
    // Every other button is disabled while checking; this one has to work,
    // or the state would be a dead end until the request times out.
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(cancel.hasAttribute("disabled")).toBe(false);
    fireEvent.click(cancel);
    expect(updates.cancel).toHaveBeenCalled();
  });

  it("shows the transfer as bytes rather than a fraction of nothing", async () => {
    draw(
      { state: "downloading", offer, receivedBytes: 1_048_576, totalBytes: 0 },
      answered("available"),
    );
    await waitFor(() => expect(screen.getByText("1.0 MB")).toBeTruthy());
  });

  it("persists the channel and the two switches to the runtime settings", async () => {
    draw({ state: "idle" });
    const auto = await screen.findByRole("switch", { name: "自动检查更新" });
    fireEvent.click(auto);
    expect(save.mutate).toHaveBeenCalledWith({ updates: { autoCheck: false } });
    fireEvent.click(screen.getByRole("switch", { name: "自动下载更新" }));
    expect(save.mutate).toHaveBeenCalledWith({
      updates: { autoDownload: true },
    });
    // Turning the notification off leaves the tray item: the design keeps one
    // way of learning a restart is waiting without opening this page.
    fireEvent.click(screen.getByRole("switch", { name: "下载完成后通知" }));
    expect(save.mutate).toHaveBeenCalledWith({ updates: { notify: false } });
  });

  it("reports a restart that did not deliver what it promised", async () => {
    updates.restart = {
      outcome: "incomplete",
      mismatched: ["host"],
      expectedVersion: "0.2.0",
      previousVersion: "0.1.0",
      previousPackageUrl:
        "https://releases.invalid/download/v0.1.0/Armadra.dmg",
    };
    draw({ state: "idle" });
    expect(
      await screen.findByText(/更新未完成：后台服务 没有报告新版本/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "0.1.0" }));
    await waitFor(() =>
      expect(opened.urls).toEqual([
        "https://releases.invalid/download/v0.1.0/Armadra.dmg",
      ]),
    );
  });
});
