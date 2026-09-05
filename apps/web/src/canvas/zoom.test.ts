import { describe, expect, it } from "vitest";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  clampZoom,
  wheelBelongsToCanvas,
  wheelZoomFactor,
  zoomAroundCentre,
  zoomAroundPoint,
} from "./zoom";

describe("缩放范围", () => {
  it("是 §21 的 0.1–3", () => {
    expect([MIN_ZOOM, MAX_ZOOM]).toEqual([0.1, 3]);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe("wheelZoomFactor", () => {
  it("上滚放大、下滚缩小", () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it("鼠标滚轮一格（deltaY 100）不会一步跳到 2.7 倍", () => {
    expect(wheelZoomFactor(-100)).toBeCloseTo(Math.exp(0.4), 10);
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 12);
  });

  it("反向滚回来能回到原来的缩放（指数而不是线性）", () => {
    const round = wheelZoomFactor(-24) * wheelZoomFactor(24);
    expect(round).toBeCloseTo(1, 12);
  });
});

describe("zoomAroundPoint", () => {
  it("光标下的那一点在缩放前后不动", () => {
    const viewport = { x: -120, y: 40, zoom: 1 };
    const cursor = { x: 300, y: 200 };
    const before = {
      x: (cursor.x - viewport.x) / viewport.zoom,
      y: (cursor.y - viewport.y) / viewport.zoom,
    };
    const next = zoomAroundPoint(viewport, 2, cursor);
    expect(next.zoom).toBe(2);
    expect((cursor.x - next.x) / next.zoom).toBeCloseTo(before.x, 10);
    expect((cursor.y - next.y) / next.zoom).toBeCloseTo(before.y, 10);
  });

  it("超出范围时先夹再算，画面不会继续飘", () => {
    const viewport = { x: 0, y: 0, zoom: 3 };
    const next = zoomAroundPoint(viewport, 12, { x: 100, y: 100 });
    expect(next.zoom).toBe(MAX_ZOOM);
    expect(next).toEqual(viewport);
  });
});

describe("zoomAroundCentre", () => {
  it("⌘0 回到 100% 时保持画面中心", () => {
    const viewport = { x: -200, y: -100, zoom: ZOOM_STEP };
    const size = { width: 1440, height: 900 };
    const centre = {
      x: (size.width / 2 - viewport.x) / viewport.zoom,
      y: (size.height / 2 - viewport.y) / viewport.zoom,
    };
    const next = zoomAroundCentre(viewport, 1, size);
    expect(next.zoom).toBe(1);
    expect(size.width / 2 - next.x).toBeCloseTo(centre.x, 10);
    expect(size.height / 2 - next.y).toBeCloseTo(centre.y, 10);
  });
});

describe("wheelBelongsToCanvas", () => {
  it("终端体与浏览器节点里的滚轮不归画布", () => {
    const body = document.createElement("div");
    body.className = "nowheel";
    const inner = document.createElement("span");
    body.append(inner);
    expect(wheelBelongsToCanvas(inner)).toBe(false);
    expect(wheelBelongsToCanvas(document.createElement("div"))).toBe(true);
    expect(wheelBelongsToCanvas(null)).toBe(true);
  });
});
