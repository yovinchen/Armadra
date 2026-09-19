import { describe, expect, it } from "vitest";

import { FLOWCHART_LR, FLOWCHART_TD } from "./fixtures";
import {
  centreLayout,
  GROUP_PADDING,
  layoutGraph,
  measureLabel,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  type LayoutOptions,
} from "./layout";
import { parseMermaid, type MermaidGraph } from "./parse";

/**
 * 布局（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §3.1）。
 *
 * 最值得钉的是**方向**：用户写 `flowchart LR` 的全部意义就是想让图从左往右
 * 排，所以「LR 的宽度大于高度、TB 反过来」是这一层的验收线。
 */

const OPTIONS: LayoutOptions = { charWidth: 11.6, lineHeight: 28 };

async function graphOf(text: string): Promise<MermaidGraph> {
  const parsed = await parseMermaid(text);
  if (parsed.kind !== "graph") throw new Error("expected a flowchart");
  return parsed.graph;
}

describe("measureLabel", () => {
  it("短标签也不小于最小尺寸", () => {
    // 一个字符的宽度算出来比下限还小，所以宽度被下限兜住；高度由行高决定，
    // 本来就高过下限。
    const box = measureLabel("a", OPTIONS);
    expect(box.w).toBe(MIN_NODE_WIDTH);
    expect(box.h).toBeGreaterThanOrEqual(MIN_NODE_HEIGHT);
  });

  it("空标签也给得出一个可见的框", () => {
    const box = measureLabel("", OPTIONS);
    expect(box.w).toBe(MIN_NODE_WIDTH);
    expect(box.h).toBeGreaterThanOrEqual(MIN_NODE_HEIGHT);
  });

  it("长标签把框撑宽", () => {
    const short = measureLabel("ab", OPTIONS);
    const long = measureLabel("a very long label indeed", OPTIONS);
    expect(long.w).toBeGreaterThan(short.w);
  });

  it("CJK 按两个字宽算（否则中文标签会被框裁掉）", () => {
    // 四个汉字应当比四个西文字母宽。
    expect(measureLabel("中文标签", OPTIONS).w).toBeGreaterThan(
      measureLabel("abcd", OPTIONS).w,
    );
  });

  it("多行标签把框撑高", () => {
    expect(measureLabel("a\nb\nc", OPTIONS).h).toBeGreaterThan(
      measureLabel("a", OPTIONS).h,
    );
  });
});

describe("layoutGraph", () => {
  it("LR 横着排：整体更宽", async () => {
    const layout = layoutGraph(await graphOf(FLOWCHART_LR), OPTIONS);
    expect(layout.bounds.w).toBeGreaterThan(layout.bounds.h);
  });

  it("TB 竖着排：整体更高", async () => {
    const layout = layoutGraph(await graphOf(FLOWCHART_TD), OPTIONS);
    expect(layout.bounds.h).toBeGreaterThan(layout.bounds.w);
  });

  it("每个节点都拿到有限坐标，没有 NaN", async () => {
    const graph = await graphOf(FLOWCHART_TD);
    const layout = layoutGraph(graph, OPTIONS);
    expect(layout.nodes.size).toBe(graph.nodes.length);
    for (const node of layout.nodes.values()) {
      for (const value of [node.x, node.y, node.w, node.h]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(node.w).toBeGreaterThan(0);
      expect(node.h).toBeGreaterThan(0);
    }
  });

  it("节点互不重叠", async () => {
    const layout = layoutGraph(await graphOf(FLOWCHART_TD), OPTIONS);
    const boxes = [...layout.nodes.values()];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const apart =
          a.x + a.w <= b.x ||
          b.x + b.w <= a.x ||
          a.y + a.h <= b.y ||
          b.y + b.h <= a.y;
        expect(apart, `${a.id} 与 ${b.id} 重叠`).toBe(true);
      }
    }
  });

  it("子图框把成员整个包住，并且比成员大出一圈", async () => {
    const graph = await graphOf(FLOWCHART_LR);
    const layout = layoutGraph(graph, OPTIONS);
    expect(layout.groups).toHaveLength(1);
    const frame = layout.groups[0]!;
    expect(frame.label).toBe("Wrap up");
    for (const id of graph.groups[0]!.nodes) {
      const node = layout.nodes.get(id)!;
      expect(node.x).toBeGreaterThanOrEqual(frame.x + GROUP_PADDING - 0.001);
      expect(node.y).toBeGreaterThanOrEqual(frame.y);
      expect(node.x + node.w).toBeLessThanOrEqual(frame.x + frame.w);
      expect(node.y + node.h).toBeLessThanOrEqual(frame.y + frame.h);
    }
  });

  it("子图框算进整体包围盒", async () => {
    const layout = layoutGraph(await graphOf(FLOWCHART_LR), OPTIONS);
    const frame = layout.groups[0]!;
    expect(layout.bounds.x).toBeLessThanOrEqual(frame.x);
    expect(layout.bounds.y).toBeLessThanOrEqual(frame.y);
  });

  it("空图给出退化的包围盒而不是 NaN", () => {
    const layout = layoutGraph(
      { direction: "TB", nodes: [], edges: [], groups: [] },
      OPTIONS,
    );
    expect(layout.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(layout.nodes.size).toBe(0);
  });
});

describe("centreLayout", () => {
  it("整张图平移到落点上，相对位置不变", async () => {
    const layout = layoutGraph(await graphOf(FLOWCHART_LR), OPTIONS);
    const moved = centreLayout(layout, { x: 1000, y: -500 });
    expect(moved.bounds.x + moved.bounds.w / 2).toBeCloseTo(1000, 6);
    expect(moved.bounds.y + moved.bounds.h / 2).toBeCloseTo(-500, 6);
    expect(moved.bounds.w).toBeCloseTo(layout.bounds.w, 6);

    // 两个节点之间的间距一模一样。
    const [a, b] = [...layout.nodes.keys()];
    const gap = (nodes: typeof layout.nodes) =>
      nodes.get(b!)!.x - nodes.get(a!)!.x;
    expect(gap(moved.nodes)).toBeCloseTo(gap(layout.nodes), 6);
  });

  it("子图框跟着一起搬", async () => {
    const layout = layoutGraph(await graphOf(FLOWCHART_LR), OPTIONS);
    const moved = centreLayout(layout, { x: 100, y: 100 });
    const dx = moved.bounds.x - layout.bounds.x;
    expect(moved.groups[0]!.x).toBeCloseTo(layout.groups[0]!.x + dx, 6);
  });
});
