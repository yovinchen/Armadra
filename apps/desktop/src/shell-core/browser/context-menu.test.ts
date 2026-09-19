import { describe, expect, it } from "vitest";

import { guestContextMenu, inspectElementPoint } from "./context-menu";

/**
 * The zoom test the probe asked for by name (webview-probe末节 §6).
 *
 * The numbers are the probe's own: a `<webview>` whose host rect starts at
 * (20, 20), a guest viewport of 520 x 332, and a right-click in the middle of
 * it. At zoom 1 the host point and the guest point differ only by the rect
 * origin; at 0.5 and 2 they differ by the scale as well, which is exactly the
 * error a naive `inspectElement(params.x, params.y)` makes.
 */
describe("inspectElement coordinates", () => {
  const rect = { x: 20, y: 20 };
  const guestCentre = { x: 260, y: 166 };

  it("is the identity minus the rect origin at zoom 1", () => {
    const host = { x: rect.x + guestCentre.x, y: rect.y + guestCentre.y };
    expect(inspectElementPoint(host, rect, 1)).toEqual(guestCentre);
  });

  it("divides by the canvas zoom when the canvas is scaled down", () => {
    const host = {
      x: rect.x + guestCentre.x * 0.5,
      y: rect.y + guestCentre.y * 0.5,
    };
    expect(inspectElementPoint(host, rect, 0.5)).toEqual(guestCentre);
  });

  it("divides by the canvas zoom when the canvas is scaled up", () => {
    const host = {
      x: rect.x + guestCentre.x * 2,
      y: rect.y + guestCentre.y * 2,
    };
    expect(inspectElementPoint(host, rect, 2)).toEqual(guestCentre);
  });

  it("shows the error the conversion exists to prevent, and that it grows with zoom", () => {
    // Passing `params.x/y` straight to `inspectElement` is off by an amount
    // that scales with the canvas — the probe measured -109 / +21 / +282 px
    // horizontally at zooms 0.5 / 1 / 2. The sign flips and the magnitude
    // grows, so there is no constant offset that would paper over it.
    const raw = (zoom: number) => ({
      x: rect.x + guestCentre.x * zoom - guestCentre.x,
      y: rect.y + guestCentre.y * zoom - guestCentre.y,
    });
    expect(raw(1).x).toBe(rect.x);
    expect(raw(0.5).x).toBeLessThan(0);
    expect(raw(2).x).toBeGreaterThan(200);
    expect(Math.abs(raw(2).x)).toBeGreaterThan(Math.abs(raw(1).x));
  });

  it("falls back to an unscaled conversion rather than dividing by zero", () => {
    expect(inspectElementPoint({ x: 30, y: 40 }, rect, 0)).toEqual({
      x: 10,
      y: 20,
    });
    expect(inspectElementPoint({ x: 30, y: 40 }, rect, Number.NaN)).toEqual({
      x: 10,
      y: 20,
    });
  });
});

describe("the menu template", () => {
  const base = {
    isEditable: false,
    selectionText: "",
    linkURL: "",
    editFlags: {},
    developerTools: true,
  };

  it("offers editing roles only in an editable field", () => {
    const editable = guestContextMenu({
      ...base,
      isEditable: true,
      editFlags: { canCut: true },
    });
    expect(editable.map((item) => item.role)).toContain("cut");
    expect(guestContextMenu(base).map((item) => item.role)).not.toContain(
      "cut",
    );
  });

  it("offers copy for a selection", () => {
    const menu = guestContextMenu({
      ...base,
      selectionText: "hello",
      editFlags: { canCopy: true },
    });
    expect(menu.some((item) => item.role === "copy")).toBe(true);
  });

  it("offers the link items only when there is a link", () => {
    const menu = guestContextMenu({ ...base, linkURL: "https://example.com" });
    expect(menu.map((item) => item.id)).toContain("copyLink");
    expect(guestContextMenu(base).map((item) => item.id)).not.toContain(
      "copyLink",
    );
  });

  it("puts DevTools behind exactly one entry, and drops it when the build has none", () => {
    const ids = guestContextMenu(base).map((item) => item.id);
    expect(ids.filter((id) => id === "inspectElement")).toHaveLength(1);
    const without = guestContextMenu({ ...base, developerTools: false });
    expect(without.map((item) => item.id)).not.toContain("inspectElement");
  });
});
