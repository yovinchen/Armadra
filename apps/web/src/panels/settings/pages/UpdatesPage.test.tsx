import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create } from "@armadra/protocol";
import { CheckForUpdateResponseSchema } from "@armadra/protocol";

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

import { UpdatesPage, reasonKey, updatesFailureKey } from "./UpdatesPage";
import { usePreferencesStore } from "../../../app/preferences-store";
import { SETTINGS_SECTIONS } from "../nav";
import { HostAutomationError } from "@armadra/host-client";

function response(overrides: Record<string, unknown>) {
  return create(CheckForUpdateResponseSchema, {
    installedVersion: { major: 0, minor: 1, patch: 0, prerelease: "" },
    channel: 1,
    ...overrides,
  });
}

function ready(check: (input: unknown) => Promise<unknown>) {
  session.state = {
    status: "ready",
    client: { check },
    hello: { hostId: "a".repeat(32) },
  };
}

/** Clicks the check button only once the version query has enabled it. */
async function clickCheck() {
  const button = (await screen.findByRole("button", {
    name: "检查更新",
  })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdatesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  session.state = { status: "idle" };
  session.connect.mockClear();
  store.setPanel.mockClear();
  health.version = "0.1.0";
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

describe("UpdatesPage", () => {
  it("is an advanced settings section and stays idle until asked", async () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === "updates");
    expect(section?.groupKey).toBe("settings.group.advanced");
    expect(section?.labelKey).toBe("updates.nav");
    const check = vi.fn();
    ready(check);
    draw();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("尚未检查更新"),
    );
    expect(check).not.toHaveBeenCalled();
    expect(session.connect).toHaveBeenCalled();
  });

  // The whole point of the contract: a Host that never looked must not be
  // rendered as "up to date".
  it("says 未配置 when the Host reports UNSUPPORTED", async () => {
    ready(async () =>
      response({
        state: 3,
        reasonCode: "UPDATES_NOT_CONFIGURED",
      }),
    );
    draw();
    await clickCheck();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("未配置"),
    );
    expect(screen.queryByText("已是最新版本")).toBeNull();
    expect(
      screen.getByText(/没有配置发布来源，因此没有查询任何地方/),
    ).toBeTruthy();
  });

  it("reports an unreachable source without claiming anything about versions", async () => {
    ready(async () => response({ state: 4, reasonCode: "SOURCE_UNREACHABLE" }));
    draw();
    await clickCheck();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("无法确认"),
    );
    expect(screen.queryByText("已是最新版本")).toBeNull();
    expect(screen.queryByText("有新版本可用")).toBeNull();
  });

  it("shows an available release with its signature state and no install button", async () => {
    ready(async () =>
      response({
        state: 2,
        channel: 1,
        release: {
          version: { major: 0, minor: 2, patch: 0, prerelease: "" },
          channel: 1,
          notesUrl: "https://releases.invalid/v0.2.0",
          artifacts: [
            {
              target: "darwin-aarch64",
              url: "https://releases.invalid/a.tar.gz",
              sizeBytes: 2048n,
              signature: { state: 1, value: "", keyId: "" },
            },
          ],
        },
      }),
    );
    draw();
    await clickCheck();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("有新版本可用"),
    );
    expect(screen.getByText("0.2.0")).toBeTruthy();
    expect(screen.getByText(/发布包附带签名/)).toBeTruthy();
    expect(screen.getByText(/不自动下载或安装/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /安装/ })).toBeNull();
  });

  it("renders the blocked reason instead of a button that would fail", async () => {
    session.state = { status: "blocked", reason: "signedOut" };
    draw();
    expect(await screen.findByText("此设备尚未登录后台服务。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "前往后台服务设置" }));
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("host");
  });

  it("explains a failed request rather than showing a stale result", async () => {
    ready(async () => {
      throw new HostAutomationError("unauthenticated");
    });
    draw();
    await clickCheck();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "登录已失效，请重新登录后再试。",
      ),
    );
  });

  it("maps failures and reason codes to keys this build actually has", () => {
    expect(updatesFailureKey(new HostAutomationError("permission"))).toBe(
      "updates.error.permission",
    );
    expect(updatesFailureKey(new Error("boom"))).toBe("updates.error.network");
    expect(reasonKey("NO_ARTIFACT_FOR_TARGET")).toBe(
      "updates.reason.NO_ARTIFACT_FOR_TARGET",
    );
    // A token this version never heard of is never printed raw at a person.
    expect(reasonKey("SOMETHING_NEW")).toBe("updates.reason.unknown");
  });
});
