import { describe, expect, it } from "vitest";

import { makeItem } from "../test-support";
import { MAX_RASTER_EDGE, planRaster, RasterError } from "./raster";

/**
 * 栅格化（React Flow 计划 §2.4；B5 的内容引用靠它出 PNG）。
 *
 * jsdom 没有 canvas（`getContext` 未实现），所以这里只覆盖**输入校验与
 * 导出计划**那一半——真正的像素在浏览器里核对（§6.3 A06 / A09）。计划
 * 本身是纯函数，恰好也是最容易出错的那一半：空选区、退化包围盒、超大
 * 画布三条都会在这里被拦下。
 */

describe("planRaster", () => {
  it("包围盒四周按 padding 外扩，密度默认 2", () => {
    const plan = planRaster(
      [makeItem("shape", { x: 100, y: 50, w: 200, h: 100 })],
      { padding: 10 },
    );
    expect(plan).toMatchObject({ x: 90, y: 40, w: 220, h: 120, scale: 2 });
    expect(plan.pixelWidth).toBe(440);
    expect(plan.pixelHeight).toBe(240);
  });

  it("多条对象一起算一个盒子", () => {
    const plan = planRaster(
      [
        makeItem("shape", { x: 0, y: 0, w: 100, h: 100 }),
        makeItem("shape", { x: 300, y: 200, w: 100, h: 100 }),
      ],
      { padding: 0 },
    );
    expect(plan).toMatchObject({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("超大白板降密度而不是裁掉：导出的仍是完整的一张", () => {
    const plan = planRaster(
      [makeItem("shape", { x: 0, y: 0, w: 10_000, h: 500 })],
      { padding: 0, scale: 2 },
    );
    expect(plan.scale).toBeLessThan(2);
    expect(plan.pixelWidth).toBeLessThanOrEqual(MAX_RASTER_EDGE);
    // 宽高比不变才叫「完整的一张」。
    expect(plan.pixelWidth / plan.pixelHeight).toBeCloseTo(10_000 / 500, 1);
  });

  it("空选区拒绝", () => {
    expect(() => planRaster([])).toThrow(RasterError);
  });

  it("退化的包围盒拒绝（0×0 的对象、padding 为 0）", () => {
    expect(() =>
      planRaster([makeItem("shape", { w: 0, h: 0 })], { padding: 0 }),
    ).toThrow(RasterError);
  });

  it("密度不合法时拒绝，不悄悄换一个值", () => {
    const items = [makeItem("shape")];
    expect(() => planRaster(items, { scale: 0 })).toThrow(RasterError);
    expect(() => planRaster(items, { scale: -1 })).toThrow(RasterError);
    expect(() => planRaster(items, { scale: Number.NaN })).toThrow(RasterError);
  });

  it("位图尺寸至少 1 像素（极小的对象也要出一张图）", () => {
    const plan = planRaster([makeItem("shape", { w: 0.1, h: 0.1 })], {
      padding: 0,
      scale: 0.01,
    });
    expect(plan.pixelWidth).toBeGreaterThanOrEqual(1);
    expect(plan.pixelHeight).toBeGreaterThanOrEqual(1);
  });
});
