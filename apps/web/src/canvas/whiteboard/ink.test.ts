import { describe, expect, it } from "vitest";

import {
  inkBounds,
  inkPath,
  outlineToPath,
  scaleInk,
  simplifyPoints,
  strokeOutline,
  translatePoints,
} from "./ink";
import { MAX_INK_POINTS, type InkPoint } from "./model";

/**
 * 墨迹几何（React Flow 计划 T07）。
 *
 * 三件事必须钉住：轮廓是闭合的（否则填充画不出来）、简化之后点数一定在
 * 上限内（否则 zod 会拒绝整份文档）、缩放只动坐标不动压力。
 */

function line(count: number, jitter = 0): InkPoint[] {
  return Array.from(
    { length: count },
    (_, index) =>
      [index, jitter === 0 ? 0 : (index % 2) * jitter, 0.5] as InkPoint,
  );
}

describe("strokeOutline / outlineToPath", () => {
  it("轮廓闭合：路径以 M 开头、以 Z 结尾", () => {
    const d = inkPath(line(12), { size: 4 });
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("一个点也画得出一块闭合的墨点（点一下就抬笔）", () => {
    const outline = strokeOutline([[10, 10, 0.5]], { size: 6 });
    expect(outline.length).toBeGreaterThan(0);
    expect(outlineToPath(outline)).toMatch(/Z$/u);
  });

  it("空点集不产生路径", () => {
    expect(strokeOutline([], { size: 4 })).toEqual([]);
    expect(outlineToPath([])).toBe("");
    expect(inkPath([], { size: 4 })).toBe("");
  });

  it("高亮笔关掉压力细化：同一组点画出来比普通笔更均匀", () => {
    const points = line(20, 3);
    const plain = strokeOutline(points, { size: 8 });
    const highlight = strokeOutline(points, { size: 8, highlight: true });
    expect(plain.length).toBeGreaterThan(0);
    expect(highlight.length).toBeGreaterThan(0);
    expect(highlight).not.toEqual(plain);
  });
});

describe("simplifyPoints", () => {
  it("一条直线上的中间点全部丢掉，只剩两端", () => {
    expect(simplifyPoints(line(50))).toHaveLength(2);
  });

  it("拐点保留：锯齿线简化后仍然是锯齿", () => {
    const zigzag = line(41, 10);
    expect(simplifyPoints(zigzag).length).toBeGreaterThan(10);
  });

  it("简化不掉的长线按上限抽稀，结果一定不超过上限", () => {
    const dense: InkPoint[] = Array.from(
      { length: 5_000 },
      (_, index) => [index, (index % 2) * 20, 0.5] as InkPoint,
    );
    const simplified = simplifyPoints(dense);
    expect(simplified.length).toBeLessThanOrEqual(MAX_INK_POINTS);
    // 抽稀保端点：最后一点还是原来那一点，线不会莫名其妙短一截。
    expect(simplified[simplified.length - 1]).toEqual(dense[dense.length - 1]);
  });

  it("两个点以内原样返回", () => {
    const two = line(2);
    expect(simplifyPoints(two)).toEqual(two);
  });
});

describe("inkBounds", () => {
  it("按线宽的一半向四周外扩", () => {
    expect(
      inkBounds(
        [
          [10, 20, 0.5],
          [30, 60, 0.5],
        ],
        4,
      ),
    ).toEqual({ x: 8, y: 18, w: 24, h: 44 });
  });

  it("空点集给 0×0 的盒子", () => {
    expect(inkBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("translatePoints / scaleInk", () => {
  it("平移只动坐标", () => {
    expect(translatePoints([[10, 20, 0.7]], -10, -20)).toEqual([[0, 0, 0.7]]);
  });

  it("缩放只动坐标，压力原样带过去", () => {
    expect(scaleInk([[10, 20, 0.7]], 2, 0.5)).toEqual([[20, 10, 0.7]]);
  });

  it("比例是 0 或 NaN 时按 1 处理，绝不让 NaN 进文档", () => {
    expect(scaleInk([[10, 20, 0.7]], 0, Number.NaN)).toEqual([[10, 20, 0.7]]);
  });
});
