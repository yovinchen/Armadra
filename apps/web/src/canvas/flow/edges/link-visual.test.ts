import { describe, expect, it } from "vitest";

import type { Box } from "../../geometry";
import { arrowHead, linkView, ARROW_SIZE } from "./link-visual";

/**
 * 连线的画法（React Flow 计划 F06）。
 *
 * 「谁读谁」的箭头方向、标签、以及沿切线的箭头几何——全是纯函数，
 * 不需要挂画布。曲线本身在 `link-path.test.ts`。
 */

const LEFT: Box = { x: 0, y: 0, width: 100, height: 100 };
const RIGHT: Box = { x: 300, y: 0, width: 100, height: 100 };

describe("箭头方向与标签（§21）", () => {
  it("终端 ↔ 终端：双箭头，标签是「上下文」", () => {
    const view = linkView(LEFT, RIGHT, "terminal", "terminal");
    expect(view.arrowStart).toBe(true);
    expect(view.arrowEnd).toBe(true);
    expect(view.labelKey).toBe("edge.context");
  });

  it("内容 → 终端：单向指向终端，标签按内容那一端的类型", () => {
    const view = linkView(LEFT, RIGHT, "sticky", "terminal");
    expect(view.arrowStart).toBe(false);
    expect(view.arrowEnd).toBe(true);
    expect(view.labelKey).toBe("edge.sticky");
  });

  it("终端 → 内容：箭头仍然指向终端，与拖动方向无关", () => {
    const view = linkView(LEFT, RIGHT, "terminal", "editor");
    expect(view.arrowStart).toBe(true);
    expect(view.arrowEnd).toBe(false);
    expect(view.labelKey).toBe("edge.file");
  });

  it("内容 ↔ 内容（含分组）：没有箭头，只表示归到一起", () => {
    const view = linkView(LEFT, RIGHT, "group", "sticky");
    expect(view.arrowStart).toBe(false);
    expect(view.arrowEnd).toBe(false);
  });
});

describe("贴边起笔", () => {
  it("目标在右边时从右侧边中点出发、落在目标左侧边中点", () => {
    const { curve } = linkView(LEFT, RIGHT, "terminal", "terminal");
    expect([curve.sourceX, curve.sourceY]).toEqual([100, 50]);
    expect([curve.targetX, curve.targetY]).toEqual([300, 50]);
  });

  it("目标在左边时两端整个换边（不从头部上方绕过去）", () => {
    const { curve } = linkView(RIGHT, LEFT, "terminal", "terminal");
    expect([curve.sourceX, curve.sourceY]).toEqual([300, 50]);
    expect([curve.targetX, curve.targetY]).toEqual([100, 50]);
  });
});

describe("箭头几何", () => {
  it("两条倒刺都落在离箭尖 ARROW_SIZE 的地方", () => {
    const d = arrowHead({ x: 100, y: 0 }, { x: 0, y: 0 });
    const points = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/gu)].map(
      ([, x, y]) => ({ x: Number(x), y: Number(y) }),
    );
    expect(points).toHaveLength(3);
    for (const barb of [points[0]!, points[2]!]) {
      expect(Math.hypot(barb.x - 100, barb.y - 0)).toBeCloseTo(ARROW_SIZE, 6);
    }
    // 中间那个点是箭尖本身。
    expect(points[1]).toEqual({ x: 100, y: 0 });
  });

  it("两端重合时不画箭头（除以 0 的方向没有意义）", () => {
    expect(arrowHead({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe("");
  });
});
