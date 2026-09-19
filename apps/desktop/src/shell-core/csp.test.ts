import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, isPageUrl } from "./csp";

/**
 * The policy the Rust shell had in its packaged configuration does not come
 * across by itself — Electron gives a page none — so what it granted, and what
 * it refused, is asserted here rather than remembered.
 */

function directive(name: string): string {
  const found = contentSecurityPolicy()
    .split("; ")
    .find((entry) => entry.startsWith(`${name} `));
  return found ?? "";
}

describe("the page's policy", () => {
  it("lets the page reach the Runtime and the Host on loopback", () => {
    const connect = directive("connect-src");
    // Both ports are kernel-assigned (the Runtime always, the Host when it is
    // asked to choose), so the grant is by host rather than by number.
    expect(connect).toContain("http://127.0.0.1:*");
    expect(connect).toContain("ws://127.0.0.1:*");
    expect(connect).toContain("'self'");
  });

  it("no longer grants the custom scheme the forwarding path needed", () => {
    // `armadra:` existed only because the old page origin was not an HTTP
    // origin. There is no protocol handler left to reach.
    expect(contentSecurityPolicy()).not.toContain("armadra:");
  });

  it("grants nothing off this machine", () => {
    for (const entry of contentSecurityPolicy().split("; ")) {
      // frame-src is the one exception, and it is deliberate: browser nodes
      // still render other people's pages in an iframe until W3.
      if (entry.startsWith("frame-src")) continue;
      expect(entry, entry).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    }
    expect(directive("frame-src")).toBe("frame-src http: https:");
  });

  it("keeps the refusals that have nothing to do with the shell change", () => {
    const policy = contentSecurityPolicy();
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
    // No script-src override: `default-src 'self'` already refuses inline and
    // eval, and spelling one out is how an 'unsafe-inline' gets added later.
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("script-src");
  });
});

describe("which documents the policy is attached to", () => {
  it("covers our own page and nothing a browser node loads", () => {
    const origin = "http://127.0.0.1:54321";
    expect(isPageUrl(origin, origin)).toBe(true);
    expect(isPageUrl(`${origin}/workspace/one`, origin)).toBe(true);
    // Imposing `default-src 'self'` on somebody else's site would break it
    // while looking like that site's own bug.
    expect(isPageUrl("https://example.com/", origin)).toBe(false);
    expect(isPageUrl(`${origin}.evil.example/`, origin)).toBe(false);
    expect(isPageUrl("http://127.0.0.1:54322/", origin)).toBe(false);
  });
});
