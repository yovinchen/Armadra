import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bridgeTicket: vi.fn() }));

import {
  HostNativeSessionError,
  fetchNativeTicket,
  isNativeShell,
  nativeSessionFailureKey,
  pageOrigin,
} from "./native-session";
import {
  type IdentityHello,
  hasSessionCapability,
  sessionCapability,
} from "../api/identity";

const hostId = "1".repeat(32),
  hostInstanceId = "2".repeat(32);
function hello(...capabilities: string[]): IdentityHello {
  return {
    hostId,
    hostInstanceId,
    protocol: { major: 1, minor: 2 },
    capabilities,
    maxFrameBytes: 1_048_576,
  };
}
function browser(origin = "https://host.test") {
  const url = new URL(origin);
  vi.stubGlobal("location", {
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
  });
  delete (window as Window & { armadra?: unknown }).armadra;
}

/** The desktop shell: a preload bridge, on a loopback HTTP origin. */
function shell(origin = "http://127.0.0.1:54321") {
  browser(origin);
  (window as unknown as { armadra?: unknown }).armadra = {
    transport: { endpoints: vi.fn(), endpointsSync: vi.fn() },
    identity: { ticket: mocks.bridgeTicket },
  };
}
const ticket = {
  hostId,
  hostInstanceId,
  origin: "http://127.0.0.1:54321",
  ticket: "5".repeat(32) + "." + "T".repeat(42) + "A",
  expiresAtUnixMs: String(Date.now() + 60_000),
};

beforeEach(() => {
  mocks.bridgeTicket.mockReset();
});
afterEach(() => {
  browser();
  vi.unstubAllGlobals();
});

describe("是不是壳里的这张页面", () => {
  it("一个回环来源本身证明不了任何事", () => {
    // 浏览器也可以停在一个回环 HTTP 来源上，而它没有任何通往票据的通道。
    browser("http://127.0.0.1:1420");
    expect(isNativeShell()).toBe(false);

    // 一个把页面从这台机器之外加载进来的壳也不是原生会话，不管它多真。
    shell("https://armadra.example");
    expect(isNativeShell()).toBe(false);
  });

  /**
   * 壳（docs/design/electron-migration.md §2.1）：页面由回环 HTTP 上一个内核
   * 分配端口的静态服务提供，所以壳的来源不是一个固定拼法，这个判断不能是常量。
   */
  it.each([
    "http://127.0.0.1:54321",
    "http://127.0.0.1:1420",
    "http://localhost:61000",
  ])("把壳自己的回环来源 %s 认成原生", (origin) => {
    shell(origin);
    expect(isNativeShell()).toBe(true);
    expect(pageOrigin()).toBe(origin);
    expect(sessionCapability()).toBe("identity.native-session.v1");
  });
});

describe("capability negotiation", () => {
  it("asks for the browser capability in a browser and the native one in the shell", () => {
    browser();
    expect(hasSessionCapability(hello("identity.browser-session.v1"))).toBe(
      true,
    );
    expect(hasSessionCapability(hello("identity.native-session.v1"))).toBe(
      false,
    );
    shell();
    expect(hasSessionCapability(hello("identity.native-session.v1"))).toBe(
      true,
    );
    expect(hasSessionCapability(hello("identity.browser-session.v1"))).toBe(
      false,
    );
  });
});

/**
 * A refusal is a RESULT, not a rejection: Electron serializes a rejected
 * `ipcMain.handle` down to its message, so the structure would not survive.
 * The reasons, and therefore the i18n keys, are the stable set §4.3 names.
 */
describe("fetchNativeTicket through the shell bridge", () => {
  const shellTicket = { ...ticket };

  it("refuses outside the shell without touching the bridge", async () => {
    browser();
    await expect(fetchNativeTicket()).rejects.toMatchObject({
      reason: "shellUnavailable",
    });
    expect(mocks.bridgeTicket).not.toHaveBeenCalled();
  });

  /**
   * core 的 `/api/identity/pair` 收的是 `<id>.<secret>` 那个票本身
   * （`core/identity/service.ts` 的 `parseToken`）。送整个信封 JSON 会在拆票
   * 那一步就落空，配对永远 401：桌面壳一台设备都配不出来，自动化与 GitHub
   * 两块面板从此打不开。
   */
  it("交出去的是信封里那个票，不是信封", async () => {
    shell();
    mocks.bridgeTicket.mockResolvedValue({ ok: true, ticket: shellTicket });
    expect(await fetchNativeTicket()).toBe(shellTicket.ticket);
    expect(mocks.bridgeTicket).toHaveBeenCalledOnce();
  });

  it("never writes the ticket to browser storage", async () => {
    shell();
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null });
    vi.stubGlobal("sessionStorage", { setItem, getItem: () => null });
    mocks.bridgeTicket.mockResolvedValue({ ok: true, ticket: shellTicket });
    await fetchNativeTicket();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("maps the same stable reasons to the same message keys", async () => {
    shell();
    for (const code of [
      "hostUnavailable",
      "originUnsupported",
      "cliFailed",
      "timeout",
      "malformed",
    ]) {
      mocks.bridgeTicket.mockResolvedValueOnce({
        ok: false,
        error: { code, message: "no ticket" },
      });
      const failure = await fetchNativeTicket().catch((error) => error);
      expect(failure).toBeInstanceOf(HostNativeSessionError);
      expect(failure.reason).toBe(code);
      // The i18n keys are unchanged by the port: the same sentence is shown
      // whichever shell the page is running in.
      expect(nativeSessionFailureKey(failure)).toBe(
        `hostNative.blocked.${code}`,
      );
    }
  });

  it("treats anything it does not recognise as no shell at all", async () => {
    shell();
    for (const answer of [
      { ok: false, error: { code: "somethingNew", message: "x" } },
      { ok: false },
      { ok: "yes", ticket: shellTicket },
      undefined,
      "a ticket",
    ]) {
      mocks.bridgeTicket.mockResolvedValueOnce(answer);
      await expect(fetchNativeTicket()).rejects.toMatchObject({
        reason: "shellUnavailable",
      });
    }
    mocks.bridgeTicket.mockRejectedValueOnce(new Error("channel gone"));
    await expect(fetchNativeTicket()).rejects.toMatchObject({
      reason: "shellUnavailable",
    });
  });

  it("still refuses a ticket that is not one", async () => {
    shell();
    mocks.bridgeTicket.mockResolvedValue({
      ok: true,
      ticket: { ...shellTicket, expiresAtUnixMs: 5 },
    });
    await expect(fetchNativeTicket()).rejects.toMatchObject({
      reason: "malformed",
    });
  });

  it("asks for nothing when the page is not on a shell origin", async () => {
    shell("https://armadra.example");
    await expect(fetchNativeTicket()).rejects.toMatchObject({
      reason: "shellUnavailable",
    });
    expect(mocks.bridgeTicket).not.toHaveBeenCalled();
  });
});
