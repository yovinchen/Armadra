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

import { hostIdentity } from "../../../i18n/host-identity";
import { hostNative } from "../../../i18n/host-native";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  pair: vi.fn(),
  listDevices: vi.fn(),
  revoke: vi.fn(),
  logout: vi.fn(),
  takeTicket: vi.fn(),
  nativeShell: false,
}));

vi.mock("../../../api/identity", async (original) => {
  const actual = await original<typeof import("../../../api/identity")>();
  return {
    ...actual,
    resumeIdentity: (...args: never[]) => mocks.resume(...args),
    pairIdentity: (...args: never[]) => mocks.pair(...args),
    listIdentityDevices: (...args: never[]) => mocks.listDevices(...args),
    revokeIdentityDevice: (...args: never[]) => mocks.revoke(...args),
    logoutIdentity: (...args: never[]) => mocks.logout(...args),
    takePairingTicket: () => mocks.takeTicket() as string,
  };
});

vi.mock("../../../host/native-session", async (original) => {
  const actual =
    await original<typeof import("../../../host/native-session")>();
  return { ...actual, isNativeShell: () => mocks.nativeShell };
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

import {
  IdentityRequestError,
  type IdentityHello,
  type IdentitySession,
} from "../../../api/identity";
import { HostIdentityPanel } from "./HostIdentityPanel";
import { usePreferencesStore } from "../../../app/preferences-store";
import { HostNativeSessionError } from "../../../host/native-session";

const hostId = "1".repeat(32),
  hostInstanceId = "2".repeat(32),
  deviceId = "3".repeat(32),
  otherId = "4".repeat(32);

const hello: IdentityHello = {
  hostId,
  hostInstanceId,
  protocol: { major: 1, minor: 1 },
  capabilities: ["identity.browser-session.v1"],
  maxFrameBytes: 1_048_576,
};

const session: IdentitySession = {
  hostId,
  expiresAtUnixMs: 1_900_000_000_000,
  device: {
    deviceId,
    principalId: "5".repeat(32),
    displayName: "My browser",
    role: "owner",
    createdAtUnixMs: 1,
    revision: 1,
  },
  scopes: [
    { permission: "identity:read", workspaceId: "", executionHostId: "" },
    { permission: "identity:manage", workspaceId: "", executionHostId: "" },
  ],
};

const devicePage = {
  devices: [
    {
      deviceId,
      principalId: "5".repeat(32),
      name: "My browser",
      role: "owner",
      epoch: 1,
      createdAtMs: 1,
      revokedAtMs: 0,
    },
    {
      deviceId: otherId,
      principalId: "5".repeat(32),
      name: "Phone",
      role: "owner",
      epoch: 4,
      createdAtMs: 2,
      revokedAtMs: 0,
    },
  ],
  nextId: "",
  hasMore: false,
};

let setItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.nativeShell = false;
  mocks.resume.mockReset().mockResolvedValue(null);
  mocks.pair.mockReset().mockResolvedValue(session);
  mocks.listDevices.mockReset().mockResolvedValue(devicePage);
  mocks.revoke.mockReset().mockResolvedValue(undefined);
  mocks.logout.mockReset().mockResolvedValue(undefined);
  mocks.takeTicket.mockReset().mockReturnValue("");
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

describe("HostIdentityPanel", () => {
  it("says a connection check is needed before it asks anything", () => {
    render(<HostIdentityPanel />);
    expect(
      screen.getByText(hostIdentity["zh-CN"]["hostIdentity.checkRequired"]!),
    ).toBeTruthy();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("refuses a core that does not advertise the session capability", () => {
    render(<HostIdentityPanel hello={{ ...hello, capabilities: [] }} />);
    expect(
      screen.getByText(hostIdentity["zh-CN"]["hostIdentity.unsupported"]!),
    ).toBeTruthy();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  /**
   * 壳里「已经登录」是一个进程内的事实，不该让人自己贴一串票。
   */
  it("signs itself in inside the desktop shell without asking for a ticket", async () => {
    mocks.nativeShell = true;
    mocks.resume.mockResolvedValue(session);
    render(
      <HostIdentityPanel
        hello={{ ...hello, capabilities: ["identity.native-session.v1"] }}
      />,
    );
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/My browser/))[0]).toBeTruthy();
    expect(screen.queryByLabelText(/票据|ticket/i)).toBeNull();
  });

  it("shows the shell's own reason when it cannot issue a ticket", async () => {
    mocks.nativeShell = true;
    mocks.resume.mockRejectedValue(new HostNativeSessionError("cliFailed"));
    render(
      <HostIdentityPanel
        hello={{ ...hello, capabilities: ["identity.native-session.v1"] }}
      />,
    );
    expect(
      await screen.findByText(
        hostNative["zh-CN"]["hostNative.blocked.cliFailed"]!,
      ),
    ).toBeTruthy();
  });

  /**
   * 服务器壳把票放在 `…/#pair=<票>` 里。读到就直接配对：让人再复制一遍只是
   * 多一次出错的机会，而那串材料本来就不该在页面上停留。
   */
  it("pairs straight from the fragment the server shell printed", async () => {
    mocks.takeTicket.mockReturnValue("ticket-from-fragment");
    render(<HostIdentityPanel hello={hello} />);
    await waitFor(() =>
      expect(mocks.pair).toHaveBeenCalledWith("ticket-from-fragment"),
    );
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("clears the pasted ticket immediately and uses no browser storage", async () => {
    render(<HostIdentityPanel hello={hello} />);
    const field = await screen.findByLabelText(
      hostIdentity["zh-CN"]["hostIdentity.ticket"]!,
    );
    fireEvent.change(field, { target: { value: "  paste  " } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    await waitFor(() => expect(mocks.pair).toHaveBeenCalledWith("  paste  "));
    expect((field as HTMLTextAreaElement).value).toBe("");
    expect(setItem).not.toHaveBeenCalled();
    expect((await screen.findAllByText(/My browser/))[0]).toBeTruthy();
  });

  it("does not request the device list without the read grant", async () => {
    mocks.resume.mockResolvedValue({
      ...session,
      scopes: [
        { permission: "canvas:read", workspaceId: "w1", executionHostId: "" },
      ],
    });
    render(<HostIdentityPanel hello={hello} />);
    expect((await screen.findAllByText(/My browser/))[0]).toBeTruthy();
    expect(mocks.listDevices).not.toHaveBeenCalled();
  });

  it("requires named confirmation and sends the displayed revision", async () => {
    mocks.resume.mockResolvedValue(session);
    render(<HostIdentityPanel hello={hello} />);
    const button = await screen.findByLabelText(
      hostIdentity["zh-CN"]["hostIdentity.revokeNamed"]!.replace(
        "{name}",
        "Phone",
      ),
    );
    fireEvent.click(button);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByText(hostIdentity["zh-CN"]["hostIdentity.confirm"]!),
    );
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(otherId, 4));
  });

  it("does not announce logout until the core confirms it", async () => {
    mocks.resume.mockResolvedValue(session);
    let release!: () => void;
    mocks.logout.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(<HostIdentityPanel hello={hello} />);
    fireEvent.click(
      await screen.findByText(hostIdentity["zh-CN"]["hostIdentity.logout"]!),
    );
    expect(
      screen.queryByText(hostIdentity["zh-CN"]["hostIdentity.loggedOut"]!),
    ).toBeNull();
    mocks.resume.mockResolvedValue(null);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(
      await screen.findByText(hostIdentity["zh-CN"]["hostIdentity.loggedOut"]!),
    ).toBeTruthy();
  });

  it("never prints a remote message raw", async () => {
    mocks.resume.mockRejectedValue(
      new IdentityRequestError(403, "PERMISSION_DENIED", "raw secret detail"),
    );
    render(<HostIdentityPanel hello={hello} />);
    expect(
      await screen.findByText(
        hostIdentity["zh-CN"]["hostIdentity.error.permission"]!,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/raw secret detail/)).toBeNull();
  });

  /**
   * StrictMode 会把 effect 重放一遍。第一次那份答案属于一个已经作废的代次，
   * 落到界面上就是一份来历不明的会话；重放之后界面显示的必须是第二次的答案。
   */
  it("keeps the replayed generation's answer during StrictMode", async () => {
    mocks.resume.mockResolvedValue(session);
    render(
      <StrictMode>
        <HostIdentityPanel hello={hello} />
      </StrictMode>,
    );
    expect((await screen.findAllByText(/My browser/))[0]).toBeTruthy();
  });

  it("changes language without asking again", async () => {
    mocks.resume.mockResolvedValue(session);
    render(<HostIdentityPanel hello={hello} />);
    expect((await screen.findAllByText(/My browser/))[0]).toBeTruthy();
    act(() => usePreferencesStore.setState({ locale: "en" }));
    expect(
      await screen.findByText(hostIdentity.en["hostIdentity.devices"]!),
    ).toBeTruthy();
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });
});
