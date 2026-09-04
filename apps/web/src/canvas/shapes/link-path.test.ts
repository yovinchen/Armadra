import { describe, expect, it } from "vitest";

import type { Box } from "../geometry";
import { linkCurve, pointOnCurve, sampleCurve } from "./link-path";

/**
 * 连线的几何（用户 2026-09-04 的反馈：「为什么是直线？应该在边框上往外连」）。
 *
 * 三条不变量：从**相对的边的中点**出发、只走左右两侧、中间是一条水平切线的
 * 贝塞尔（不是直线）。
 */

const box = (x: number, y: number, width = 240, height = 200): Box => ({
  x,
  y,
  width,
  height,
});

describe("linkCurve", () => {
  it("左右摆放：右边中点出，左边中点入", () => {
    const source = box(0, 0);
    const target = box(600, 40);
    const curve = linkCurve(source, target);

    expect(curve.sourceSide).toBe("right");
    expect(curve.targetSide).toBe("left");
    // 起点 = 起点节点右边的中点；终点 = 终点节点左边的中点。
    expect([curve.sourceX, curve.sourceY]).toEqual([240, 100]);
    expect([curve.targetX, curve.targetY]).toEqual([600, 140]);
  });

  it("目标在左侧时整条线反过来", () => {
    const curve = linkCurve(box(600, 0), box(0, 0));
    expect(curve.sourceSide).toBe("left");
    expect(curve.targetSide).toBe("right");
    expect([curve.sourceX, curve.sourceY]).toEqual([600, 100]);
    expect([curve.targetX, curve.targetY]).toEqual([240, 100]);
  });

  it("上下摆放也只走左右两侧（`horizontal` 锚，不从头部上面绕）", () => {
    const curve = linkCurve(box(0, 0), box(20, 600));
    expect(curve.sourceSide).toBe("right");
    expect(curve.targetSide).toBe("left");
    expect(curve.sourceY).toBe(100);
    expect(curve.targetY).toBe(700);
  });

  it("控制点是水平的：切线离开边框时垂直于边框", () => {
    const curve = linkCurve(box(0, 0), box(600, 400));
    expect(curve.c1.y).toBe(curve.sourceY);
    expect(curve.c2.y).toBe(curve.targetY);
    expect(curve.c1.x).toBeGreaterThan(curve.sourceX);
    expect(curve.c2.x).toBeLessThan(curve.targetX);
  });

  it("是曲线不是直线（中点因为对称正好落在直线上，取 t=0.25 看）", () => {
    const curve = linkCurve(box(0, 0), box(600, 400));
    const point = pointOnCurve(curve, 0.25);
    const straightY =
      curve.sourceY +
      ((curve.targetY - curve.sourceY) * (point.x - curve.sourceX)) /
        (curve.targetX - curve.sourceX);
    expect(Math.abs(point.y - straightY)).toBeGreaterThan(1);

    // 标签挂在 t=0.5 那个点上。
    const mid = pointOnCurve(curve, 0.5);
    expect(curve.labelX).toBeCloseTo(mid.x, 6);
    expect(curve.labelY).toBeCloseTo(mid.y, 6);
  });

  it("`d` 是一条三次贝塞尔，起止点与锚点一致", () => {
    const curve = linkCurve(box(0, 0), box(600, 0));
    expect(curve.d).toBe(
      `M ${curve.sourceX},${curve.sourceY} C ${curve.c1.x},${curve.c1.y} ${curve.c2.x},${curve.c2.y} ${curve.targetX},${curve.targetY}`,
    );
  });
});

describe("sampleCurve", () => {
  const curve = linkCurve(box(0, 0), box(600, 400));

  it("首尾就是两个锚点（命中测试与选中框都靠它）", () => {
    const points = sampleCurve(curve, 24);
    expect(points).toHaveLength(25);
    expect(points[0]).toEqual({ x: curve.sourceX, y: curve.sourceY });
    expect(points.at(-1)!.x).toBeCloseTo(curve.targetX, 6);
    expect(points.at(-1)!.y).toBeCloseTo(curve.targetY, 6);
  });

  it("采样点都落在曲线上，且沿着 x 单调推进", () => {
    const points = sampleCurve(curve, 12);
    for (const [index, point] of points.entries()) {
      const exact = pointOnCurve(curve, index / 12);
      expect(point.x).toBeCloseTo(exact.x, 9);
      expect(point.y).toBeCloseTo(exact.y, 9);
      if (index > 0) expect(point.x).toBeGreaterThan(points[index - 1]!.x);
    }
  });
});
