import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { HostClientError, type HelloResponse } from "@armadra/host-client";

const probe = vi.fn();
vi.mock("../../../host/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../host/connection")>()),
  probeHost: (...args: unknown[]) => probe(...args),
}));

import { HostPage } from "./HostPage";
import { usePreferencesStore } from "../../../app/preferences-store";
import {
  DEFAULT_HOST_ADDRESS,
  HOST_ADDRESS_STORAGE_KEY,
} from "../../../host/connection";
import { SETTINGS_SECTIONS } from "../nav";

const hello: HelloResponse = {
  $typeName: "armadra.v1.HelloResponse",
  hostId: "host-confirmed",
  hostInstanceId: "process-confirmed",
  maxFrameBytes: 1_048_576,
  capabilities: ["protocol.hello.v1"],
  protocol: { $typeName: "armadra.v1.ProtocolVersion", major: 1, minor: 1 },
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
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
    const address = screen.getByRole("textbox", {
      name: "服务地址",
    }) as HTMLInputElement;
    expect(address.value).toBe(DEFAULT_HOST_ADDRESS);
    expect(screen.getByRole("status").textContent).toBe("尚未检查连接");
    expect(
      screen.getByText(/不会切换当前正在运行的工作空间或终端/),
    ).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
  });

  it("submits a keyboard-accessible form and keeps confirmed identities in expandable details", async () => {
    probe.mockResolvedValue(hello);
    render(<HostPage />);
    const address = screen.getByRole("textbox", {
      name: "服务地址",
    }) as HTMLInputElement;
    expect(address.inputMode).toBe("url");
    expect(address.autocomplete).toBe("off");
    fireEvent.change(address, {
      target: { value: "https://host.test/proxy/" },
    });
    fireEvent.submit(address.closest("form")!);
    await screen.findByText("已确认服务响应");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toBe("https://host.test/proxy/");
    expect(localStorage.getItem(HOST_ADDRESS_STORAGE_KEY)).toBe(
      "https://host.test/proxy/",
    );
    const summary = screen.getByText("连接详情");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText("host-confirmed")).toBeTruthy();
    expect(screen.getByText("process-confirmed")).toBeTruthy();
    fireEvent.change(address, { target: { value: DEFAULT_HOST_ADDRESS } });
    expect(screen.queryByText("host-confirmed")).toBeNull();
    expect(screen.queryByText("连接详情")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("尚未检查连接");
  });

  it("reports unsupported persistent identity accurately for a legacy service", async () => {
    probe.mockResolvedValue({
      ...hello,
      hostId: "",
      protocol: { ...hello.protocol!, minor: 0 },
    });
    render(<HostPage />);
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await screen.findByText("已确认服务响应");
    expect(screen.getByText("此版本尚未提供持久服务标识")).toBeTruthy();
    expect(screen.getByText("process-confirmed")).toBeTruthy();
    expect(screen.queryByText("host-confirmed")).toBeNull();
  });

  it("announces validation errors without native browser validation or network requests", async () => {
    render(<HostPage />);
    const address = screen.getByRole("textbox", { name: "服务地址" });
    fireEvent.change(address, {
      target: { value: "https://host.test?token=secret" },
    });
    fireEvent.submit(address.closest("form")!);
    await screen.findByText(/请输入有效的服务地址/);
    expect(address.getAttribute("aria-invalid")).toBe("true");
    expect(address.getAttribute("aria-describedby")).toContain(
      screen.getByRole("status").id,
    );
    expect(screen.getByRole("status").textContent).not.toContain("secret");
    expect(probe).not.toHaveBeenCalled();
    expect(localStorage.getItem(HOST_ADDRESS_STORAGE_KEY)).toBeNull();
  });

  it("clears success when another check fails and localizes without remote text", async () => {
    probe
      .mockResolvedValueOnce(hello)
      .mockRejectedValueOnce(new Error("remote-token-secret"));
    render(<HostPage />);
    const check = screen.getByRole("button", { name: "检查连接" });
    fireEvent.click(check);
    await screen.findByText("已确认服务响应");
    fireEvent.click(check);
    await screen.findByText(/无法连接。/);
    expect(screen.queryByText("host-confirmed")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "桌面端当前仅允许默认本机地址",
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "remote-token-secret",
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("allows cancellation while checking and ignores the old result", async () => {
    let complete!: (value: HelloResponse) => void;
    probe.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    render(<HostPage />);
    const check = screen.getByRole("button", {
      name: "检查连接",
    }) as HTMLButtonElement;
    fireEvent.click(check);
    expect(check.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("正在检查连接…");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(check.disabled).toBe(false);
    expect(probe.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () => complete(hello));
    expect(screen.getByRole("status").textContent).toBe("已取消检查");
    expect(screen.queryByText("host-confirmed")).toBeNull();
  });

  it("updates status and control translations without repeating a request", async () => {
    probe.mockRejectedValue(new HostClientError("TIMEOUT", true));
    render(<HostPage />);
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await screen.findByText("连接检查超时，请稍后重试。");
    act(() => usePreferencesStore.setState({ locale: "en" }));
    expect(
      screen.getByRole("button", { name: "Check connection" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "The connection check timed out. Try again later.",
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
