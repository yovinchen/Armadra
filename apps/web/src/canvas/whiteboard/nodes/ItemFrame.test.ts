import { describe, expect, it } from "vitest";

import { MIN_ITEM_SIZE, resizedBox } from "./ItemFrame";

/**
 * resize 的算法（React Flow 计划 F23 / F26）。
 *
 * 只认 `NodeResizer` 报的**增量**：受控画布里 React Flow 的 `measured`
 * 常常是空的，起始尺寸会被当成 0，直接用它报的绝对宽高会让对象一拖就缩成
 * 一小块（浏览器里复现过）。这份测试把「起始尺寸是 0」当成正常输入。
 */

const box = { x: 100, y: 50, w: 200, h: 120 };

/** React Flow 起始尺寸正常时报的一组参数。 */
function sane(width: number, height: number, x = 100, y = 50) {
  return { x, y, width, height };
}

/** `measured` 空时报的一组参数：起始宽高是 0，之后就是纯位移。 */
function blind(width: number, height: number, x = 100, y = 50) {
  return { x, y, width, height };
}

describe("resizedBox", () => {
  it("右下角：只改宽高，左上角不动", () => {
    const start = { box, params: sane(200, 120) };
    expect(resizedBox(start, sane(260, 160), false)).toEqual({
      x: 100,
      y: 50,
      w: 260,
      h: 160,
    });
  });

  it("起始尺寸是 0 时结果一样：认的是增量不是绝对值", () => {
    const start = { box, params: blind(0, 0) };
    expect(resizedBox(start, blind(60, 40), false)).toEqual({
      x: 100,
      y: 50,
      w: 260,
      h: 160,
    });
  });

  it("左上角：宽高反向变，右下角钉住不动", () => {
    const start = { box, params: blind(0, 0, 100, 50) };
    // 往右下拖左上角 → 变小，x/y 跟着走
    const result = resizedBox(start, blind(-40, -30, 140, 80), false);
    expect(result).toEqual({ x: 140, y: 80, w: 160, h: 90 });
    expect(result.x + result.w).toBe(box.x + box.w);
    expect(result.y + result.h).toBe(box.y + box.h);
  });

  it("只调宽的对象（文字）高度一个像素都不动", () => {
    const start = { box, params: blind(0, 0) };
    expect(resizedBox(start, blind(50, 999), true)).toMatchObject({
      w: 250,
      h: 120,
    });
  });

  it("下限自己把：拖过头也不会变成负数", () => {
    const start = { box, params: blind(0, 0) };
    expect(resizedBox(start, blind(-500, -500), false)).toMatchObject({
      w: MIN_ITEM_SIZE,
      h: MIN_ITEM_SIZE,
    });
  });

  it("没动就是没动", () => {
    const start = { box, params: blind(0, 0) };
    expect(resizedBox(start, blind(0, 0), false)).toEqual(box);
  });
});
