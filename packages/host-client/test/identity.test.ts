import { afterEach, describe, expect, it, vi } from "vitest";
import {
  create,
  toBinary,
  fromBinary,
  AuthenticatedSessionSchema,
  RenewCsrfResponseSchema,
  ErrorResponseSchema,
  SessionClosedResponseSchema,
  ListDevicesResponseSchema,
  RevokeDeviceResponseSchema,
  PairDeviceRequestSchema,
  RevokeDeviceRequestSchema,
  MAX_FRAME_BYTES,
} from "@armadra/protocol";
import { HostIdentityClient, HostIdentityError } from "../src/identity.js";

const hostId = "1".repeat(32),
  hostInstanceId = "2".repeat(32),
  deviceId = "3".repeat(32),
  principalId = "4".repeat(32);
const token = "5".repeat(32) + "." + "A".repeat(43);
const csrf = "A".repeat(43),
  rotatedCSRF = "B".repeat(42) + "A";
const origin = "https://host.test";
const headers = { "Content-Type": "application/x-protobuf" };
function authenticated(csrfToken = csrf, overrides = {}) {
  return create(AuthenticatedSessionSchema, {
    hostId,
    device: {
      deviceId,
      principalId,
      displayName: "浏览器",
      role: "owner",
      revision: 1n,
      createdAtUnixMs: 1n,
    },
    scopes: [{ permission: "identity:manage" }],
    csrfToken,
    expiresAtUnixMs: BigInt(Date.now() + 900_000),
    ...overrides,
  });
}
function sessionResponse(csrfToken = csrf, overrides = {}) {
  return new Response(
    new Uint8Array(
      toBinary(AuthenticatedSessionSchema, authenticated(csrfToken, overrides)),
    ),
    { headers },
  );
}
function renewed(value = csrf) {
  return new Response(
    new Uint8Array(
      toBinary(
        RenewCsrfResponseSchema,
        create(RenewCsrfResponseSchema, { csrfToken: value }),
      ),
    ),
    { headers },
  );
}
function remote(code: string, status = 401) {
  return new Response(
    new Uint8Array(
      toBinary(
        ErrorResponseSchema,
        create(ErrorResponseSchema, {
          code,
          message: "credential-secret-do-not-display",
        }),
      ),
    ),
    { status, headers },
  );
}
function client(fetcher: typeof fetch, options = {}) {
  return new HostIdentityClient({
    baseUrl: origin,
    hostId,
    hostInstanceId,
    pageOrigin: origin,
    fetch: fetcher,
    ...options,
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HTTPS browser identity configuration", () => {
  it.each([
    "http://localhost:43121",
    "http://127.0.0.1:43121",
    "https://user:secret@host.test",
    "https://host.test?ticket=secret",
    "https://host.test#ticket",
    "https://host.test?",
    "https://host.test#",
    "https://host.test\\path",
    "https://host.test\n",
    " https://host.test",
    "/relative",
  ])("rejects unsafe URL %s without a request", (baseUrl) => {
    const fetcher = vi.fn();
    expect(() => client(fetcher, { baseUrl })).toThrow(HostIdentityError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires the actual page origin and valid observed Host identities", () => {
    expect(() =>
      client(vi.fn(), { pageOrigin: "https://other.test" }),
    ).toThrow();
    expect(() =>
      client(vi.fn(), { pageOrigin: "http://127.0.0.1:54321" }),
    ).toThrow();
    expect(() => client(vi.fn(), { hostId: "legacy" })).toThrow();
    expect(() => client(vi.fn(), { timeoutMs: 2_147_483_648 })).toThrow();
    vi.stubGlobal("location", { origin });
    expect(
      () =>
        new HostIdentityClient({
          baseUrl: origin,
          hostId,
          hostInstanceId,
          fetch: vi.fn(),
        }),
    ).not.toThrow();
  });
  it("uses credentialed Protobuf POST and preserves a proxy prefix without URL secrets", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => sessionResponse());
    const value = await client(fetcher, { baseUrl: origin + "/a%20b/" }).pair(
      token,
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(origin + "/a%20b/rpc/armadra.v1.IdentityService/Pair");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-protobuf",
        Accept: "application/x-protobuf",
      },
    });
    expect(
      fromBinary(PairDeviceRequestSchema, init!.body as Uint8Array),
    ).toMatchObject({
      expectedHostId: hostId,
      expectedInstanceId: hostInstanceId,
      ticket: token,
    });
    expect(value).not.toHaveProperty("csrfToken");
    expect(String(url)).not.toContain(token);
    expect(init!.headers).not.toHaveProperty("Authorization");
  });
});

describe("pairing and session recovery", () => {
  it("accepts the complete local CLI material only for the observed Host and origin", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => sessionResponse());
    const connection = client(fetcher);
    const material = {
      hostId,
      hostInstanceId,
      origin,
      ticket: token,
      expiresAtUnixMs: String(Date.now() + 100_000),
    };
    await connection.pair(JSON.stringify(material));
    for (const change of [
      { hostId: "f".repeat(32) },
      { origin: "https://other.test" },
      { hostInstanceId: "e".repeat(32) },
      { expiresAtUnixMs: "1" },
      { ticket: "bad" },
    ]) {
      await expect(
        connection.pair(JSON.stringify({ ...material, ...change })),
      ).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
        outcomeUnknown: false,
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(connection)).not.toContain(csrf);
  });
  it.each([
    "{invalid",
    "x".repeat(8193),
    "not-a-ticket",
    "3".repeat(32) + "." + "A".repeat(42) + "B",
  ])("rejects malformed pairing material", async (material) => {
    const fetcher = vi.fn();
    await expect(client(fetcher).pair(material)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "restores memory with Current → RenewCsrf → Refresh (access live=%s)",
    async (live) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          live ? sessionResponse("") : remote("UNAUTHENTICATED"),
        )
        .mockResolvedValueOnce(renewed())
        .mockResolvedValueOnce(sessionResponse(rotatedCSRF));
      const restored = await client(fetcher).resume();
      expect(restored?.device?.deviceId).toBe(deviceId);
      expect(restored).not.toHaveProperty("csrfToken");
      expect(
        fetcher.mock.calls.map((call) => String(call[0]).split("/").at(-1)),
      ).toEqual(["Current", "RenewCsrf", "Refresh"]);
      expect(fetcher.mock.calls[2]![1]!.headers).toHaveProperty(
        "X-Armadra-CSRF",
        csrf,
      );
    },
  );
  it("returns signed out only after explicit authentication denial, without retrying network failures", async () => {
    const denied = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(remote("UNAUTHENTICATED"))
      .mockResolvedValueOnce(remote("UNAUTHENTICATED"));
    expect(await client(denied).resume()).toBeNull();
    expect(denied).toHaveBeenCalledTimes(2);
    const network = vi.fn<typeof fetch>(async () => {
      throw new Error("secret-failure");
    });
    await expect(client(network).resume()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      outcomeUnknown: false,
      retryable: false,
    });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("serializes rotations and each request uses the previous committed CSRF", async () => {
    let first!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            first = resolve;
          }),
      )
      .mockResolvedValueOnce(sessionResponse(csrf));
    const connection = client(fetcher);
    await connection.pair(token);
    const a = connection.refresh(),
      b = connection.refresh();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    first(sessionResponse(rotatedCSRF));
    await Promise.all([a, b]);
    expect(fetcher.mock.calls[1]![1]!.headers).toHaveProperty(
      "X-Armadra-CSRF",
      csrf,
    );
    expect(fetcher.mock.calls[2]![1]!.headers).toHaveProperty(
      "X-Armadra-CSRF",
      rotatedCSRF,
    );
  });
  it("never stores tickets or CSRF in browser storage", async () => {
    const setItem = vi.fn(() => {
      throw new Error("storage is forbidden");
    });
    vi.stubGlobal("localStorage", { setItem });
    vi.stubGlobal("sessionStorage", { setItem });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(sessionResponse(rotatedCSRF));
    const connection = client(fetcher);
    await connection.pair(token);
    await connection.refresh();
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(connection)).toBe("{}");
  });
});

describe("device management and uncertain side effects", () => {
  it("sends exact uint64 revocation confirmation and demands a matching receipt", async () => {
    const revision = 9_007_199_254_740_993n;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        new Response(
          new Uint8Array(
            toBinary(
              RevokeDeviceResponseSchema,
              create(RevokeDeviceResponseSchema, { deviceId, revoked: true }),
            ),
          ),
          { headers },
        ),
      );
    const connection = client(fetcher);
    await connection.pair(token);
    await connection.revokeDevice(deviceId, revision);
    const init = fetcher.mock.calls[1]![1]!;
    expect(
      fromBinary(RevokeDeviceRequestSchema, init.body as Uint8Array)
        .expectedRevision,
    ).toBe(revision);
    expect(init.headers).toHaveProperty("X-Armadra-CSRF", csrf);
  });
  it("logs out with a recovered CSRF and does not require live access", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(renewed())
      .mockResolvedValueOnce(
        new Response(
          new Uint8Array(
            toBinary(
              SessionClosedResponseSchema,
              create(SessionClosedResponseSchema, { closed: true }),
            ),
          ),
          { headers },
        ),
      );
    await client(fetcher).logout();
    expect(
      fetcher.mock.calls.map((call) => String(call[0]).split("/").at(-1)),
    ).toEqual(["RenewCsrf", "Logout"]);
  });
  it("lists bounded device pages and rejects a cursor that cannot advance", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new Uint8Array(
            toBinary(
              ListDevicesResponseSchema,
              create(ListDevicesResponseSchema, {
                devices: [authenticated().device!],
                nextId: deviceId,
                hasMore: true,
              }),
            ),
          ),
          { headers },
        ),
    );
    const connection = client(fetcher);
    expect((await connection.listDevices()).devices).toHaveLength(1);
    await expect(connection.listDevices(deviceId)).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
    await expect(connection.listDevices("", 201)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
  });
  it("does not replay a mutation when the transport outcome is unknown", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("raw-ticket-secret");
    });
    try {
      await client(fetcher).pair(token);
      throw new Error("should fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "NETWORK_ERROR",
        retryable: false,
        outcomeUnknown: true,
      });
      expect(String(error)).not.toContain("raw-ticket-secret");
      expect(String(error)).not.toContain(token);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps explicit conflict/permission errors sanitized and certain", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(remote("CONFLICT", 409));
    const connection = client(fetcher);
    await connection.pair(token);
    await expect(connection.revokeDevice(deviceId, 1n)).rejects.toMatchObject({
      hostCode: "CONFLICT",
      outcomeUnknown: false,
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("bounded cancellation and response validation", () => {
  it.each([
    { hostId: "e".repeat(32) },
    { device: undefined },
    { csrfToken: "not-a-secret" },
    { expiresAtUnixMs: 0n },
    { scopes: [] },
  ])("rejects incomplete or wrong-host session metadata", async (overrides) => {
    await expect(
      client(async () => sessionResponse(csrf, overrides)).pair(token),
    ).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
      outcomeUnknown: true,
    });
  });
  it("cancels an oversized body and treats an unconfirmed mutation as unknown", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_FRAME_BYTES + 1));
      },
      cancel,
    });
    await expect(
      client(async () => new Response(body, { headers })).pair(token),
    ).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      outcomeUnknown: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("times out a stalled body even when transport cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const connection = client(
      async () => new Response(new ReadableStream({ cancel }), { headers }),
      { timeoutMs: 20 },
    );
    const pending = expect(connection.pair(token)).rejects.toMatchObject({
      code: "TIMEOUT",
      outcomeUnknown: true,
    });
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("dispose cancels active work and queued rotations, then discards a late body", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const connection = client(fetcher);
    const first = expect(connection.pair(token)).rejects.toMatchObject({
      code: "CANCELLED",
      outcomeUnknown: true,
    });
    const queued = expect(connection.refresh()).rejects.toMatchObject({
      code: "CANCELLED",
      outcomeUnknown: false,
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    connection.dispose();
    await Promise.all([first, queued]);
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel }), { headers }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(connection)).toBe("{}");
  });
});
