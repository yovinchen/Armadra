import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostIdentitySession, HelloResponse } from "@armadra/host-client";
import { hostIdentity } from "../../../i18n/host-identity";
import { hostNative } from "../../../i18n/host-native";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@armadra/host-client", async (original) => {
  const actual = await original<typeof import("@armadra/host-client")>();
  return {
    ...actual,
    HostIdentityClient: class {
      constructor(options: unknown) {
        return mocks.create(options);
      }
    },
  };
});
// Test this standalone module before its parent page's registration is merged.
vi.mock("../../../app/preferences-store", async (original) => {
  const actual =
    await original<typeof import("../../../app/preferences-store")>();
  return {
    ...actual,
    useT: () => {
      const locale = actual.usePreferencesStore((state) => state.locale);
      return (key: string, values: Record<string, string | number> = {}) => {
        let result =
          hostIdentity[locale][key] ?? hostNative[locale][key] ?? key;
        for (const [name, value] of Object.entries(values))
          result = result.replaceAll(`{${name}}`, String(value));
        return result;
      };
    },
  };
});

import { HostIdentityPanel } from "./HostIdentityPanel";
import { HostIdentityError } from "@armadra/host-client";
import { usePreferencesStore } from "../../../app/preferences-store";
import {
  HostNativeSessionError,
  resetNativeSession,
} from "../../../host/native-session";

const origin = "https://host.test";
const hostId = "1".repeat(32),
  hostInstanceId = "2".repeat(32),
  deviceId = "3".repeat(32),
  otherId = "4".repeat(32);
const hello: HelloResponse = {
  $typeName: "armadra.v1.HelloResponse",
  hostId,
  hostInstanceId,
  protocol: { $typeName: "armadra.v1.ProtocolVersion", major: 1, minor: 1 },
  capabilities: ["identity.browser-session.v1"],
  capabilityStatus: [],
  maxFrameBytes: 1_048_576,
};
const session: HostIdentitySession = {
  $typeName: "armadra.v1.AuthenticatedSession",
  hostId,
  expiresAtUnixMs: 1_900_000_000_000n,
  device: {
    $typeName: "armadra.v1.DeviceIdentity",
    deviceId,
    principalId: "5".repeat(32),
    displayName: "My browser",
    role: "owner",
    createdAtUnixMs: 1n,
    revokedAtUnixMs: 0n,
    revision: 1n,
  },
  scopes: [
    {
      $typeName: "armadra.v1.AuthorizationGrant",
      permission: "identity:read",
      workspaceId: "",
      executionHostId: "",
    },
    {
      $typeName: "armadra.v1.AuthorizationGrant",
      permission: "identity:manage",
      workspaceId: "",
      executionHostId: "",
    },
  ],
};
function controller() {
  return {
    resume: vi.fn().mockResolvedValue(null),
    pair: vi.fn().mockResolvedValue(session),
    listDevices: vi.fn().mockResolvedValue({
      devices: [
        session.device!,
        { ...session.device!, deviceId: otherId, displayName: "Phone" },
      ],
      nextId: "",
      hasMore: false,
    }),
    revokeDevice: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}
let api: ReturnType<typeof controller>;
let setItem: ReturnType<typeof vi.fn>;
beforeEach(() => {
  api = controller();
  mocks.create.mockReset().mockReturnValue(api);
  vi.stubGlobal("location", { origin, href: origin + "/settings" });
  setItem = vi.fn();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem,
    removeItem: vi.fn(),
  });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem,
    removeItem: vi.fn(),
  });
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HostIdentityPanel inside the desktop shell", () => {
  const nativeHello: HelloResponse = {
    ...hello,
    capabilities: ["identity.native-session.v1"],
  };
  const shellOrigin = "http://127.0.0.1:54321";
  function shell() {
    vi.stubGlobal("location", {
      origin: shellOrigin,
      protocol: "http:",
      host: "127.0.0.1:54321",
    });
    // Only the ticket channel matters here; the rest of the bridge is not
    // reached by this panel, so it is not stood up.
    (window as unknown as { armadra?: unknown }).armadra = {
      identity: { ticket: vi.fn() },
    };
  }
  afterEach(() => {
    delete (window as Window & { armadra?: unknown }).armadra;
    resetNativeSession();
  });
  it("opens a native session against the loopback Host without asking for a ticket", async () => {
    shell();
    api.resume.mockResolvedValue({
      ...session,
      device: { ...session.device!, displayName: "本机桌面" },
    });
    render(
      <HostIdentityPanel
        address="http://127.0.0.1:43121"
        hello={nativeHello}
      />,
    );
    await screen.findByText(/本机桌面 · 服务所有者/);
    expect(mocks.create).toHaveBeenCalledOnce();
    const options = mocks.create.mock.calls[0]![0] as {
      baseUrl: string;
      pageOrigin: string;
      transport: { kind: string };
    };
    expect(options.baseUrl).toBe("http://127.0.0.1:43121");
    expect(options.pageOrigin).toBe(shellOrigin);
    expect(options.transport.kind).toBe("native");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });
  it("still refuses a Host without the native capability, and a remote address", () => {
    shell();
    render(
      <HostIdentityPanel address="http://127.0.0.1:43121" hello={hello} />,
    );
    expect(screen.getByText("此服务尚未提供浏览器设备登录。")).toBeTruthy();
    cleanup();
    render(<HostIdentityPanel address={origin} hello={nativeHello} />);
    expect(screen.getByText(/当前页面来源不同/)).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("shows the shell's own reason when it cannot issue a ticket", async () => {
    shell();
    api.resume.mockRejectedValue(new HostNativeSessionError("hostUnavailable"));
    render(
      <HostIdentityPanel
        address="http://127.0.0.1:43121"
        hello={nativeHello}
      />,
    );
    await screen.findByText(/后台服务尚未就绪/);
    expect(document.body.textContent).not.toContain("hostNative.blocked");
  });
});

describe("HostIdentityPanel", () => {
  it("explains missing TLS and never attempts HTTP authentication", () => {
    render(
      <HostIdentityPanel address="http://127.0.0.1:43121" hello={hello} />,
    );
    expect(screen.getByText(/尚未配置 HTTPS 登录/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not pretend an other-origin page can log into an HTTPS Host", () => {
    vi.stubGlobal("location", { origin: "https://elsewhere.test" });
    render(<HostIdentityPanel address={origin} hello={hello} />);
    expect(screen.getByText(/当前页面来源不同/)).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires a checked Host and its advertised authentication capability", () => {
    const view = render(<HostIdentityPanel address={origin} />);
    expect(screen.getByText("请先检查连接，确认服务身份。")).toBeTruthy();
    view.rerender(
      <HostIdentityPanel
        address={origin}
        hello={{ ...hello, capabilities: [] }}
      />,
    );
    expect(screen.getByText("此服务尚未提供浏览器设备登录。")).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("clears the pasted ticket immediately, uses no browser storage and shows verified session metadata", async () => {
    let complete!: (value: HostIdentitySession) => void;
    api.pair.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    render(<HostIdentityPanel address={origin} hello={hello} />);
    const input = (await screen.findByRole("textbox", {
      name: "一次性配对票据",
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "one-time-sensitive-ticket" } });
    fireEvent.submit(input.closest("form")!);
    expect(input.value).toBe("");
    expect(api.pair).toHaveBeenCalledExactlyOnceWith(
      "one-time-sensitive-ticket",
    );
    expect(
      (screen.getByRole("button", { name: "配对此设备" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => complete(session));
    await screen.findByText(/My browser · 服务所有者/);
    expect(screen.getByText("当前访问有效至")).toBeTruthy();
    expect(screen.getByText("本次登录权限")).toBeTruthy();
    expect(screen.getByText("Phone")).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      "one-time-sensitive-ticket",
    );
  });
  it("restores once and displays narrow grants without requesting the device list", async () => {
    api.resume.mockResolvedValue({
      ...session,
      scopes: [
        {
          $typeName: "armadra.v1.AuthorizationGrant",
          permission: "canvas:read",
          workspaceId: "workspace-a",
          executionHostId: "worker-a",
        },
      ],
    });
    render(<HostIdentityPanel address={origin} hello={hello} />);
    await screen.findByText(/My browser · 服务所有者/);
    expect(api.resume).toHaveBeenCalledOnce();
    expect(api.listDevices).not.toHaveBeenCalled();
    expect(screen.queryByText("已配对设备")).toBeNull();
    expect(screen.getByText(/工作区 workspace-a/)).toBeTruthy();
    expect(screen.getByText(/执行主机 worker-a/)).toBeTruthy();
  });
  it("requires explicit named confirmation and sends the displayed revision", async () => {
    api.resume.mockResolvedValue(session);
    render(<HostIdentityPanel address={origin} hello={hello} />);
    await screen.findByRole("button", { name: "撤销设备 Phone" });
    fireEvent.click(screen.getByRole("button", { name: "撤销设备 Phone" }));
    const confirm = screen.getByRole("alertdialog");
    expect(within(confirm).getByText("Phone")).toBeTruthy();
    expect(within(confirm).getByText(otherId)).toBeTruthy();
    expect(api.revokeDevice).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(api.revokeDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "撤销设备 Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
    await waitFor(() =>
      expect(api.revokeDevice).toHaveBeenCalledExactlyOnceWith(otherId, 1n),
    );
    await screen.findByText("设备访问权限已撤销。");
    expect(api.listDevices).toHaveBeenCalledTimes(2);
  });
  it("does not announce logout until the server confirms it", async () => {
    api.resume.mockResolvedValue(session);
    let finish!: () => void;
    api.logout.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(<HostIdentityPanel address={origin} hello={hello} />);
    await screen.findByRole("button", { name: "退出此设备登录" });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "退出此设备登录",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "退出此设备登录" }));
    expect(screen.queryByText("此设备已退出登录。")).toBeNull();
    await act(async () => finish());
    await screen.findByText("此设备已退出登录。");
    expect(screen.queryByText(/My browser · 服务所有者/)).toBeNull();
    expect(api.logout).toHaveBeenCalledOnce();
  });

  it("focuses Cancel by default and Escape restores the initiating device button", async () => {
    api.resume.mockResolvedValue(session);
    render(<HostIdentityPanel address={origin} hello={hello} />);
    const trigger = await screen.findByRole("button", {
      name: "撤销设备 Phone",
    });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "取消" }),
      ),
    );
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(api.revokeDevice).not.toHaveBeenCalled();
  });
  it("does not automatically repeat an uncertain mutation or display raw remote errors", async () => {
    api.resume.mockResolvedValue(session);
    api.revokeDevice.mockRejectedValue(
      new HostIdentityError("NETWORK_ERROR", true),
    );
    render(<HostIdentityPanel address={origin} hello={hello} />);
    await screen.findByRole("button", { name: "撤销设备 Phone" });
    fireEvent.click(screen.getByRole("button", { name: "撤销设备 Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
    await screen.findByText(/未能确认操作结果/);
    expect(api.revokeDevice).toHaveBeenCalledOnce();
    expect(api.listDevices).toHaveBeenCalledOnce();
  });
  it("ignores a late response after changing Host or unmounting", async () => {
    let finish!: (value: HostIdentitySession) => void;
    api.resume.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<HostIdentityPanel address={origin} hello={hello} />);
    view.rerender(
      <HostIdentityPanel address="http://127.0.0.1:43121" hello={hello} />,
    );
    expect(api.dispose).toHaveBeenCalledOnce();
    await act(async () => finish(session));
    expect(screen.queryByText(/My browser/)).toBeNull();
    expect(api.listDevices).not.toHaveBeenCalled();
    view.unmount();
  });
  it("creates a fresh client during StrictMode effect replay", async () => {
    const first = controller(),
      second = controller();
    second.resume.mockResolvedValue(session);
    mocks.create.mockReset().mockReturnValueOnce(first).mockReturnValue(second);
    render(
      <StrictMode>
        <HostIdentityPanel address={origin} hello={hello} />
      </StrictMode>,
    );
    await screen.findByText(/My browser · 服务所有者/);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.resume).toHaveBeenCalledOnce();
  });
  it("changes language without recreating the client or repeating recovery", async () => {
    render(<HostIdentityPanel address={origin} hello={hello} />);
    await screen.findByText("此页面尚未登录。");
    act(() => usePreferencesStore.setState({ locale: "en" }));
    expect(
      screen.getByRole("button", { name: "Pair this device" }),
    ).toBeTruthy();
    expect(api.resume).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(Object.keys(hostIdentity.en).sort()).toEqual(
      Object.keys(hostIdentity["zh-CN"]).sort(),
    );
  });
});
