import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const health = vi.fn();
vi.mock("@/api/system", () => ({ systemApi: { health: () => health() } }));
let desktop = false;
vi.mock("@/platform", () => ({ isDesktop: () => desktop }));

import {
  resetBrowserAvailability,
  useCanCreateBrowser,
  useHeadlessBrowser,
} from "./availability";

afterEach(() => {
  act(() => resetBrowserAvailability());
  health.mockReset();
  desktop = false;
});

describe("browser availability", () => {
  it("reads the core's headlessBrowser capability once", async () => {
    health.mockResolvedValue({
      status: "ok",
      version: "1",
      capabilities: { headlessBrowser: true },
    });
    const first = renderHook(() => useCanCreateBrowser());
    await waitFor(() => expect(first.result.current).toBe(true));
    renderHook(() => useHeadlessBrowser());
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("treats an old core without capabilities as no browser", async () => {
    health.mockResolvedValue({ status: "ok", version: "1" });
    const { result } = renderHook(() => useCanCreateBrowser());
    await waitFor(() => expect(health).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("does not ask when disabled, and always allows on the desktop shell", () => {
    renderHook(() => useHeadlessBrowser(false));
    expect(health).not.toHaveBeenCalled();
    desktop = true;
    const { result } = renderHook(() => useCanCreateBrowser());
    expect(result.current).toBe(true);
    expect(health).not.toHaveBeenCalled();
  });
});
