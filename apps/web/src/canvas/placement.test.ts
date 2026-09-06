import { describe, expect, it, vi } from "vitest";
import type { Box } from "./geometry";

/**
 * 新建节点的落点（画布平台设计 §3.2）。
 *
 * 三件事：以锚点**居中**、压住别人就按 32px 让开、让不进视口就退回居中。
 *
 * `placement.ts` 里的 `nodeDropPosition` 会经 `store/defaults` 把整棵节点
 * 渲染树拉进来，所以按 `add-menu.test` 的做法给 `nodes/registry` 一份最小
 * 替身；这里断言的是纯几何那三个函数。
 */
vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "node.terminal",
    icon: null,
    defaultSize: { width: 240, height: 200 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#5B5BD6",
    hasBridgeHandles: false,
  };
  return {
    NODE_META: new Proxy({} as Record<string, typeof meta>, {
      get: () => meta,
      has: () => true,
    }),
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const { CASCADE_STEP, centeredAt, placeNode } = await import("./placement");

const size = { width: 640, height: 440 };
const anchor = { x: 500, y: 400 };
const centre = { x: 180, y: 180 };

function boxAt(position: { x: number; y: number }): Box {
  return { ...position, ...size };
}

describe("centeredAt", () => {
  it("锚点是中心，不是左上角", () => {
    expect(centeredAt(anchor, size)).toEqual(centre);
  });

  it("半像素取整，节点不落在小数坐标上", () => {
    expect(centeredAt({ x: 0, y: 0 }, { width: 241, height: 201 })).toEqual({
      x: -120,
      y: -100,
    });
  });
});

describe("placeNode", () => {
  it("空画布上就落在居中的位置", () => {
    expect(placeNode(anchor, size, [])).toEqual(centre);
  });

  /** 让到第一个**完全**不重叠的位置：640×440 要让 14 步（448px）。 */
  const clearOffset = Math.ceil(size.height / CASCADE_STEP) * CASCADE_STEP;

  it("压住已有节点时让到第一个不重叠的位置", () => {
    expect(placeNode(anchor, size, [boxAt(centre)])).toEqual({
      x: centre.x + clearOffset,
      y: centre.y + clearOffset,
    });
  });

  it("连着建三个：三张卡片互不重叠，也不叠在同一点上", () => {
    const taken: Box[] = [];
    const placed = [0, 1, 2].map(() => {
      const position = placeNode(anchor, size, taken);
      taken.push(boxAt(position));
      return position;
    });
    // 第一张在正中，第二张让到最近的空位（右下 448px）。
    expect(placed[0]).toEqual(centre);
    expect(placed[1]).toEqual({
      x: centre.x + clearOffset,
      y: centre.y + clearOffset,
    });
    // 三张两两不重叠——这就是「互相盖住」被修好的判据。
    for (const [i, a] of taken.entries()) {
      for (const b of taken.slice(i + 1)) {
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });

  /**
   * 视口只装得下一个节点时没有「不重叠」的候选，这时按 32px 错开而不是
   * 精确叠在一起——两张卡片的标题栏都还抓得住。
   */
  it("视口挤不下第二个时按 32px 错开，不精确重合", () => {
    const tight = {
      x: centre.x - 40,
      y: centre.y - 40,
      width: 720,
      height: 520,
    };
    expect(placeNode(anchor, size, [boxAt(centre)], tight)).toEqual({
      x: centre.x + CASCADE_STEP,
      y: centre.y + CASCADE_STEP,
    });
  });

  it("只擦着边不算压住（矩形相邻可以并排）", () => {
    const neighbour = boxAt({ x: centre.x + size.width, y: centre.y });
    expect(placeNode(anchor, size, [neighbour])).toEqual(centre);
  });

  it("组员不参与避让由调用方筛，这里给什么算什么", () => {
    expect(placeNode(anchor, size, [boxAt({ x: 5000, y: 5000 })])).toEqual(
      centre,
    );
  });

  const visible = { x: 0, y: 0, width: 900, height: 700 };

  it("右下让不下时往左上让", () => {
    // 视口右下只留 32px，往右下第一步就出界，于是只剩左上那一侧。
    const tight = {
      x: centre.x - 200,
      y: centre.y - 200,
      width: size.width + 220,
      height: size.height + 220,
    };
    expect(placeNode(anchor, size, [boxAt(centre)], tight)).toEqual({
      x: centre.x - CASCADE_STEP,
      y: centre.y - CASCADE_STEP,
    });
  });

  it("两个方向都出视口时退回居中的落点，不把节点甩到屏幕外", () => {
    // 视口刚好装得下一个节点，任何一步级联都会越界。
    const exact = { x: centre.x, y: centre.y, ...size };
    expect(placeNode(anchor, size, [boxAt(centre)], exact)).toEqual(centre);
  });

  it("节点比视口还大时照样居中，不因为装不下就不放", () => {
    const huge = { width: 2000, height: 1600 };
    expect(placeNode(anchor, huge, [], visible)).toEqual(
      centeredAt(anchor, huge),
    );
  });
});
