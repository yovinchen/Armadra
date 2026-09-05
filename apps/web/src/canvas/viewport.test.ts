import { describe, expect, it } from "vitest";

import {
  INITIAL_VIEWPORT_MARGIN,
  initialViewportFor,
  isDefaultViewport,
} from "./viewport";

describe("initialViewportFor", () => {
  it("空画布回到默认视口", () => {
    expect(initialViewportFor([])).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("单个节点：左上角落在 40px 边距上，缩放恒为 1", () => {
    expect(
      initialViewportFor([{ x: 120, y: 80, width: 640, height: 440 }]),
    ).toEqual({
      x: INITIAL_VIEWPORT_MARGIN - 120,
      y: INITIAL_VIEWPORT_MARGIN - 80,
      zoom: 1,
    });
  });

  it("多个节点：取包围盒左上角，不因节点多而缩小", () => {
    const viewport = initialViewportFor([
      { x: 300, y: 500, width: 640, height: 440 },
      { x: 120, y: 900, width: 900, height: 620 },
      { x: 2400, y: 260, width: 700, height: 480 },
    ]);
    expect(viewport).toEqual({ x: 40 - 120, y: 40 - 260, zoom: 1 });
  });

  it("负坐标：视口把内容推回可视区", () => {
    expect(
      initialViewportFor([
        { x: -800, y: -1200, width: 640, height: 440 },
        { x: -200, y: 300, width: 240, height: 200 },
      ]),
    ).toEqual({ x: 840, y: 1240, zoom: 1 });
  });

  it("组员坐标是相对父组框的，不参与包围盒", () => {
    const viewport = initialViewportFor([
      { x: 600, y: 600, width: 520, height: 360 },
      { x: 20, y: 20, width: 240, height: 200, parentId: "group-1" },
    ]);
    expect(viewport).toEqual({ x: 40 - 600, y: 40 - 600, zoom: 1 });
    // 全是组员时没有可用包围盒。
    expect(initialViewportFor([{ x: 20, y: 20, parentId: "group-1" }])).toEqual(
      { x: 0, y: 0, zoom: 1 },
    );
  });

  it("自定义边距", () => {
    expect(initialViewportFor([{ x: 100, y: 100 }], 0)).toEqual({
      x: -100,
      y: -100,
      zoom: 1,
    });
  });
});

describe("isDefaultViewport", () => {
  it("缺失或 {0,0,1} 视为没存过", () => {
    expect(isDefaultViewport(undefined)).toBe(true);
    expect(isDefaultViewport(null)).toBe(true);
    expect(isDefaultViewport({ x: 0, y: 0, zoom: 1 })).toBe(true);
  });

  it("存过的视口原样保留", () => {
    expect(isDefaultViewport({ x: 0, y: 0, zoom: 0.7 })).toBe(false);
    expect(isDefaultViewport({ x: -120, y: 40, zoom: 1 })).toBe(false);
  });
});
