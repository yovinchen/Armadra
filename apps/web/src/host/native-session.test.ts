import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloResponse } from "@armadra/host-client";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  HostNativeSessionError,
  createHostIdentity,
  fetchNativeTicket,
  hasHostSessionCapability,
  hostSessionBlock,
  isNativeShell,
  nativeCredentials,
  nativeSessionFailureKey,
  pageOrigin,
  resetNativeSession,
} from "./native-session";

const hostId = "1".repeat(32),
  hostInstanceId = "2".repeat(32);
function hello(...capabilities: string[]): HelloResponse {
  return {
    $typeName: "armadra.v1.HelloResponse",
    hostId,
    hostInstanceId,
    protocol: { $typeName: "armadra.v1.ProtocolVersion", major: 1, minor: 1 },
    capabilities,
    capabilityStatus: [],
    maxFrameBytes: 1_048_576,
  };
}
function shell(origin = "tauri://localhost") {
  const url = new URL(origin);
  vi.stubGlobal("location", {
    origin: url.origin === "null" ? "null" : url.origin,
    protocol: url.protocol,
    host: url.host,
  });
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
    {};
}
function browser(origin = "https://host.test") {
  vi.stubGlobal("location", { origin, protocol: "https:", host: "host.test" });
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
}
const ticket = {
  hostId,
  hostInstanceId,
  origin: "tauri://localhost",
  ticket: "5".repeat(32) + "." + "T".repeat(42) + "A",
  expiresAtUnixMs: String(Date.now() + 60_000),
};

beforeEach(() => {
  mocks.invoke.mockReset();
  resetNativeSession();
});
afterEach(() => {
  browser();
  vi.unstubAllGlobals();
});

describe("hostSessionBlock", () => {
  it("keeps the browser rule outside the shell", () => {
    browser();
    expect(hostSessionBlock("http://127.0.0.1:43121")).toBe("tlsRequired");
    expect(hostSessionBlock("https://other.test")).toBe("sameOrigin");
    expect(hostSessionBlock("https://host.test")).toBeNull();
    expect(hostSessionBlock("not a url")).toBe("tlsRequired");
    expect(isNativeShell()).toBe(false);
  });
  it("is not fooled by a Tauri page origin without the shell, or the shell on a browser origin", () => {
    vi.stubGlobal("location", {
      origin: "null",
      protocol: "tauri:",
      host: "localhost",
    });
    expect(isNativeShell()).toBe(false);
    expect(hostSessionBlock("http://127.0.0.1:43121")).toBe("tlsRequired");
    shell("http://127.0.0.1:1420");
    expect(isNativeShell()).toBe(false);
    expect(hostSessionBlock("http://127.0.0.1:43121")).toBe("tlsRequired");
  });
  it.each([
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ])("accepts loopback HTTP inside the shell at %s", (origin) => {
    shell(origin);
    expect(isNativeShell()).toBe(true);
    expect(pageOrigin()).toBe(origin);
    expect(hostSessionBlock("http://127.0.0.1:43121")).toBeNull();
    expect(hostSessionBlock("http://localhost:43121")).toBeNull();
    expect(hostSessionBlock("http://192.168.1.20:43121")).toBe("tlsRequired");
    expect(hostSessionBlock("https://host.test")).toBe("sameOrigin");
  });
});

describe("capability negotiation and client construction", () => {
  it("asks for the browser capability in a browser and the native one in the shell", () => {
    browser();
    expect(hasHostSessionCapability(hello("identity.browser-session.v1"))).toBe(
      true,
    );
    expect(hasHostSessionCapability(hello("identity.native-session.v1"))).toBe(
      false,
    );
    shell();
    expect(hasHostSessionCapability(hello("identity.native-session.v1"))).toBe(
      true,
    );
    expect(hasHostSessionCapability(hello("identity.browser-session.v1"))).toBe(
      false,
    );
  });
  it("builds a cookie client in a browser and a shared native client in the shell", async () => {
    browser();
    const fetcher = vi.fn();
    expect(() =>
      createHostIdentity({
        baseUrl: "https://host.test",
        hostId,
        hostInstanceId,
        fetch: fetcher,
      }),
    ).not.toThrow();
    expect(() =>
      createHostIdentity({
        baseUrl: "http://127.0.0.1:43121",
        hostId,
        hostInstanceId,
        fetch: fetcher,
      }),
    ).toThrow();
    shell();
    expect(() =>
      createHostIdentity({
        baseUrl: "http://127.0.0.1:43121",
        hostId,
        hostInstanceId,
        fetch: fetcher,
      }),
    ).not.toThrow();
    expect(nativeCredentials()).toBe(nativeCredentials());
    expect(nativeCredentials().signedIn).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("fetchNativeTicket", () => {
  it("refuses outside the shell without touching the command", async () => {
    browser();
    await expect(fetchNativeTicket()).rejects.toMatchObject({
      reason: "shellUnavailable",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("returns the shell's ticket as the JSON pair() accepts", async () => {
    shell();
    mocks.invoke.mockResolvedValue(ticket);
    const material = await fetchNativeTicket();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("host_native_ticket");
    expect(JSON.parse(material)).toEqual(ticket);
  });
  it("maps the shell's stable reasons and treats anything else as unavailable", async () => {
    shell();
    for (const reason of [
      "hostUnavailable",
      "originUnsupported",
      "cliFailed",
      "timeout",
      "malformed",
    ]) {
      mocks.invoke.mockRejectedValueOnce({ reason });
      const failure = await fetchNativeTicket().catch((error) => error);
      expect(failure).toBeInstanceOf(HostNativeSessionError);
      expect(failure.reason).toBe(reason);
      expect(nativeSessionFailureKey(failure)).toBe(
        `hostNative.blocked.${reason}`,
      );
    }
    mocks.invoke.mockRejectedValueOnce(new Error("command not found"));
    await expect(fetchNativeTicket()).rejects.toMatchObject({
      reason: "shellUnavailable",
    });
    mocks.invoke.mockRejectedValueOnce({ reason: "somethingNew" });
    await expect(fetchNativeTicket()).rejects.toMatchObject({
      reason: "shellUnavailable",
    });
    mocks.invoke.mockResolvedValueOnce({ ...ticket, expiresAtUnixMs: 5 });
    await expect(fetchNativeTicket()).rejects.toMatchObject({
      reason: "malformed",
    });
    expect(nativeSessionFailureKey(new Error("x"))).toBeNull();
  });
  it("never writes the ticket to browser storage", async () => {
    shell();
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null });
    vi.stubGlobal("sessionStorage", { setItem, getItem: () => null });
    mocks.invoke.mockResolvedValue(ticket);
    await fetchNativeTicket();
    expect(setItem).not.toHaveBeenCalled();
  });
});
