import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { HostClientError, type HelloResponse } from "@armadra/host-client";
import {
  DEFAULT_HOST_ADDRESS,
  HOST_ADDRESS_STORAGE_KEY,
  hostErrorKey,
  loadHostAddress,
  rememberHostAddress,
  type HostProbe,
} from "./connection";
import { useHostConnection } from "./use-host-connection";

function response(hostId = "host-1"): HelloResponse {
  return {
    $typeName: "armadra.v1.HelloResponse",
    hostId,
    hostInstanceId: "process-1",
    maxFrameBytes: 1_048_576,
    capabilities: ["protocol.hello.v1"],
    protocol: { $typeName: "armadra.v1.ProtocolVersion", major: 1, minor: 1 },
  };
}
function deferred() {
  let resolve!: (value: HelloResponse) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<HelloResponse>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local address preference", () => {
  it("starts at the default without storing or requesting anything", () => {
    const probe = vi.fn<HostProbe>();
    const { result } = renderHook(() => useHostConnection(probe));
    expect(result.current.address).toBe(DEFAULT_HOST_ADDRESS);
    expect(result.current.state).toEqual({ status: "idle" });
    expect(probe).not.toHaveBeenCalled();
    expect(localStorage.getItem(HOST_ADDRESS_STORAGE_KEY)).toBeNull();
  });

  it("remembers a valid proxy prefix but never credentials or query tokens", () => {
    rememberHostAddress("https://host.test/team/armadra/");
    expect(loadHostAddress()).toBe("https://host.test/team/armadra/");
    expect(() => rememberHostAddress("https://user:secret@host.test")).toThrow(
      HostClientError,
    );
    expect(() => rememberHostAddress("https://host.test?token=secret")).toThrow(
      HostClientError,
    );
    expect(localStorage.getItem(HOST_ADDRESS_STORAGE_KEY)).toBe(
      "https://host.test/team/armadra/",
    );
  });

  it("discards an unsafe stored value", () => {
    localStorage.setItem(
      HOST_ADDRESS_STORAGE_KEY,
      "https://host.test?token=secret",
    );
    expect(loadHostAddress()).toBe(DEFAULT_HOST_ADDRESS);
    expect(localStorage.getItem(HOST_ADDRESS_STORAGE_KEY)).toBeNull();
  });

  it("works when browser storage is unavailable", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    const probe = vi.fn<HostProbe>().mockResolvedValue(response());
    const { result } = renderHook(() => useHostConnection(probe));
    await act(() => result.current.check());
    expect(result.current.state.status).toBe("connected");
  });
});

describe("connection state lifecycle", () => {
  it("only checks explicitly and saves validated addresses on check", async () => {
    const probe = vi.fn<HostProbe>().mockResolvedValue(response());
    const { result } = renderHook(() => useHostConnection(probe));
    act(() => result.current.editAddress("https://host.test/proxy/"));
    expect(probe).not.toHaveBeenCalled();
    expect(localStorage.getItem(HOST_ADDRESS_STORAGE_KEY)).toBeNull();
    await act(() => result.current.check());
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toBe("https://host.test/proxy/");
    expect(localStorage.getItem(HOST_ADDRESS_STORAGE_KEY)).toBe(
      "https://host.test/proxy/",
    );
    expect(result.current.state).toEqual({
      status: "connected",
      hello: response(),
    });
  });

  it("does not dispatch a second simultaneous check", async () => {
    const pending = deferred();
    const probe = vi.fn<HostProbe>().mockReturnValue(pending.promise);
    const { result } = renderHook(() => useHostConnection(probe));
    act(() => {
      void result.current.check();
      void result.current.check();
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(result.current.state).toEqual({ status: "checking" });
    await act(async () => pending.resolve(response()));
  });

  it("clears a previous identity on edit, checking, or failure", async () => {
    const probe = vi
      .fn<HostProbe>()
      .mockResolvedValueOnce(response())
      .mockRejectedValue(new HostClientError("NETWORK_ERROR", true));
    const { result } = renderHook(() => useHostConnection(probe));
    await act(() => result.current.check());
    act(() => result.current.editAddress("https://host.test/"));
    expect(result.current.state).toEqual({ status: "idle" });
    await act(() => result.current.check());
    expect(result.current.state).toEqual({
      status: "error",
      messageKey: "host.error.network",
    });
    expect(JSON.stringify(result.current.state)).not.toContain("host-1");
  });

  it("rejects unsafe configuration without calling the probe", async () => {
    const probe = vi.fn<HostProbe>();
    const { result } = renderHook(() => useHostConnection(probe));
    act(() => result.current.editAddress("https://host.test?token=secret"));
    await act(() => result.current.check());
    expect(result.current.state).toEqual({
      status: "error",
      messageKey: "host.error.address",
    });
    expect(probe).not.toHaveBeenCalled();
    expect(localStorage.getItem(HOST_ADDRESS_STORAGE_KEY)).toBeNull();
  });

  it("cancels immediately and ignores a late successful reply", async () => {
    const pending = deferred();
    const probe = vi.fn<HostProbe>().mockReturnValue(pending.promise);
    const { result } = renderHook(() => useHostConnection(probe));
    act(() => {
      void result.current.check();
    });
    act(() => result.current.cancel());
    expect(probe.mock.calls[0]?.[1].aborted).toBe(true);
    expect(result.current.state).toEqual({ status: "idle", cancelled: true });
    await act(async () => pending.resolve(response()));
    expect(result.current.state).toEqual({ status: "idle", cancelled: true });
  });

  it("keeps the new result when an older address completes out of order", async () => {
    const first = deferred();
    const second = deferred();
    const probe = vi
      .fn<HostProbe>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useHostConnection(probe));
    act(() => {
      void result.current.check();
    });
    act(() => result.current.editAddress("https://host.test/new"));
    expect(probe.mock.calls[0]?.[1].aborted).toBe(true);
    act(() => {
      void result.current.check();
    });
    await act(async () => second.resolve(response("new-host")));
    await act(async () => first.resolve(response("old-host")));
    expect(result.current.state).toEqual({
      status: "connected",
      hello: response("new-host"),
    });
  });

  it("ignores late failures after edit and aborts on unmount", async () => {
    const pending = deferred();
    const probe = vi.fn<HostProbe>().mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useHostConnection(probe));
    act(() => {
      void result.current.check();
    });
    act(() => result.current.editAddress("https://host.test/"));
    await act(async () => pending.reject(new Error("secret")));
    expect(result.current.state).toEqual({ status: "idle" });
    const next = deferred();
    probe.mockReturnValue(next.promise);
    act(() => {
      void result.current.check();
    });
    unmount();
    expect(probe.mock.calls[1]?.[1].aborted).toBe(true);
    next.resolve(response());
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  });
});

describe("sanitized localized errors", () => {
  it.each([
    [new HostClientError("TIMEOUT", true), "host.error.timeout"],
    [new HostClientError("INCOMPATIBLE_PROTOCOL", false), "host.error.version"],
    [
      new HostClientError("REMOTE_ERROR", false, 401, "UNAUTHENTICATED"),
      "host.error.auth",
    ],
    [
      new HostClientError("REMOTE_ERROR", false, 403, "PERMISSION_DENIED"),
      "host.error.permission",
    ],
    [new Error("server-secret"), "host.error.network"],
  ])("maps errors to keys without retaining raw messages", (error, key) => {
    expect(hostErrorKey(error)).toBe(key);
  });
});
