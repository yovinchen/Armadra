import { describe, expect, it } from "vitest";

import {
  REVEAL_ZOOM_THRESHOLD,
  cameraForNewNode,
  fullyVisible,
  visibleBox,
} from "./reveal";

/**
 * 新建节点之后动不动相机。手动新建与 `node.created` 共用这套规则，所以
 * 这里既是「总览缩放下抬到 100%」的测试，也是「Agent 把节点建在屏幕外」
 * 的测试。
 */

const CONTAINER = { width: 1600, height: 1000 };
const NODE = { x: 1000, y: 400, width: 960, height: 600 };

describe("visibleBox", () => {
  it("按视口变换算出画布坐标下的可见矩形", () => {
    expect(visibleBox({ x: -200, y: -100, zoom: 2 }, CONTAINER)).toEqual({
      x: 100,
      y: 50,
      width: 800,
      height: 500,
    });
  });

  it("画布没挂载（容器量不出来）时没有可见矩形", () => {
    expect(visibleBox({ x: 0, y: 0, zoom: 1 }, { width: 0, height: 0 })).toBe(
      null,
    );
    expect(visibleBox({ x: 0, y: 0, zoom: 0 }, CONTAINER)).toBe(null);
  });
});

describe("fullyVisible", () => {
  const visible = { x: 0, y: 0, width: 1000, height: 1000 };

  it("整块落在里面才算看得见", () => {
    expect(
      fullyVisible({ x: 100, y: 100, width: 200, height: 200 }, visible),
    ).toBe(true);
    // 右边缘出去一点就不算：卡在边上和看不见差不多。
    expect(
      fullyVisible({ x: 900, y: 100, width: 200, height: 200 }, visible),
    ).toBe(false);
  });
});

describe("cameraForNewNode", () => {
  it("总览缩放下抬到 100% 并对准中心", () => {
    expect(
      cameraForNewNode({
        node: NODE,
        viewport: { x: 0, y: 0, zoom: 0.27 },
        container: CONTAINER,
      }),
    ).toEqual({ x: 1480, y: 700, zoom: 1 });
  });

  it("节点已经整块在眼前时一动不动", () => {
    // 视口正好框住节点周围一大片。
    expect(
      cameraForNewNode({
        node: { x: 200, y: 200, width: 400, height: 300 },
        viewport: { x: 0, y: 0, zoom: 1 },
        container: CONTAINER,
      }),
    ).toBe(null);
  });

  it("节点在屏幕外时按当前缩放居中，不改缩放", () => {
    // Agent 建的节点摆在发起它的节点右边，常常整块都在屏幕外。
    const target = cameraForNewNode({
      node: { x: 4000, y: 400, width: 960, height: 600 },
      viewport: { x: 0, y: 0, zoom: 1 },
      container: CONTAINER,
    });
    expect(target).toEqual({ x: 4480, y: 700, zoom: 1 });
  });

  it("量不到容器时只剩「缩放太小就抬」这一条", () => {
    const none = { width: 0, height: 0 };
    expect(
      cameraForNewNode({
        node: NODE,
        viewport: { x: 0, y: 0, zoom: REVEAL_ZOOM_THRESHOLD },
        container: none,
      }),
    ).toBe(null);
    expect(
      cameraForNewNode({
        node: NODE,
        viewport: { x: 0, y: 0, zoom: 0.2 },
        container: none,
      }),
    ).toMatchObject({ zoom: 1 });
  });

  it("还没量过的节点（宽高为 0）一律不动相机", () => {
    expect(
      cameraForNewNode({
        node: { x: 0, y: 0, width: 0, height: 0 },
        viewport: { x: 0, y: 0, zoom: 0.2 },
        container: CONTAINER,
      }),
    ).toBe(null);
  });
});
