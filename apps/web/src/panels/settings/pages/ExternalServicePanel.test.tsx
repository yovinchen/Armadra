import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const viaHost = vi.hoisted(() => ({ value: true }));
const read = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock("../../../host/external-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../host/external-service")>()),
  hostServedPage: () => viaHost.value,
  readExternalService: read,
  saveExternalService: save,
}));

import { ExternalServicePanel } from "./ExternalServicePanel";
import { ExternalServiceError } from "../../../host/external-service";
import { usePreferencesStore } from "../../../app/preferences-store";

const off = {
  supported: true,
  enabled: false,
  address: "127.0.0.1",
  port: 8443,
  allowLan: false,
  publicOrigin: "https://192.168.1.20:8443",
  boundAddress: "",
  accessUrl: "",
  interfaces: ["192.168.1.20"],
};
const on = {
  ...off,
  enabled: true,
  address: "192.168.1.20",
  allowLan: true,
  boundAddress: "192.168.1.20:8443",
  accessUrl: "https://192.168.1.20:8443",
};

beforeEach(() => {
  viaHost.value = true;
  read.mockReset();
  save.mockReset();
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

describe("the external service switch", () => {
  it("says so plainly when this page is not served by the Host", async () => {
    viaHost.value = false;
    render(<ExternalServicePanel />);
    expect(
      screen.getByText(/不是由后台服务提供|not served by the background/),
    ).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  it("shows the saved switch and offers this machine's interfaces", async () => {
    read.mockResolvedValue(off);
    render(<ExternalServicePanel />);
    const toggle = await screen.findByRole("switch", { name: "对外提供服务" });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    // Off means no address to scan and no promise that anything is reachable.
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/未开启/)).toBeTruthy();
  });

  it("shows the access address and its code once it is serving", async () => {
    read.mockResolvedValue(on);
    render(<ExternalServicePanel />);
    expect(await screen.findByText("https://192.168.1.20:8443")).toBeTruthy();
    const code = await screen.findByRole("img", {
      name: "访问地址的二维码",
    });
    expect(code.querySelector("path")?.getAttribute("d")).toBeTruthy();
  });

  it("keeps the confirmed state when the service refuses a change", async () => {
    read.mockResolvedValue(off);
    save.mockRejectedValue(
      new ExternalServiceError(400, "INVALID_ARGUMENT", "refused"),
    );
    render(<ExternalServicePanel />);
    const toggle = await screen.findByRole("switch", { name: "对外提供服务" });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "应用" }));
    });
    await waitFor(() =>
      expect(screen.getByText(/服务拒绝了这组设置/)).toBeTruthy(),
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
  });
});
