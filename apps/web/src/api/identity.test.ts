import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nativeShell: false,
  ticket: vi.fn(async () => "shell-ticket"),
}));

vi.mock("../host/native-session", async (original) => {
  const actual = await original<typeof import("../host/native-session")>();
  return {
    ...actual,
    isNativeShell: () => mocks.nativeShell,
    fetchNativeTicket: () => mocks.ticket(),
  };
});

import {
  ensureCsrf,
  forgetCsrf,
  currentCsrf,
  identityHello,
  identitySessionSchema,
  IdentityRequestError,
  IdentityTransportError,
  listIdentityDevices,
  logoutIdentity,
  onIdentitySessionChange,
  pairIdentity,
  permits,
  resetIdentityCredentials,
  resumeIdentity,
  revokeIdentityDevice,
  takePairingTicket,
} from "./identity";

const SECRET = "a".repeat(43);

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answer: (call: Call) => { status?: number; body: unknown };

function fetchStub() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  });
}

const session = {
  hostId: "h1",
  device: {
    deviceId: "d1",
    principalId: "p1",
    displayName: "Laptop",
    role: "owner",
    createdAtUnixMs: 1,
    revision: 2,
  },
  scopes: [
    { permission: "identity:read", workspaceId: "", executionHostId: "" },
  ],
  expiresAtUnixMs: 10,
  csrfToken: SECRET,
};

/** 默认按路径回答，和 core 的 JSON 面一一对上。 */
function defaultAnswer(call: Call): { status?: number; body: unknown } {
  if (call.url.includes("devices/revoke"))
    return { body: { deviceId: "d2", revoked: true } };
  if (call.url.includes("/devices"))
    return { body: { devices: [], nextId: "", hasMore: false } };
  if (call.url.includes("session/logout")) return { body: { closed: true } };
  if (call.url.includes("session/csrf")) return { body: { csrfToken: SECRET } };
  return { body: session };
}

beforeEach(() => {
  calls = [];
  answer = defaultAnswer;
  mocks.nativeShell = false;
  mocks.ticket.mockReset().mockResolvedValue("shell-ticket");
  resetIdentityCredentials();
  vi.stubGlobal("fetch", fetchStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetIdentityCredentials();
});

describe("the identity JSON surface", () => {
  it("parses a session and keeps the secrets out of the parsed shape", () => {
    const parsed = identitySessionSchema.parse({
      hostId: "h1",
      device: { deviceId: "d1" },
      expiresAtUnixMs: 5,
    });
    expect(parsed.device.displayName).toBe("");
    expect(parsed.scopes).toEqual([]);
    expect(parsed.native).toBeUndefined();
  });

  /** 一份少了 `hostId` 的回答不是一份「大概能用」的会话，是一份解不出的回答。 */
  it("refuses an answer that is not a session", () => {
    expect(() =>
      identitySessionSchema.parse({ device: { deviceId: "d1" } }),
    ).toThrow();
  });

  it("asks hello without credentials", async () => {
    answer = () => ({
      body: { hostId: "h1", hostInstanceId: "i1", capabilities: ["a"] },
    });
    const hello = await identityHello();
    expect(hello.capabilities).toEqual(["a"]);
    expect(calls[0]?.url).toContain("/api/identity/hello");
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe(undefined);
  });

  it("turns a refusal into a code, and a dead socket into a different failure", async () => {
    answer = () => ({
      status: 403,
      body: { code: "PERMISSION_DENIED", message: "no" },
    });
    await expect(identityHello()).rejects.toBeInstanceOf(IdentityRequestError);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    );
    await expect(identityHello()).rejects.toBeInstanceOf(
      IdentityTransportError,
    );
  });
});

describe("the browser (server shell) transport", () => {
  it("sends cookies and the double-submit header on writes", async () => {
    await pairIdentity("ticket");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(currentCsrf()).toBe(SECRET);

    await revokeIdentityDevice("d2", 3);
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers["X-Armadra-CSRF"]).toBe(SECRET);
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({
      deviceId: "d2",
      expectedRevision: 3,
    });
  });

  /**
   * 刷新页面之后内存里什么都没有，但 refresh Cookie 还在：换一枚，而不是
   * 让此后每一次写请求都撞上 403。
   */
  it("renews a token it does not have, once", async () => {
    answer = () => ({ body: { csrfToken: SECRET } });
    const [first, second] = await Promise.all([ensureCsrf(), ensureCsrf()]);
    expect(first).toBe(SECRET);
    expect(second).toBe(SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/identity/session/csrf");
  });

  it("forgets a rotated token so the next write fetches a new one", async () => {
    await pairIdentity("ticket");
    forgetCsrf();
    expect(currentCsrf()).toBe("");
  });

  it("announces a session change exactly once per change", async () => {
    const seen = vi.fn();
    const stop = onIdentitySessionChange(seen);
    await pairIdentity("ticket");
    expect(seen).toHaveBeenCalledTimes(1);
    await pairIdentity("ticket");
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    await logoutIdentity();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("reads a signed-out browser as no session rather than an error", async () => {
    answer = (call) =>
      call.url.includes("session/refresh")
        ? { status: 401, body: { code: "UNAUTHENTICATED" } }
        : { status: 401, body: { code: "UNAUTHENTICATED" } };
    expect(await resumeIdentity()).toBeNull();
  });
});

describe("the desktop shell transport", () => {
  beforeEach(() => {
    mocks.nativeShell = true;
  });

  /** 壳里没有 Cookie 可带；票换来的密钥只在内存里，经 Bearer 送出去。 */
  it("pairs with a shell ticket and then carries a bearer, never a cookie", async () => {
    answer = (call) =>
      call.url.includes("/pair")
        ? {
            body: {
              ...session,
              csrfToken: "",
              native: { accessToken: "A", refreshToken: "R" },
            },
          }
        : defaultAnswer(call);
    const resumed = await resumeIdentity();
    expect(resumed?.hostId).toBe("h1");
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      ticket: "shell-ticket",
    });
    expect(calls[0]?.init.credentials).toBe("omit");

    await listIdentityDevices();
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer A");
    expect(headers["X-Armadra-CSRF"]).toBe(undefined);
  });
});

describe("permits", () => {
  const granted = {
    ...session,
    scopes: [
      { permission: "updates:read", workspaceId: "", executionHostId: "" },
      { permission: "canvas:write", workspaceId: "w1", executionHostId: "" },
    ],
  };

  /** 一条限定工作空间的授权不覆盖「整台机器」那一问。 */
  it("does not let a workspace grant answer a host-wide question", () => {
    expect(permits(granted, "updates:read")).toBe(true);
    expect(permits(granted, "canvas:write")).toBe(false);
    expect(permits(granted, "canvas:write", { workspaceId: "w1" })).toBe(true);
    expect(permits(granted, "canvas:write", { workspaceId: "w2" })).toBe(false);
  });
});

describe("takePairingTicket", () => {
  it("takes the fragment once and wipes it from the address bar", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("location", {
      hash: "#pair=abc-123",
      pathname: "/",
      search: "",
    });
    vi.stubGlobal("history", { replaceState });
    expect(takePairingTicket()).toBe("abc-123");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("ignores anything that is not a pairing fragment", () => {
    vi.stubGlobal("location", { hash: "#settings", pathname: "/", search: "" });
    expect(takePairingTicket()).toBe("");
  });
});
