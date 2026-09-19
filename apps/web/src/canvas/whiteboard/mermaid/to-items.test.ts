import { describe, expect, it } from "vitest";

import { hitTestItem } from "../geometry";
import type { Item, LineItem, ShapeItem, TextItem } from "../model";
import { FLOWCHART_LR, FLOWCHART_TD } from "./fixtures";
import { centreLayout, layoutGraph, type LayoutOptions } from "./layout";
import { parseMermaid, type MermaidGraph } from "./parse";
import {
  boundaryPoint,
  geoForShape,
  graphToItems,
  nearestColor,
  parseHex,
} from "./to-items";

/**
 * 中间模型 → 白板对象（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §3.1）。
 *
 * 两条验收线：
 *  1. **连线的端点落在形状边界上**，不是落在外接矩形上——菱形与椭圆最容易
 *     在这里露馅（箭头悬空或者插进形状里一截）。
 *  2. **入列顺序即 z 序**：子图框必须在最底，否则它会把成员整个盖住。
 */

const OPTIONS: LayoutOptions = { charWidth: 11.6, lineHeight: 28 };

let counter = 0;
const newId = () => `id-${(counter += 1)}`;

async function build(
  text: string,
): Promise<{ graph: MermaidGraph; items: Item[] }> {
  counter = 0;
  const parsed = await parseMermaid(text);
  if (parsed.kind !== "graph") throw new Error("expected a flowchart");
  const graph = parsed.graph;
  const layout = centreLayout(layoutGraph(graph, OPTIONS), { x: 0, y: 0 });
  return {
    graph,
    items: graphToItems(graph, layout, {
      style: { color: "black", size: "m" },
      scheme: "light",
      newId,
    }),
  };
}

const of = <K extends Item["kind"]>(items: Item[], kind: K) =>
  items.filter((item) => item.kind === kind) as Extract<Item, { kind: K }>[];

describe("geoForShape", () => {
  it("菱形与六边形一一对应", () => {
    expect(geoForShape("diamond")).toBe("diamond");
    expect(geoForShape("hexagon")).toBe("hexagon");
  });

  it("圆、双圆与胶囊都走椭圆", () => {
    expect(geoForShape("circle")).toBe("ellipse");
    expect(geoForShape("doublecircle")).toBe("ellipse");
    expect(geoForShape("stadium")).toBe("ellipse");
  });

  it("其余一律降级成矩形", () => {
    for (const shape of [
      "square",
      "round",
      "subroutine",
      "cylinder",
      "odd",
      "trapezoid",
      "lean_right",
      "lean_left",
      "inv_trapezoid",
      "unknown",
    ] as const) {
      expect(geoForShape(shape), shape).toBe("rectangle");
    }
  });
});

describe("graphToItems：LR 流程图（含 subgraph 与边标签）", () => {
  it("对象的数量与类型和图一一对应", async () => {
    const { graph, items } = await build(FLOWCHART_LR);
    // 4 个节点 + 1 个子图框 = 5 个 shape。
    expect(of(items, "shape")).toHaveLength(graph.nodes.length + 1);
    // 3 条边 = 3 条 line。
    expect(of(items, "line")).toHaveLength(graph.edges.length);
    // 只有带标签的边产出 text（3 条边里 2 条有标签）。
    expect(of(items, "text")).toHaveLength(2);
    // 不产出墨迹与图片。
    expect(of(items, "ink")).toHaveLength(0);
    expect(of(items, "image")).toHaveLength(0);
  });

  it("节点标签进的是 shape.label，不另起文字对象", async () => {
    const { items } = await build(FLOWCHART_LR);
    const labels = of(items, "shape").map((shape) => shape.label);
    for (const label of ["开始", "要继续吗", "完成", "停下"]) {
      expect(labels).toContain(label);
    }
  });

  it("边标签落成 text 对象，居中对齐", async () => {
    const { items } = await build(FLOWCHART_LR);
    const texts = of(items, "text") as TextItem[];
    expect(texts.map((text) => text.text).sort()).toEqual(["否", "是"]);
    expect(texts.every((text) => text.style.align === "middle")).toBe(true);
  });

  it("形状按映射表落地", async () => {
    const { items } = await build(FLOWCHART_LR);
    const byLabel = new Map(
      (of(items, "shape") as ShapeItem[]).map((s) => [s.label, s.geo]),
    );
    expect(byLabel.get("开始")).toBe("rectangle");
    expect(byLabel.get("要继续吗")).toBe("diamond");
    expect(byLabel.get("完成")).toBe("ellipse");
    expect(byLabel.get("停下")).toBe("ellipse");
  });

  it("子图框是虚线、不填充的矩形，且排在最前（即 z 最低）", async () => {
    const { items } = await build(FLOWCHART_LR);
    const first = items[0] as ShapeItem;
    expect(first.kind).toBe("shape");
    expect(first.label).toBe("收尾");
    expect(first.geo).toBe("rectangle");
    expect(first.style.dash).toBe("dashed");
    expect(first.style.fill).toBe("none");
  });

  it("入列顺序是 子图框 → 连线 → 节点 → 边标签", async () => {
    const { items } = await build(FLOWCHART_LR);
    const kinds = items.map((item) => item.kind);
    const firstLine = kinds.indexOf("line");
    const lastLine = kinds.lastIndexOf("line");
    const firstText = kinds.indexOf("text");
    // 子图框在所有连线之前。
    expect(firstLine).toBeGreaterThan(0);
    // 边标签在所有连线之后（不会被节点盖住）。
    expect(firstText).toBeGreaterThan(lastLine);
  });

  it("z 一律留 0，交给 store.addItems 按顺序编号", async () => {
    const { items } = await build(FLOWCHART_LR);
    expect(items.every((item) => item.z === 0)).toBe(true);
  });

  it("每个对象的 id 都不同", async () => {
    const { items } = await build(FLOWCHART_LR);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });
});

describe("graphToItems：连线端点落在形状边界上", () => {
  /** 点到形状边界的距离够近就算「在边界上」（浮点与 64 边形近似的余量）。 */
  const ON_EDGE = 1.5;

  it("每条线的两端都贴着对应形状的轮廓", async () => {
    const { graph, items } = await build(FLOWCHART_TD);
    const shapes = of(items, "shape") as ShapeItem[];
    const byLabel = new Map(shapes.map((shape) => [shape.label, shape]));
    const lines = of(items, "line") as LineItem[];

    expect(lines).toHaveLength(graph.edges.length);

    for (const [index, edge] of graph.edges.entries()) {
      const line = lines[index]!;
      const from = byLabel.get(labelOf(graph, edge.from))!;
      const to = byLabel.get(labelOf(graph, edge.to))!;
      const start: [number, number] = [
        line.x + line.points[0]![0],
        line.y + line.points[0]![1],
      ];
      const end: [number, number] = [
        line.x + line.points[1]![0],
        line.y + line.points[1]![1],
      ];
      // 端点贴着轮廓：`hitTestItem` 对未填充的形状只在描边附近命中，
      // 所以「命中」本身就等于「落在边界上」。
      expect(nearEdge(from, start, ON_EDGE), `${edge.from} 起点`).toBe(true);
      expect(nearEdge(to, end, ON_EDGE), `${edge.to} 终点`).toBe(true);
    }
  });

  it("端点在两个形状之间，不落进任何一个的内部深处", async () => {
    const { graph, items } = await build(FLOWCHART_TD);
    const byLabel = new Map(
      (of(items, "shape") as ShapeItem[]).map((s) => [s.label, s]),
    );
    for (const [index, edge] of graph.edges.entries()) {
      const line = (of(items, "line") as LineItem[])[index]!;
      const to = byLabel.get(labelOf(graph, edge.to))!;
      const end = [line.x + line.points[1]![0], line.y + line.points[1]![1]];
      // 终点不该穿到目标形状的中心去。
      const cx = to.x + to.w / 2;
      const cy = to.y + to.h / 2;
      expect(Math.hypot(end[0]! - cx, end[1]! - cy)).toBeGreaterThan(1);
    }
  });
});

describe("boundaryPoint", () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };

  it("矩形：朝正右射出去落在右边上", () => {
    const point = boundaryPoint("rectangle", box, [1000, 50]);
    expect(point[0]).toBeCloseTo(100, 6);
    expect(point[1]).toBeCloseTo(50, 6);
  });

  it("菱形：朝正右落在右顶点，而不是外接矩形的角上", () => {
    const point = boundaryPoint("diamond", box, [1000, 50]);
    expect(point[0]).toBeCloseTo(100, 6);
    expect(point[1]).toBeCloseTo(50, 6);
  });

  it("菱形：朝右下落在斜边上（比外接矩形近）", () => {
    const point = boundaryPoint("diamond", box, [1000, 1000]);
    // 斜边 x + y = 150（右下那条），所以两坐标之和应当是 150。
    expect(point[0] + point[1]).toBeCloseTo(150, 4);
    expect(point[0]).toBeLessThan(100);
  });

  it("椭圆：任意方向上的点都在椭圆方程上", () => {
    for (const angle of [0.3, 1.1, 2.7, 4.5, 6.0]) {
      const point = boundaryPoint("ellipse", box, [
        50 + Math.cos(angle) * 500,
        50 + Math.sin(angle) * 500,
      ]);
      const nx = (point[0] - 50) / 50;
      const ny = (point[1] - 50) / 50;
      expect(nx * nx + ny * ny).toBeCloseTo(1, 1);
    }
  });

  it("目标就是中心时退回中心，不产出 NaN", () => {
    const point = boundaryPoint("rectangle", box, [50, 50]);
    expect(point).toEqual([50, 50]);
    expect(Number.isNaN(point[0])).toBe(false);
  });

  it("退化的框（0 宽高）退回中心", () => {
    const point = boundaryPoint(
      "rectangle",
      { x: 5, y: 5, w: 0, h: 0 },
      [9, 9],
    );
    expect(point.every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe("颜色吸附", () => {
  it("parseHex 认 3 位与 6 位", () => {
    expect(parseHex("#f00")).toEqual([255, 0, 0]);
    expect(parseHex("ff0000")).toEqual([255, 0, 0]);
    expect(parseHex("#4465e9")).toEqual([68, 101, 233]);
    expect(parseHex("rebeccapurple")).toBeNull();
    expect(parseHex("")).toBeNull();
  });

  it("吸附到调色板里最近的颜色名", () => {
    // 调色板里 red 的浅色值就是 #e03131。
    expect(nearestColor("#e03131", "light")).toBe("red");
    expect(nearestColor("#4465e9", "light")).toBe("blue");
    // 略微偏一点也应当吸到同一支。
    expect(nearestColor("#e13232", "light")).toBe("red");
  });

  it("认不出的颜色返回 null（那个节点就保持当前笔色）", () => {
    expect(nearestColor("tomato", "light")).toBeNull();
  });

  it("Mermaid 的填充色映射成 semi 填充，而不是直接用它的十六进制", async () => {
    const { items } = await build(FLOWCHART_TD);
    const byLabel = new Map(
      (of(items, "shape") as ShapeItem[]).map((s) => [s.label, s]),
    );
    // `style a fill:#e03131`
    expect(byLabel.get("rect")!.style.color).toBe("red");
    expect(byLabel.get("rect")!.style.fill).toBe("semi");
    // `classDef cool fill:#4465e9` + `class b cool`
    expect(byLabel.get("diamond")!.style.color).toBe("blue");
    // 没有 fill 的节点保持当前笔色，且不填充。
    expect(byLabel.get("circle")!.style.color).toBe("black");
    expect(byLabel.get("circle")!.style.fill).toBeUndefined();
  });
});

describe("graphToItems：退化输入", () => {
  it("空图产出空数组（不落半成品）", () => {
    const graph: MermaidGraph = {
      direction: "TB",
      nodes: [],
      edges: [],
      groups: [],
    };
    const layout = layoutGraph(graph, OPTIONS);
    expect(
      graphToItems(graph, layout, {
        style: { color: "black", size: "m" },
        scheme: "light",
        newId,
      }),
    ).toEqual([]);
  });
});

/* -------------------------------- 辅助 ------------------------------------ */

function labelOf(graph: MermaidGraph, id: string): string {
  return graph.nodes.find((node) => node.id === id)?.label ?? id;
}

/** 点是否贴在形状的轮廓上（`hitTestItem` 只在描边附近命中未填充的形状）。 */
function nearEdge(
  shape: ShapeItem,
  point: readonly [number, number],
  tolerance: number,
): boolean {
  for (let dx = -tolerance; dx <= tolerance; dx += tolerance) {
    for (let dy = -tolerance; dy <= tolerance; dy += tolerance) {
      if (hitTestItem(shape, point[0] + dx, point[1] + dy)) return true;
    }
  }
  return false;
}
