import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

const probe = vi.fn();
vi.mock("../../../host/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../host/connection")>()),
  probeHost: (...args: unknown[]) => probe(...args),
}));
vi.mock("./HostIdentityPanel", () => ({
  HostIdentityPanel: () => null,
}));

import { HostPage } from "./HostPage";
import { usePreferencesStore } from "../../../app/preferences-store";
import {
  IdentityRequestError,
  IdentityTransportError,
  type IdentityHello,
} from "../../../api/identity";
import { SETTINGS_SECTIONS } from "../nav";

const hello: IdentityHello = {
  hostId: "host-confirmed",
  hostInstanceId: "process-confirmed",
  maxFrameBytes: 1_048_576,
  capabilities: ["identity.native-session.v1"],
  protocol: { major: 1, minor: 1 },
};

beforeEach(() => {
  probe.mockReset();
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HostPage", () => {
  it("is a connection settings entry and remains idle until explicitly checked", () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === "host");
    expect(section?.groupKey).toBe("settings.group.connection");
    render(<HostPage />);
    expect(screen.getByRole("status").textContent).toBe("尚未检查连接");
    expect(
      screen.getByText(/不会切换当前正在运行的工作空间或终端/),
    ).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
  });

  it("opened from a pairing link it checks once by itself, so the ticket can be used", async () => {
    // 服务器壳的配对链接 `…/#pair=<票>`：票要等身份面「可用」才会被取走，而
    // 可用要先检查一次连接。不自己检查，链接打开后什么都不会发生。
    probe.mockResolvedValue(hello);
    const original = window.location.hash;
    window.history.replaceState(null, "", "#pair=abc.def");
    try {
      render(<HostPage />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      window.history.replaceState(
        null,
        "",
        original || window.location.pathname,
      );
    }
  });

  it("keeps a confirmed identity in expandable details", async () => {
    probe.mockResolvedValue(hello);
    render(<HostPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    expect(screen.getByRole("status").textContent).toBe("已确认服务响应");
    const details = screen.getByText("连接详情").closest("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(screen.getByText("host-confirmed")).toBeTruthy();
    expect(screen.getByText("process-confirmed")).toBeTruthy();
    // 能力名原样列出：这一页说的是 core 报了什么，不是页面猜它支持什么。
    expect(screen.getByText("identity.native-session.v1")).toBeTruthy();
  });

  /**
   * 远端返回的文字不进界面：一句可以本地化的话说明该去看哪一边，
   * 原样打印一段服务端消息既翻译不了，也可能带出不该出现在屏幕上的东西。
   */
  it("localizes a refusal without printing remote text", async () => {
    probe.mockRejectedValue(
      new IdentityRequestError(403, "PERMISSION_DENIED", "raw remote detail"),
    );
    render(<HostPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("拒绝访问");
    expect(status.textContent).not.toContain("raw remote detail");
  });

  it("allows cancellation while checking and ignores the old result", async () => {
    let resolve!: (value: IdentityHello) => void;
    probe.mockReturnValue(
      new Promise<IdentityHello>((done) => {
        resolve = done;
      }),
    );
    render(<HostPage />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    expect(screen.getByRole("status").textContent).toBe("正在检查连接…");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });
    expect(screen.getByRole("status").textContent).toBe("已取消检查");
    await act(async () => {
      resolve(hello);
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe("已取消检查");
  });

  it("updates status translations without repeating a request", async () => {
    probe.mockRejectedValue(new IdentityTransportError());
    render(<HostPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    expect(screen.getByRole("status").textContent).toContain("无法连接");
    act(() => usePreferencesStore.setState({ locale: "en" }));
    expect(screen.getByRole("status").textContent).toContain("Cannot connect");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
