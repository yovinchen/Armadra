import { describe, expect, it, vi } from "vitest";

/** 只为了拿默认尺寸；节点体（xterm / CodeMirror）不该被拉进纯几何单测。 */
const nodeMetaStub = {
  labelKey: "node.sticky",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import {
  anchorPoint,
  boundingBox,
  containsPoint,
  edgeGeometry,
  facingSides,
  hitTestGroup,
  nearestInDirection,
  type Box,
} from "./geometry";

const box = (x: number, y: number, width = 100, height = 60): Box => ({
  x,
  y,
  width,
  height,
});

describe("facingSides", () => {
  it("横向锚只走左右两侧", () => {
    // 目标在正下方，但 anchor=horizontal 依然贴左右边
    expect(facingSides(box(0, 0), box(0, 400), "horizontal")).toEqual({
      source: "right",
      target: "left",
    });
  });

  it("目标在左边时两端互换", () => {
    expect(facingSides(box(500, 0), box(0, 0))).toEqual({
      source: "left",
      target: "right",
    });
  });

  it("自由锚在纵向差更大时走上下", () => {
    expect(facingSides(box(0, 0), box(10, 400), "free")).toEqual({
      source: "bottom",
      target: "top",
    });
  });
});

describe("anchorPoint / edgeGeometry", () => {
  it("锚点落在对应边的中点", () => {
    expect(anchorPoint(box(0, 0, 100, 60), "right")).toEqual({ x: 100, y: 30 });
    expect(anchorPoint(box(0, 0, 100, 60), "top")).toEqual({ x: 50, y: 0 });
  });

  it("两端坐标就是相对边的中点", () => {
    const geometry = edgeGeometry(box(0, 0, 100, 60), box(300, 0, 100, 60));
    expect(geometry).toMatchObject({
      sourceX: 100,
      sourceY: 30,
      targetX: 300,
      targetY: 30,
      sourceSide: "right",
      targetSide: "left",
    });
  });
});

describe("hitTestGroup", () => {
  const groups = [
    { id: "big", box: box(0, 0, 600, 400) },
    { id: "small", box: box(100, 100, 200, 150) },
  ];

  it("命中面积最小的那个组", () => {
    expect(hitTestGroup(groups, { x: 150, y: 150 })).toBe("small");
  });

  it("只落在大组里时返回大组", () => {
    expect(hitTestGroup(groups, { x: 500, y: 350 })).toBe("big");
  });

  it("组外返回 null", () => {
    expect(hitTestGroup(groups, { x: 900, y: 900 })).toBeNull();
  });

  it("排除自身（拖动组本身时不会落进自己）", () => {
    expect(hitTestGroup(groups, { x: 150, y: 150 }, ["small"])).toBe("big");
  });

  it("边界点算命中", () => {
    expect(containsPoint(box(0, 0, 100, 60), { x: 100, y: 60 })).toBe(true);
  });
});

describe("nearestInDirection", () => {
  const boxes = [
    { id: "center", box: box(0, 0) },
    { id: "right-near", box: box(200, 0) },
    { id: "right-far", box: box(600, 0) },
    { id: "right-diagonal", box: box(150, 140) },
    { id: "above", box: box(0, -300) },
  ];

  it("取正对面最近的那个", () => {
    expect(nearestInDirection(boxes, "center", "right")).toBe("right-near");
  });

  it("向上只看上方", () => {
    expect(nearestInDirection(boxes, "center", "up")).toBe("above");
  });

  it("没有候选时返回 null", () => {
    expect(nearestInDirection(boxes, "center", "left")).toBeNull();
  });

  it("锥形之外的斜向节点不算这个方向", () => {
    const positions = [
      { id: "center", box: box(0, 0) },
      // dx=40 dy=400：偏移远大于主轴距离，落在 45° 锥形外
      { id: "steep", box: box(40, 400) },
    ];
    expect(nearestInDirection(positions, "center", "right")).toBeNull();
    expect(nearestInDirection(positions, "center", "down")).toBe("steep");
  });

  it("未知起点返回 null", () => {
    expect(nearestInDirection(boxes, "ghost", "right")).toBeNull();
  });
});

describe("boundingBox", () => {
  it("空集合返回 null", () => {
    expect(boundingBox([])).toBeNull();
  });

  it("包住所有盒子", () => {
    expect(boundingBox([box(0, 0, 100, 60), box(200, 100, 100, 60)])).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 160,
    });
  });
});
