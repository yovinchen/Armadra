import { describe, expect, it } from "vitest";

import {
  fitPageBounds,
  itemAtPoint,
  minimapFillAlpha,
  minimapPointToPage,
  minimapStroke,
  minimapStrokeWidth,
  minimapZoom,
  rectCenter,
  unionRect,
  type MinimapItem,
  type MinimapPalette,
} from "./minimap";

/** 真正的取值来自 `tokens.css`；这里只要能区分开就行。 */
const PALETTE: MinimapPalette = {
  working: "#d97757",
  attention: "#ff453a",
  unread: "#0a84ff",
  shape: "#8a8a8a",
  viewport: "rgb(255 255 255 / 12%)",
  viewportStroke: "#8a8a8a",
  background: "#202020",
};

const NODE_COLOR = "#32d74b";

describe("minimap status stroke", () => {
  it("maps the three agent glows to their tokens", () => {
    expect(minimapStroke({ glow: "working", color: NODE_COLOR }, PALETTE)).toBe(
      PALETTE.working,
    );
    expect(
      minimapStroke({ glow: "attention", color: NODE_COLOR }, PALETTE),
    ).toBe(PALETTE.attention);
    expect(minimapStroke({ glow: "unread", color: NODE_COLOR }, PALETTE)).toBe(
      PALETTE.unread,
    );
  });

  it("falls back to the node colour, then to the shape colour", () => {
    expect(minimapStroke({ color: NODE_COLOR }, PALETTE)).toBe(NODE_COLOR);
    expect(minimapStroke({}, PALETTE)).toBe(PALETTE.shape);
  });

  it("never paints whiteboard shapes with a status colour", () => {
    expect(
      minimapStroke({ plain: true, glow: "working", color: NODE_COLOR }, PALETTE),
    ).toBe(PALETTE.shape);
  });

  it("draws a thicker stroke when there is a status", () => {
    expect(minimapStrokeWidth({ glow: "working" })).toBe(2);
    expect(minimapStrokeWidth({})).toBe(1);
  });

  it("fills the selected node more solidly than the rest", () => {
    expect(minimapFillAlpha({ selected: true })).toBeGreaterThan(
      minimapFillAlpha({}),
    );
    expect(minimapFillAlpha({ plain: true })).toBeGreaterThan(
      minimapFillAlpha({}),
    );
  });
});

describe("minimap geometry", () => {
  it("expands the content box to the canvas aspect ratio without cropping", () => {
    const view = fitPageBounds({ x: 0, y: 0, width: 400, height: 400 }, 2);
    // 4:3 的内容塞进 2:1 的框：高度不变，宽度补齐，中心不动。
    expect(view).toEqual({ x: -200, y: 0, width: 800, height: 400 });
    expect(rectCenter(view)).toEqual({ x: 200, y: 200 });
  });

  it("keeps the taller axis when the content is narrow", () => {
    const view = fitPageBounds({ x: 0, y: 0, width: 100, height: 900 }, 4 / 3);
    expect(view.height).toBe(900);
    expect(view.width).toBe(1200);
    expect(rectCenter(view)).toEqual({ x: 50, y: 450 });
  });

  it("survives an empty canvas without dividing by zero", () => {
    const view = fitPageBounds({ x: 0, y: 0, width: 0, height: 0 }, 0);
    expect(Number.isFinite(view.width)).toBe(true);
    expect(view.width).toBeGreaterThan(0);
    expect(minimapZoom({ x: 0, y: 0, width: 0, height: 0 }, 200)).toBe(1);
  });

  it("unions the content box with the viewport", () => {
    expect(
      unionRect(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 50, y: -50, width: 100, height: 100 },
      ),
    ).toEqual({ x: 0, y: -50, width: 150, height: 150 });
    expect(unionRect(undefined, { x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(unionRect(undefined, undefined)).toBeUndefined();
  });

  it("turns a click in the 200×150 minimap into a page point", () => {
    const view = { x: -100, y: -50, width: 800, height: 600 };
    const canvas = { width: 200, height: 150 };
    expect(minimapPointToPage({ x: 0, y: 0 }, view, canvas)).toEqual({
      x: -100,
      y: -50,
    });
    expect(minimapPointToPage({ x: 100, y: 75 }, view, canvas)).toEqual({
      x: 300,
      y: 250,
    });
    expect(minimapPointToPage({ x: 200, y: 150 }, view, canvas)).toEqual({
      x: 700,
      y: 550,
    });
  });
});

describe("minimap hit testing", () => {
  const items: MinimapItem[] = [
    { id: "board", rect: { x: 0, y: 0, width: 500, height: 500 }, plain: true },
    { id: "a", rect: { x: 0, y: 0, width: 100, height: 60 } },
    { id: "b", rect: { x: 40, y: 20, width: 100, height: 60 } },
  ];

  it("returns the topmost node under the point", () => {
    // a 与 b 重叠的那块：后画的 b 在上面。
    expect(itemAtPoint({ x: 50, y: 30 }, items)?.id).toBe("b");
    expect(itemAtPoint({ x: 10, y: 10 }, items)?.id).toBe("a");
  });

  it("ignores whiteboard shapes and empty space", () => {
    // 只落在白板 shape 上：不算命中，点击退回「把相机搬到这个点」。
    expect(itemAtPoint({ x: 300, y: 300 }, items)).toBeUndefined();
    expect(itemAtPoint({ x: 900, y: 900 }, items)).toBeUndefined();
  });

  it("centres on the node box, not on the click", () => {
    const hit = itemAtPoint({ x: 10, y: 10 }, items);
    expect(hit && rectCenter(hit.rect)).toEqual({ x: 50, y: 30 });
  });
});
