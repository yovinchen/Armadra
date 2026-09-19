import { describe, expect, it } from "vitest";

import {
  MAX_VIEWPORT_WIDTH,
  fitFrame,
  modifierBits,
  parseServerMessage,
  reconnectDelay,
  toPageCoordinates,
  viewportFor,
} from "./stream";

/**
 * 画面流里值得测的都在这儿：几何和映射。组件只是把这些数字接到 canvas 和
 * socket 上。
 */

describe("一帧怎么放进节点的框里", () => {
  it("等比缩小并居中，多出来的是留白", () => {
    const fit = fitFrame(
      { width: 1_280, height: 800 },
      { width: 640, height: 600 },
    );
    expect(fit.scale).toBeCloseTo(0.5);
    expect(fit.drawWidth).toBeCloseTo(640);
    expect(fit.drawHeight).toBeCloseTo(400);
    expect(fit.offsetX).toBeCloseTo(0);
    expect(fit.offsetY).toBeCloseTo(100);
  });

  it("不放大：1280 宽的页面拉到 1600 只会糊", () => {
    const fit = fitFrame(
      { width: 800, height: 600 },
      { width: 1_600, height: 1_200 },
    );
    expect(fit.scale).toBe(1);
    expect(fit.offsetX).toBe(400);
  });

  it("空帧或空框不算出 NaN", () => {
    expect(
      fitFrame({ width: 0, height: 0 }, { width: 10, height: 10 }),
    ).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      drawWidth: 0,
      drawHeight: 0,
    });
  });
});

describe("一次点击落在页面的哪个像素", () => {
  const frame = { width: 1_280, height: 800 };
  const rect = { left: 100, top: 50, width: 640, height: 600 };

  it("减掉框的位置、减掉留白、再除掉缩放", () => {
    // 框里画面高 400、上下各留白 100：框坐标 (100+320, 50+100) 是画面左上角
    // 往右 320 → 页面坐标 (640, 0)。
    expect(
      toPageCoordinates({ clientX: 420, clientY: 150 }, rect, frame),
    ).toEqual({
      x: 640,
      y: 0,
    });
  });

  it("画面左上角就是页面原点", () => {
    expect(
      toPageCoordinates({ clientX: 100, clientY: 150 }, rect, frame),
    ).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("落在留白上的点被夹回页面里", () => {
    // 上方留白，以及框外左边：两个方向都夹住，而不是发一个负坐标让服务端拒绝。
    expect(toPageCoordinates({ clientX: 0, clientY: 60 }, rect, frame)).toEqual(
      {
        x: 0,
        y: 0,
      },
    );
    expect(
      toPageCoordinates({ clientX: 9_999, clientY: 9_999 }, rect, frame),
    ).toEqual({ x: 1_279, y: 799 });
  });

  it("缩放变了映射跟着变", () => {
    const small = { left: 0, top: 0, width: 320, height: 200 };
    expect(
      toPageCoordinates({ clientX: 160, clientY: 100 }, small, frame),
    ).toEqual({
      x: 640,
      y: 400,
    });
  });
});

describe("要服务端按多大渲染", () => {
  it("就是节点的框，夹在服务端同一组界内", () => {
    expect(viewportFor({ width: 1_000.4, height: 700.6 })).toEqual({
      width: 1_000,
      height: 701,
    });
    expect(viewportFor({ width: 10, height: 10 })).toEqual({
      width: 200,
      height: 200,
    });
    expect(viewportFor({ width: 99_999, height: 99_999 })).toEqual({
      width: MAX_VIEWPORT_WIDTH,
      height: 1_600,
    });
  });
});

describe("修饰键", () => {
  it("按 CDP 的位序，不是浏览器事件的顺序", () => {
    expect(modifierBits({})).toBe(0);
    expect(modifierBits({ altKey: true })).toBe(1);
    expect(modifierBits({ ctrlKey: true })).toBe(2);
    expect(modifierBits({ metaKey: true })).toBe(4);
    expect(modifierBits({ shiftKey: true })).toBe(8);
    expect(modifierBits({ ctrlKey: true, shiftKey: true })).toBe(10);
  });
});

describe("服务端的消息", () => {
  it("读得懂帧头、错误和招呼", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "frame",
          seq: 3,
          width: 800,
          height: 600,
          viewportWidth: 800,
          viewportHeight: 600,
          bytes: 12,
        }),
      ),
    ).toMatchObject({ type: "frame", seq: 3, width: 800 });
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "error",
          code: "browser_unavailable",
          message: "x",
        }),
      ),
    ).toMatchObject({ type: "error", code: "browser_unavailable" });
    expect(
      parseServerMessage(JSON.stringify({ type: "hello", nodeId: "n1" })),
    ).toMatchObject({ type: "hello", nodeId: "n1" });
  });

  it("认不出来的一律丢掉", () => {
    for (const raw of [
      "",
      "{",
      "[]",
      JSON.stringify({ type: "frame" }),
      JSON.stringify({ type: "javascript", code: "1" }),
    ]) {
      expect(parseServerMessage(raw), raw).toBeUndefined();
    }
  });
});

describe("重连", () => {
  it("翻倍到十秒封顶", () => {
    expect(reconnectDelay(0)).toBe(250);
    expect(reconnectDelay(1)).toBe(500);
    expect(reconnectDelay(5)).toBe(8_000);
    expect(reconnectDelay(99)).toBe(10_000);
  });
});
