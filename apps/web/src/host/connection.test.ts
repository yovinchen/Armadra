import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import {
  IdentityRequestError,
  IdentityTransportError,
  type IdentityHello,
} from "../api/identity";
import { hostErrorKey, type HostProbe } from "./connection";
import { useHostConnection } from "./use-host-connection";

function hello(hostId = "host-1"): IdentityHello {
  return {
    hostId,
    hostInstanceId: "process-1",
    maxFrameBytes: 1_048_576,
    capabilities: ["identity.native-session.v1"],
    protocol: { major: 1, minor: 1 },
  };
}

function deferred() {
  let resolve!: (value: IdentityHello) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<IdentityHello>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the connection check", () => {
  it("asks nothing until it is asked to", () => {
    const probe = vi.fn<HostProbe>();
    const { result } = renderHook(() => useHostConnection(probe));
    expect(result.current.state).toEqual({ status: "idle" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports the hello it got back", async () => {
    const probe = vi.fn<HostProbe>().mockResolvedValue(hello());
    const { result } = renderHook(() => useHostConnection(probe));
    await act(async () => void (await result.current.check()));
    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "connected",
        hello: hello(),
      }),
    );
  });

  it("folds a second press into the first request", async () => {
    const first = deferred();
    const probe = vi.fn<HostProbe>().mockReturnValue(first.promise);
    const { result } = renderHook(() => useHostConnection(probe));
    act(() => void result.current.check());
    act(() => void result.current.check());
    expect(probe).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(hello());
      await first.promise;
    });
  });

  /**
   * 取消之后那次飞行中的回答不能再落到界面上：用户已经说「别问了」，
   * 一个迟到的「已连接」会把那句话推翻。
   */
  it("drops the answer of a check that was cancelled", async () => {
    const pending = deferred();
    const probe = vi.fn<HostProbe>().mockReturnValue(pending.promise);
    const { result } = renderHook(() => useHostConnection(probe));
    act(() => void result.current.check());
    act(() => result.current.cancel());
    expect(result.current.state).toEqual({ status: "idle", cancelled: true });
    await act(async () => {
      pending.resolve(hello());
      await pending.promise;
    });
    expect(result.current.state).toEqual({ status: "idle", cancelled: true });
  });

  it("turns a refusal into the sentence that names the side to look at", async () => {
    const probe = vi
      .fn<HostProbe>()
      .mockRejectedValue(
        new IdentityRequestError(403, "PERMISSION_DENIED", ""),
      );
    const { result } = renderHook(() => useHostConnection(probe));
    await act(async () => void (await result.current.check()));
    expect(result.current.state).toEqual({
      status: "error",
      messageKey: "host.error.permission",
    });
  });
});

describe("hostErrorKey", () => {
  it("separates «could not reach it» from «it said no»", () => {
    expect(hostErrorKey(new IdentityTransportError())).toBe(
      "host.error.network",
    );
    expect(
      hostErrorKey(new IdentityRequestError(401, "UNAUTHENTICATED", "")),
    ).toBe("host.error.auth");
    expect(
      hostErrorKey(new IdentityRequestError(501, "NOT_IMPLEMENTED", "")),
    ).toBe("host.error.unsupported");
    expect(hostErrorKey(new IdentityRequestError(500, "INTERNAL", ""))).toBe(
      "host.error.remote",
    );
  });

  /** 连上了但回来的不是一份认得出的 hello：那是一个不同的故障。 */
  it("calls an unrecognizable answer what it is", () => {
    expect(hostErrorKey(new Error("bad shape"))).toBe(
      "host.error.invalidResponse",
    );
  });
});
