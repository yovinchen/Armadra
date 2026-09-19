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
  PairDeviceRequestSchema,
} from "@armadra/protocol";
import { HostIdentityClient, HostIdentityError } from "../src/identity.js";
import {
  HostNativeCredentials,
  isNativePageOrigin,
} from "../src/native.js";

const hostId = "1".repeat(32),
  hostInstanceId = "2".repeat(32),
  deviceId = "3".repeat(32),
  principalId = "4".repeat(32);
// 32 bytes of base64url end on one of sixteen letters; "A" is one of them.
const secretOf = (letter: string) =>
  "5".repeat(32) + "." + letter.repeat(42) + "A";
const ticket = secretOf("T");
const access = secretOf("a"),
  refresh = secretOf("R"),
  access2 = secretOf("B"),
  refresh2 = secretOf("S");
const csrf = "C".repeat(42) + "A",
  csrf2 = "D".repeat(42) + "A";
const hostUrl = "http://127.0.0.1:43121";
const pageOrigin = "http://127.0.0.1:54321";
const headers = { "Content-Type": "application/x-protobuf" };

function session(
  overrides: Record<string, unknown> = {},
  native?: { accessToken: string; refreshToken: string },
) {
  return new Response(
    new Uint8Array(
      toBinary(
        AuthenticatedSessionSchema,
        create(AuthenticatedSessionSchema, {
          hostId,
          device: {
            deviceId,
            principalId,
            displayName: "本机桌面",
            role: "owner",
            revision: 1n,
            createdAtUnixMs: 1n,
          },
          scopes: [{ permission: "identity:read" }],
          csrfToken: csrf,
          expiresAtUnixMs: BigInt(Date.now() + 900_000),
          native,
          ...overrides,
        }),
      ),
    ),
    { headers },
  );
}
function renewed(value = csrf2) {
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
        create(ErrorResponseSchema, { code, message: "redacted" }),
      ),
    ),
    { status, headers },
  );
}
function devices() {
  return new Response(
    new Uint8Array(
      toBinary(
        ListDevicesResponseSchema,
        create(ListDevicesResponseSchema, {
          devices: [
            {
              deviceId,
              principalId,
              displayName: "本机桌面",
              role: "owner",
              revision: 1n,
              createdAtUnixMs: 1n,
            },
          ],
        }),
      ),
    ),
    { headers },
  );
}
function closed() {
  return new Response(
    new Uint8Array(
      toBinary(
        SessionClosedResponseSchema,
        create(SessionClosedResponseSchema, { closed: true }),
      ),
    ),
    { headers },
  );
}
type Call = { action: string; init: RequestInit };
function calls(fetcher: ReturnType<typeof vi.fn>): Call[] {
  return fetcher.mock.calls.map(([url, init]) => ({
    action: String(url).split("/").pop()!,
    init: init as RequestInit,
  }));
}
function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}
function credentials(ticketSource = vi.fn(async () => ticket)) {
  return {
    store: new HostNativeCredentials({ ticket: ticketSource }),
    ticketSource,
  };
}
function client(
  fetcher: typeof fetch,
  store: HostNativeCredentials,
  options: Record<string, unknown> = {},
) {
  return new HostIdentityClient({
    baseUrl: hostUrl,
    hostId,
    hostInstanceId,
    pageOrigin,
    transport: { kind: "native", credentials: store },
    fetch: fetcher,
    ...options,
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native transport configuration", () => {
  it("accepts exactly loopback HTTP from a native page origin", () => {
    const { store } = credentials();
    for (const baseUrl of [
      "http://127.0.0.1:43121",
      "http://localhost:43121",
      "http://[::1]:43121",
      "http://127.0.0.1:43121/prefix",
    ])
      for (const origin of [
        "http://127.0.0.1:54321",
        "http://localhost:61000",
        "http://[::1]:61000",
      ])
        expect(() =>
          client(vi.fn(), store, { baseUrl, pageOrigin: origin }),
        ).not.toThrow();
  });
  it.each([
    ["https://127.0.0.1:43121", pageOrigin],
    ["https://host.test", pageOrigin],
    ["http://192.168.1.20:43121", pageOrigin],
    ["http://host.test:43121", pageOrigin],
    ["http://user:secret@127.0.0.1:43121", pageOrigin],
    ["http://127.0.0.1:43121?ticket=x", pageOrigin],
    ["http://127.0.0.1:43121#x", pageOrigin],
    [hostUrl, "https://host.test"],
    // HTTPS on loopback is a browser deployment; only plain loopback HTTP is
    // a shell origin (docs/design/electron-migration.md §2.1).
    [hostUrl, "https://127.0.0.1:1420"],
    [hostUrl, "http://192.168.1.20:1420"],
    [hostUrl, "http://127.0.0.1.evil.example"],
    [hostUrl, "http://127.0.0.1:1420/app"],
    [hostUrl, "app://localhost"],
    [hostUrl, undefined],
  ])("refuses %s from page %s without a request", (baseUrl, origin) => {
    const fetcher = vi.fn();
    const { store } = credentials();
    expect(() =>
      client(fetcher, store, { baseUrl, pageOrigin: origin }),
    ).toThrow(HostIdentityError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps the browser transport exactly as it was", () => {
    // The browser rule is not relaxed by the native transport existing: a
    // loopback HTTP Host, or a shell page origin, still fails without it.
    for (const options of [
      { baseUrl: hostUrl, pageOrigin: hostUrl },
      { baseUrl: "https://host.test", pageOrigin },
      { baseUrl: hostUrl, pageOrigin, transport: { kind: "browser" } },
    ])
      expect(
        () =>
          new HostIdentityClient({
            hostId,
            hostInstanceId,
            fetch: vi.fn(),
            ...options,
          } as never),
      ).toThrow(HostIdentityError);
    expect(
      () =>
        new HostIdentityClient({
          baseUrl: "https://host.test",
          hostId,
          hostInstanceId,
          pageOrigin: "https://host.test",
          fetch: vi.fn(),
        }),
    ).not.toThrow();
    expect(() =>
      client(vi.fn(), store(), { transport: { kind: "cookie" } }),
    ).toThrow(HostIdentityError);
    expect(() =>
      client(vi.fn(), store(), {
        transport: { kind: "native", credentials: {} },
      }),
    ).toThrow(HostIdentityError);
    expect(() => new HostNativeCredentials({} as never)).toThrow(
      HostIdentityError,
    );
    function store() {
      return credentials().store;
    }
  });

  /**
   * The Electron shell serves its page from a loopback HTTP static server on
   * a kernel-assigned port, so a shell origin can no longer be one of three
   * fixed spellings (docs/design/electron-migration.md §2.1). The same table
   * is pinned on the other two sides that have to agree with it:
   * `apps/host/internal/server/native.go` and the desktop shell's
   * `shell-core/host/config.ts`.
   *
   * Widening the spelling moves no trust boundary: a browser page CAN hold a
   * loopback HTTP origin, and still cannot mint the ticket a session starts
   * from — only the shell's same-user control channel does that.
   */
  it("treats any loopback HTTP origin as a shell's, and nothing else", () => {
    for (const origin of [
      "http://127.0.0.1:1420",
      "http://127.0.0.1:54321",
      "http://127.5.5.5:8080",
      "http://localhost:3000",
      "http://[::1]:9000",
    ])
      expect(isNativePageOrigin(origin), origin).toBe(true);

    for (const origin of [
      "https://127.0.0.1:54321",
      "http://192.168.1.20:54321",
      "https://host.test",
      "http://127.0.0.1.evil.example",
      "http://localhost.evil.example",
      "http://127.0.0.1:54321/app",
      "http://user:pass@127.0.0.1:54321",
      // A custom scheme is not an HTTP origin, however local it looks.
      "app://localhost",
      "",
      "not a url",
      undefined,
    ])
      expect(isNativePageOrigin(origin), String(origin)).toBe(false);
  });

  it("accepts the Electron shell's page origin end to end", () => {
    // The port is the kernel's, so nothing may compare against a constant.
    for (const origin of ["http://127.0.0.1:54321", "http://localhost:61234"])
      expect(() =>
        client(vi.fn(), credentials().store, {
          baseUrl: hostUrl,
          pageOrigin: origin,
        }),
      ).not.toThrow();
  });
});

describe("native pairing and bearer requests", () => {
  it("pairs with a ticket from the shell, sends bearers instead of cookies and never exposes the secrets", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const action = String(url).split("/").pop();
      if (action === "Pair")
        return session({}, { accessToken: access, refreshToken: refresh });
      if (action === "ListDevices") return devices();
      return remote("UNAUTHENTICATED");
    });
    const { store, ticketSource } = credentials();
    const identity = client(fetcher, store);
    const value = await identity.resume();
    expect(ticketSource).toHaveBeenCalledOnce();
    expect(value?.device?.displayName).toBe("本机桌面");
    expect(value).not.toHaveProperty("native");
    expect(value).not.toHaveProperty("csrfToken");
    expect(store.signedIn).toBe(true);
    const [pair] = calls(fetcher);
    expect(pair!.action).toBe("Pair");
    expect(pair!.init.credentials).toBe("omit");
    expect(header(pair!, "Authorization")).toBeUndefined();
    expect(
      fromBinary(PairDeviceRequestSchema, pair!.init.body as Uint8Array).ticket,
    ).toBe(ticket);
    const page = await identity.listDevices();
    expect(page.devices).toHaveLength(1);
    const list = calls(fetcher)[1]!;
    expect(list.action).toBe("ListDevices");
    expect(header(list, "Authorization")).toBe(`Bearer ${access}`);
    expect(list.init.credentials).toBe("omit");
    expect(header(list, "X-Armadra-CSRF")).toBeUndefined();
  });
  it("accepts the shell's JSON material bound to the page origin, not the Host address", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      session({}, { accessToken: access, refreshToken: refresh }),
    );
    const material = JSON.stringify({
      hostId,
      hostInstanceId,
      origin: pageOrigin,
      ticket,
      expiresAtUnixMs: String(Date.now() + 60_000),
    });
    const { store } = credentials(vi.fn(async () => material));
    await expect(client(fetcher, store).resume()).resolves.toBeTruthy();
    const wrong = credentials(
      vi.fn(async () =>
        JSON.stringify({ ...JSON.parse(material), origin: hostUrl }),
      ),
    );
    await expect(client(fetcher, wrong.store).resume()).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
  });
  it("rejects a Pair answer without bearer credentials and stores nothing", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => session());
    const { store } = credentials();
    await expect(client(fetcher, store).resume()).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
    expect(store.signedIn).toBe(false);
    for (const bad of [
      { accessToken: "short", refreshToken: refresh },
      { accessToken: access, refreshToken: "" },
    ]) {
      const f = vi.fn<typeof fetch>(async () => session({}, bad));
      await expect(client(f, store).resume()).rejects.toMatchObject({
        code: "MALFORMED_RESPONSE",
      });
      expect(store.signedIn).toBe(false);
    }
  });
  it("propagates the shell's own failure to the caller unchanged", async () => {
    class ShellFailure extends Error {}
    const { store } = credentials(
      vi.fn(async () => {
        throw new ShellFailure("hostUnavailable");
      }),
    );
    const fetcher = vi.fn();
    await expect(client(fetcher, store).resume()).rejects.toBeInstanceOf(
      ShellFailure,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("shared native credentials", () => {
  it("lets a second client reuse the session without pairing again and refreshes only when the access token is stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const action = String(url).split("/").pop();
      const bearer = (init?.headers as Record<string, string>).Authorization;
      if (action === "Pair")
        return session({}, { accessToken: access, refreshToken: refresh });
      if (action === "Current" && bearer === `Bearer ${access}`)
        return session({ csrfToken: "" });
      if (action === "RenewCsrf" && bearer === `Bearer ${refresh}`)
        return renewed();
      if (action === "Refresh" && bearer === `Bearer ${refresh}`)
        return session(
          { csrfToken: csrf2 },
          { accessToken: access2, refreshToken: refresh2 },
        );
      if (action === "Current" && bearer === `Bearer ${access2}`)
        return session({ csrfToken: "" });
      return remote("UNAUTHENTICATED");
    });
    const { store, ticketSource } = credentials();
    const first = client(fetcher, store);
    await first.resume();
    const second = client(fetcher, store);
    await second.resume();
    expect(ticketSource).toHaveBeenCalledOnce();
    expect(calls(fetcher).map((call) => call.action)).toEqual([
      "Pair",
      "Current",
    ]);
    // Near expiry the next caller rotates through the shared store; the
    // refresh bearer is the refresh secret, and the rotated pair replaces it.
    vi.setSystemTime(1_800_000_000_000 + 900_000 - 10_000);
    const value = await second.resume();
    expect(value?.device?.deviceId).toBe(deviceId);
    expect(calls(fetcher).map((call) => call.action)).toEqual([
      "Pair",
      "Current",
      "Refresh",
    ]);
    expect(header(calls(fetcher)[2]!, "Authorization")).toBe(
      `Bearer ${refresh}`,
    );
    expect(header(calls(fetcher)[2]!, "X-Armadra-CSRF")).toBe(csrf);
    expect(store.access).toBe(access2);
    expect(store.refresh).toBe(refresh2);
    expect(store.csrf).toBe(csrf2);
    // The first client now sends the rotated bearer without being told.
    await first.current();
    expect(header(calls(fetcher)[3]!, "Authorization")).toBe(
      `Bearer ${access2}`,
    );
  });
  it("serializes concurrent resumes across clients so only one pairing happens", async () => {
    let pending = 0,
      overlap = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      pending += 1;
      overlap = Math.max(overlap, pending);
      await new Promise((resolve) => setTimeout(resolve, 5));
      pending -= 1;
      const action = String(url).split("/").pop();
      if (action === "Pair")
        return session({}, { accessToken: access, refreshToken: refresh });
      return session({ csrfToken: "" });
    });
    const { store, ticketSource } = credentials();
    const results = await Promise.all(
      [1, 2, 3].map(() => client(fetcher, store).resume()),
    );
    expect(results.every((value) => value?.device?.deviceId === deviceId)).toBe(
      true,
    );
    expect(ticketSource).toHaveBeenCalledOnce();
    expect(overlap).toBe(1);
    expect(calls(fetcher).map((call) => call.action)).toEqual([
      "Pair",
      "Current",
      "Current",
    ]);
  });
  it("re-pairs with a fresh ticket when the Host no longer knows the session", async () => {
    let paired = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const action = String(url).split("/").pop();
      if (action === "Pair") {
        paired += 1;
        return session(
          {},
          {
            accessToken: paired === 1 ? access : access2,
            refreshToken: paired === 1 ? refresh : refresh2,
          },
        );
      }
      if (paired === 1) return remote("UNAUTHENTICATED");
      return session({ csrfToken: "" });
    });
    const { store, ticketSource } = credentials();
    const identity = client(fetcher, store);
    await identity.resume();
    // Host restarted: Current, then the RenewCsrf/Refresh recovery, all 401.
    const value = await identity.resume();
    expect(value?.device?.deviceId).toBe(deviceId);
    expect(ticketSource).toHaveBeenCalledTimes(2);
    expect(store.access).toBe(access2);
    expect(calls(fetcher).map((call) => call.action)).toEqual([
      "Pair",
      "Current",
      "Refresh",
      "Pair",
    ]);
  });
  it("does not re-pair on a network failure", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const action = String(url).split("/").pop();
      if (action === "Pair")
        return session({}, { accessToken: access, refreshToken: refresh });
      throw new TypeError("offline");
    });
    const { store, ticketSource } = credentials();
    const identity = client(fetcher, store);
    await identity.resume();
    await expect(identity.resume()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(ticketSource).toHaveBeenCalledOnce();
    expect(store.signedIn).toBe(true);
  });
});

describe("native sends, retries and sign-out", () => {
  it("refreshes once and retries a request the Host refused as unauthenticated", async () => {
    let refreshed = false;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const action = String(url).split("/").pop();
      const bearer = (init?.headers as Record<string, string>).Authorization;
      if (action === "Pair")
        return session({}, { accessToken: access, refreshToken: refresh });
      if (action === "Refresh") {
        refreshed = true;
        return session(
          { csrfToken: csrf2 },
          { accessToken: access2, refreshToken: refresh2 },
        );
      }
      if (action === "Get" || action === "Put")
        return bearer === `Bearer ${access2}`
          ? new Response(new Uint8Array([8, 1]), { headers })
          : remote("UNAUTHENTICATED");
      return remote("UNAUTHENTICATED");
    });
    const { store } = credentials();
    const identity = client(fetcher, store);
    await identity.resume();
    const wire = await identity.send(
      "SettingsService",
      "Get",
      new Uint8Array(),
      false,
    );
    expect(Array.from(wire)).toEqual([8, 1]);
    expect(refreshed).toBe(true);
    expect(calls(fetcher).map((call) => call.action)).toEqual([
      "Pair",
      "Get",
      "Refresh",
      "Get",
    ]);
    // A mutation carries the rotated CSRF and the rotated bearer.
    await identity.send("SettingsService", "Put", new Uint8Array(), true);
    const put = calls(fetcher).at(-1)!;
    expect(header(put, "Authorization")).toBe(`Bearer ${access2}`);
    expect(header(put, "X-Armadra-CSRF")).toBe(csrf2);
  });
  it("retries only once and surfaces a second refusal", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const action = String(url).split("/").pop();
      if (action === "Pair" || action === "Refresh")
        return session({}, { accessToken: access, refreshToken: refresh });
      return remote("PERMISSION_DENIED", 403);
    });
    const { store } = credentials();
    const identity = client(fetcher, store);
    await identity.resume();
    await expect(
      identity.send("SettingsService", "Get", new Uint8Array(), false),
    ).rejects.toMatchObject({ hostCode: "PERMISSION_DENIED" });
    expect(calls(fetcher).map((call) => call.action)).toEqual(["Pair", "Get"]);
  });
  it("refuses to send without a held session instead of sending an empty bearer", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { store } = credentials();
    await expect(
      client(fetcher, store).send(
        "SettingsService",
        "Get",
        new Uint8Array(),
        false,
      ),
    ).rejects.toMatchObject({ hostCode: "UNAUTHENTICATED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("logs out with the refresh bearer and clears the shared credentials for every client", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const action = String(url).split("/").pop();
      if (action === "Pair")
        return session({}, { accessToken: access, refreshToken: refresh });
      if (action === "Logout") return closed();
      return remote("UNAUTHENTICATED");
    });
    const { store } = credentials();
    const identity = client(fetcher, store);
    const other = client(fetcher, store);
    await identity.resume();
    await identity.logout();
    const logout = calls(fetcher).at(-1)!;
    expect(logout.action).toBe("Logout");
    expect(header(logout, "Authorization")).toBe(`Bearer ${refresh}`);
    expect(header(logout, "X-Armadra-CSRF")).toBe(csrf);
    expect(store.signedIn).toBe(false);
    expect(store.access).toBe("");
    await expect(
      other.send("SettingsService", "Get", new Uint8Array(), false),
    ).rejects.toMatchObject({ hostCode: "UNAUTHENTICATED" });
    // Disposing a client leaves the shared store alone.
    const { store: kept } = credentials();
    const holder = client(fetcher, kept);
    await holder.resume();
    holder.dispose();
    expect(kept.signedIn).toBe(true);
  });
  it("never writes native secrets to browser storage", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null });
    vi.stubGlobal("sessionStorage", { setItem, getItem: () => null });
    const fetcher = vi.fn<typeof fetch>(async () =>
      session({}, { accessToken: access, refreshToken: refresh }),
    );
    const { store } = credentials();
    await client(fetcher, store).resume();
    expect(setItem).not.toHaveBeenCalled();
  });
});
