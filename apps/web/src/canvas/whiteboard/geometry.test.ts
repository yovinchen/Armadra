import { describe, expect, it } from "vitest";

import { makeItem } from "../test-support";
import { GEOS } from "./model";
import {
  arrowHead,
  geoPath,
  geoVertices,
  hitTestItem,
  itemsBounds,
  lineBounds,
} from "./geometry";

/**
 * 白板几何（React Flow 计划 §2.4）。
 *
 * 命中判定是这里最值得钉的一条：**空心形状的中间是空的**。点在一个未填充
 * 矩形的正中间不该选中它——这是所有白板的通用预期，也是右键菜单与内容
 * 引用命中的判据。
 */

describe("geoPath", () => {
  it("六种几何形都画得出闭合路径", () => {
    for (const geo of GEOS) {
      const d = geoPath(geo, 100, 80);
      expect(d, geo).toMatch(/^M /u);
      expect(d, geo).toMatch(/Z$/u);
    }
  });

  it("尺寸为 0 时不画退化的形状（刚按下还没拖开的那一帧）", () => {
    expect(geoPath("rectangle", 0, 80)).toBe("");
    expect(geoPath("ellipse", 100, 0)).toBe("");
  });

  it("顶点按框的比例摊开；椭圆没有顶点", () => {
    expect(geoVertices("rectangle", 100, 80)).toEqual([
      [0, 0],
      [100, 0],
      [100, 80],
      [0, 80],
    ]);
    expect(geoVertices("ellipse", 100, 80)).toEqual([]);
    expect(geoVertices("star", 100, 80)).toHaveLength(10);
  });
});

describe("lineBounds / itemsBounds", () => {
  it("折线的包围盒", () => {
    expect(
      lineBounds([
        [10, 20],
        [-5, 60],
        [30, 0],
      ]),
    ).toEqual({ x: -5, y: 0, w: 35, h: 60 });
  });

  it("空折线给 0×0", () => {
    expect(lineBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("一组对象的整体包围盒；空数组给 null", () => {
    expect(
      itemsBounds([
        makeItem("shape", { x: 0, y: 0, w: 100, h: 50 }),
        makeItem("shape", { x: 200, y: 100, w: 100, h: 50 }),
      ]),
    ).toEqual({ x: 0, y: 0, w: 300, h: 150 });
    expect(itemsBounds([])).toBeNull();
  });
});

describe("arrowHead", () => {
  it("箭头画在末端，朝着来的方向张开", () => {
    const d = arrowHead([100, 0], [0, 0], 10);
    expect(d).toMatch(/^M /u);
    // 两条边都落在末端左侧（x < 100）：箭头是往回张的。
    const xs = [...d.matchAll(/-?\d+(?:\.\d+)?(?= )/gu)].map((m) =>
      Number(m[0]),
    );
    expect(xs[0]).toBeLessThan(100);
  });
});

describe("hitTestItem", () => {
  it("文字与图片按包围盒", () => {
    const text = makeItem("text", { x: 0, y: 0, w: 100, h: 40 });
    expect(hitTestItem(text, 50, 20)).toBe(true);
    expect(hitTestItem(text, 200, 20)).toBe(false);
  });

  it("空心矩形的正中间不算命中，边上算", () => {
    const hollow = makeItem("shape", {
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      style: { color: "black", size: "m", fill: "none" },
    });
    expect(hitTestItem(hollow, 100, 100)).toBe(false);
    expect(hitTestItem(hollow, 0, 100)).toBe(true);
  });

  it("填充的矩形整块都算命中", () => {
    const filled = makeItem("shape", {
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      style: { color: "black", size: "m", fill: "semi" },
    });
    expect(hitTestItem(filled, 100, 100)).toBe(true);
  });

  it("直线按「离线多近」，包围盒里的空白处不算", () => {
    const line = makeItem("line", {
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      points: [
        [0, 0],
        [200, 200],
      ],
    });
    expect(hitTestItem(line, 100, 100)).toBe(true);
    expect(hitTestItem(line, 190, 10)).toBe(false);
  });

  it("包围盒之外一律不命中（先做便宜的那一步）", () => {
    const item = makeItem("shape", { x: 0, y: 0, w: 50, h: 50 });
    expect(hitTestItem(item, -100, -100)).toBe(false);
    expect(hitTestItem(item, 500, 500)).toBe(false);
  });
});
