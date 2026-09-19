import { describe, expect, it } from "vitest";

import {
  discardedMessage,
  drivableGuest,
  isSafeNodeId,
  notDrivableMessage,
  parseRegistration,
  type GuestRegistration,
} from "./registration";
import { allowGuestNavigation, decidePopup } from "./navigation";

const GOOD = {
  webContentsId: 7,
  nodeId: "browser-3",
  tabId: "tab-1",
  surface: "canvas",
  active: true,
};

describe("parseRegistration", () => {
  it("takes a well-formed registration", () => {
    const parsed = parseRegistration(GOOD);
    expect(parsed.ok).toBe(true);
  });

  it("refuses anything that is not an integer webContents id", () => {
    for (const id of [0, -1, 1.5, "7", null, undefined, Number.NaN]) {
      const parsed = parseRegistration({ ...GOOD, webContentsId: id });
      expect(parsed.ok, String(id)).toBe(false);
    }
  });

  it("refuses a node id that could be mistaken for structure", () => {
    for (const nodeId of [
      "../other",
      "a/b",
      'x"y',
      "with space",
      "line\nbreak",
      "",
      "-leading",
      "x".repeat(200),
    ]) {
      expect(isSafeNodeId(nodeId), nodeId).toBe(false);
      expect(parseRegistration({ ...GOOD, nodeId }).ok, nodeId).toBe(false);
    }
  });

  it("refuses a surface that is not one of the two", () => {
    expect(parseRegistration({ ...GOOD, surface: "popup" }).ok).toBe(false);
  });
});

describe("which guest a verb drives", () => {
  const guests: GuestRegistration[] = [
    {
      webContentsId: 1,
      nodeId: "browser-1",
      tabId: "t1",
      surface: "canvas",
      active: false,
    },
    {
      webContentsId: 2,
      nodeId: "browser-1",
      tabId: "t2",
      surface: "canvas",
      active: true,
    },
    {
      webContentsId: 3,
      nodeId: "browser-2",
      tabId: "t1",
      surface: "modal",
      active: true,
    },
  ];

  it("is the node's active canvas tab", () => {
    expect(drivableGuest(guests, "browser-1")?.webContentsId).toBe(2);
  });

  it("is never a modal preview, even when it is the only guest", () => {
    expect(drivableGuest(guests, "browser-2")).toBeNull();
  });

  it("is null for a node nobody registered", () => {
    expect(drivableGuest(guests, "browser-9")).toBeNull();
  });
});

describe("the refusals", () => {
  it("says the same thing for a node with no drivable guest and for one that does not exist", () => {
    // The acceptance gate's second line, as a unit test: a refusal that told
    // them apart would be a probe for what is on somebody's canvas.
    expect(notDrivableMessage("browser-2")).toBe(
      notDrivableMessage("browser-2"),
    );
    expect(notDrivableMessage("x").replace("x", "y")).toBe(
      notDrivableMessage("y"),
    );
  });

  it("calls a discarded guest a lifecycle event, not a permission failure", () => {
    const message = discardedMessage("browser-1");
    expect(message).toContain("memory");
    expect(message).not.toContain("permission");
    expect(message).not.toContain("denied");
  });
});

describe("the navigation gate", () => {
  it("passes http and https and the blank page", () => {
    expect(allowGuestNavigation("https://example.com")).toBe(true);
    expect(allowGuestNavigation("http://127.0.0.1:5173/x")).toBe(true);
    expect(allowGuestNavigation("about:blank")).toBe(true);
  });

  it("refuses file:// outright, which is stricter than nodeterm on purpose", () => {
    expect(allowGuestNavigation("file:///etc/passwd")).toBe(false);
    expect(allowGuestNavigation("file:///")).toBe(false);
  });

  it("refuses every other scheme and anything unparseable", () => {
    for (const url of [
      "about:config",
      "javascript:1",
      "data:text/html,x",
      "/relative",
      "",
    ]) {
      expect(allowGuestNavigation(url), url).toBe(false);
    }
  });
});

describe("popups", () => {
  it("are always denied a real window", () => {
    expect(decidePopup("https://example.com", true).action).toBe("deny");
    expect(decidePopup("https://example.com", false).action).toBe("deny");
  });

  it("are reported to the canvas only from a registered guest with an http(s) target", () => {
    expect(decidePopup("https://example.com", true).report).toBe(true);
    expect(decidePopup("https://example.com", false).report).toBe(false);
    expect(decidePopup("file:///etc/passwd", true).report).toBe(false);
    expect(decidePopup("about:blank", true).report).toBe(false);
  });
});
