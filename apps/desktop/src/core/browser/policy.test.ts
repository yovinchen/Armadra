import { describe, expect, it } from "vitest";
import { WORKSPACE_EVENT_TYPES } from "../bus";
import {
  ADMIT,
  admitDocument,
  admitSubresource,
  admitUrl,
  defaultNetworkPolicy,
  effectivePort,
  parseTarget,
  refuse,
  safeFilename,
} from "./policy";
import { MIN_VIEWPORT, MAX_VIEWPORT, clampViewport } from "./model";

/**
 * Checks that need no browser: URL admission, filenames and viewports.
 *
 * Ported from `apps/runtime/src/browser/tests/policy.rs`.
 */

describe("where a browser node may be pointed", () => {
  it("admits only http addresses a project can reach", () => {
    expect(admitUrl("127.0.0.1:5173/app")).toBe("https://127.0.0.1:5173/app");
    expect(admitUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
    for (const refused of [
      "file:///etc/passwd",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
    ]) {
      expect(() => admitUrl(refused), refused).toThrow();
    }
    // Cloud instance metadata hands out credentials to whatever asks.
    expect(() =>
      admitUrl("http://169.254.169.254/latest/meta-data/"),
    ).toThrow();
    expect(() => admitUrl("http://metadata.google.internal/")).toThrow();
    // Armadra's own control surfaces are not a browsing target.
    expect(() => admitUrl("http://127.0.0.1:43120/api/workspaces")).toThrow();
    expect(() => admitUrl("http://localhost:43121/")).toThrow();
    // …but the project's own dev server on loopback is exactly the point.
    expect(admitUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
    expect(admitUrl("http://[::1]:5173/")).toBe("http://[::1]:5173/");
    expect(() => admitUrl("http://[::1]:43120/")).toThrow();
    expect(() => admitUrl("   ")).toThrow();
  });

  it("reduces a page-supplied filename to one safe segment", () => {
    expect(safeFilename("report.pdf")).toBe("report.pdf");
    expect(safeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFilename("a\u0000b\nc")).toBe("a_b_c");
    expect(safeFilename("   ")).toBe("download");
    expect(safeFilename("..")).toBe("download");
    expect(safeFilename("C:\\Windows\\x")).toBe("C__Windows_x");
    expect([...safeFilename("名".repeat(400))].length).toBeLessThanOrEqual(120);
  });

  it("clamps a viewport to something a browser can render", () => {
    const clamped = clampViewport({
      width: 10,
      height: 99_999,
      deviceScaleFactor: Number.NaN,
    });
    expect(clamped.width).toBe(MIN_VIEWPORT);
    expect(clamped.height).toBe(MAX_VIEWPORT);
    expect(clamped.deviceScaleFactor).toBe(1);
  });

  it("keeps the shared browser event discriminants", () => {
    // The five browser records and the activity line are contractual `type`
    // strings; a rename here would be a rename on every client at once.
    for (const type of [
      "browser.session",
      "browser.download",
      "browser.lease",
      "browser.tabs",
      "browser.dialog",
      "browser.fileChooser",
      "browser.activity",
    ]) {
      expect(WORKSPACE_EVENT_TYPES).toContain(type);
    }
  });
});

describe("per-request admission", () => {
  it("judges a document request on the address it would actually reach", () => {
    const policy = defaultNetworkPolicy();
    // The ordinary case: a name that resolves to a public address.
    expect(
      admitDocument("https://example.test/page", ["93.184.216.34"], policy),
    ).toEqual(ADMIT);
    // The same name, resolving to the address that hands out cloud
    // credentials. The URL says nothing about it, which is the point.
    expect(
      admitDocument("https://redirect.test/", ["169.254.169.254"], policy),
    ).toEqual(refuse("link_local_address"));
    // And when it is spelled out, it is refused by name before any lookup.
    expect(admitDocument("http://169.254.169.254/latest/", [], policy)).toEqual(
      refuse("metadata_address"),
    );
    expect(
      admitDocument("http://metadata.google.internal/", [], policy),
    ).toEqual(refuse("metadata_address"));
    // Armadra's own ports are not a browsing target, under any name.
    expect(admitDocument("http://127.0.0.1:43120/api", [], policy)).toEqual(
      refuse("reserved_port"),
    );
    expect(
      admitDocument("http://dev.test:43121/", ["127.0.0.1"], policy),
    ).toEqual(refuse("reserved_port"));
    // A name nobody can resolve is refused rather than admitted on the chance
    // that the browser resolves it to something harmless.
    expect(admitDocument("https://nowhere.test/", [], policy)).toEqual(
      refuse("unresolvable"),
    );
    // Not http(s) at all.
    expect(admitDocument("file:///etc/passwd", [], policy)).toEqual(
      refuse("scheme_not_allowed"),
    );
    // The project's own dev server on loopback is the whole reason the node
    // exists.
    expect(admitDocument("http://127.0.0.1:5173/", [], policy)).toEqual(ADMIT);
  });

  it("lets a workspace narrow which networks its browser may reach", () => {
    const open = defaultNetworkPolicy();
    expect(open.allowPrivateNetworks).toBe(true);
    expect(admitDocument("http://printer.lan/", ["192.168.1.4"], open)).toEqual(
      ADMIT,
    );

    const closed = { ...open, allowPrivateNetworks: false };
    expect(
      admitDocument("http://printer.lan/", ["192.168.1.4"], closed),
    ).toEqual(refuse("private_network"));
    expect(admitDocument("http://internal.test/", ["fd12::1"], closed)).toEqual(
      refuse("private_network"),
    );
    // Loopback is not "private network"; it is the dev server.
    expect(admitDocument("http://127.0.0.1:5173/", [], closed)).toEqual(ADMIT);

    const listed = {
      ...open,
      loopbackPorts: { kind: "listed", ports: [5173] },
    } as const;
    expect(admitDocument("http://127.0.0.1:5173/", [], listed)).toEqual(ADMIT);
    expect(admitDocument("http://127.0.0.1:9229/", [], listed)).toEqual(
      refuse("loopback_port_not_allowed"),
    );
    // A listed port still cannot be one of Armadra's own.
    expect(admitDocument("http://127.0.0.1:43120/", [], listed)).toEqual(
      refuse("reserved_port"),
    );
  });

  it("checks a sub-resource without a lookup", () => {
    expect(admitSubresource("http://169.254.169.254/latest/")).toEqual(
      refuse("metadata_address"),
    );
    expect(admitSubresource("http://127.0.0.1:43121/api")).toEqual(
      refuse("reserved_port"),
    );
    expect(admitSubresource("https://cdn.example.test/app.js")).toEqual(ADMIT);
    // A scheme the browser handles by itself is not this policy's business.
    expect(admitSubresource("data:image/png;base64,AAA")).toEqual(ADMIT);
  });

  it("knows the port a connection would use", () => {
    expect(parseTarget("https://example.test/a?b#c")).toEqual({
      scheme: "https",
      host: "example.test",
    });
    expect(effectivePort(parseTarget("https://example.test/")!)).toBe(443);
    expect(effectivePort(parseTarget("http://example.test/")!)).toBe(80);
    expect(parseTarget("http://[::1]:43120/")?.host).toBe("::1");
    expect(parseTarget("http://user:pw@example.test/")?.host).toBe(
      "example.test",
    );
    expect(parseTarget("file:///etc/passwd")).toBeUndefined();
    expect(parseTarget("not a url")).toBeUndefined();
  });
});
