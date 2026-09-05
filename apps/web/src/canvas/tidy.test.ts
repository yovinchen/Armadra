import { describe, expect, it, vi } from "vitest";

/** 只为了拿默认尺寸；节点体（xterm / CodeMirror）不该被拉进纯几何单测。 */
const nodeMetaStub = {
  labelKey: "node.terminal",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import type { CanvasEdge, CanvasNode } from "@armadra/shared";
import { COLUMN_GAP, ROW_GAP, tidy, tidyPositions } from "./tidy";
import { COLLAPSED_HEIGHT } from "../store/defaults";

const box = (id: string, width = 200, height = 100) => ({ id, width, height });

/** 排完之后每个盒子的矩形，用来验「不重叠」。 */
function rects(
  boxes: { id: string; width: number; height: number }[],
  positions: Record<string, { x: number; y: number }>,
) {
  return boxes.map((item) => {
    const at = positions[item.id];
    return {
      id: item.id,
      left: at!.x,
      top: at!.y,
      right: at!.x + item.width,
      bottom: at!.y + item.height,
    };
  });
}

function overlaps(
  boxes: { id: string; width: number; height: number }[],
  positions: Record<string, { x: number; y: number }>,
) {
  const all = rects(boxes, positions);
  const hits: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      if (
        a!.left < b!.right &&
        b!.left < a!.right &&
        a!.top < b!.bottom &&
        b!.top < a!.bottom
      ) {
        hits.push(`${a!.id}×${b!.id}`);
      }
    }
  }
  return hits;
}

describe("tidy", () => {
  it("空画布返回空表", () => {
    expect(tidy([], [])).toEqual({});
  });

  it("分量内：源节点排在目标左边，一层一列", () => {
    const positions = tidy(
      [box("a"), box("b"), box("c")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 200 + COLUMN_GAP, y: 0 });
    expect(positions.c).toEqual({ x: (200 + COLUMN_GAP) * 2, y: 0 });
  });

  it("列内按行距堆叠，列宽取该列最宽的节点", () => {
    const positions = tidy(
      [box("a", 300, 120), box("b", 200, 80), box("c", 200, 80)],
      [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    );
    expect(positions.b).toEqual({ x: 300 + COLUMN_GAP, y: 0 });
    expect(positions.c).toEqual({ x: 300 + COLUMN_GAP, y: 80 + ROW_GAP });
  });

  it("有环也不会死循环，指向未知节点的边被忽略", () => {
    const positions = tidy(
      [box("a"), box("b")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
        { source: "a", target: "ghost" },
      ],
    );
    expect(Object.keys(positions).sort()).toEqual(["a", "b"]);
    // 纯环里每个节点都有入边，谁都不是根，于是一起落到同一列。
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 0, y: 100 + ROW_GAP });
  });

  it("按连通分量分组，分量按阅读顺序摆放", () => {
    // 三个独立分量：a-b、c、d。宽度小、行宽上限大 → 同一行从左到右。
    const boxes = [box("a"), box("b"), box("c"), box("d")];
    const positions = tidy(boxes, [{ source: "a", target: "b" }], {
      aspect: 100, // 极端扁平：一行放得下所有分量
    });
    // 分量 1（a→b）占据 [0, 460]，接着是 c、d。
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 260, y: 0 });
    expect(positions.c!.y).toBe(0);
    expect(positions.d!.y).toBe(0);
    expect(positions.c!.x).toBeGreaterThan(positions.b!.x);
    expect(positions.d!.x).toBeGreaterThan(positions.c!.x);
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("行放不下就换行，行高取行内最高的分量", () => {
    // 6 个 200×100 的孤立节点，宽高比 1 → 行宽上限 ≈ sqrt(60000)×1.15 ≈ 282
    // → 一行只放得下 1 个（第二个要到 x=260，右边 460 > 282）。
    const boxes = ["a", "b", "c", "d", "e", "f"].map((id) => box(id));
    const positions = tidy(boxes, [], { aspect: 1 });
    const rows = new Set(boxes.map((item) => positions[item.id]!.y));
    expect(rows.size).toBeGreaterThan(1);
    // 行距 = 上一行的行高 + ROW_GAP
    expect(positions.b).toEqual({ x: 0, y: 100 + ROW_GAP });
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("宽视口（宽高比 2）下 6 个等大节点排成 ≥2 列", () => {
    const boxes = ["a", "b", "c", "d", "e", "f"].map((id) => box(id));
    const positions = tidy(boxes, [], { aspect: 2 });
    const columns = new Set(boxes.map((item) => positions[item.id]!.x));
    expect(columns.size).toBeGreaterThanOrEqual(2);
    expect(overlaps(boxes, positions)).toEqual([]);
    // 阅读顺序：第一个永远在原点。
    expect(positions.a).toEqual({ x: 0, y: 0 });
  });

  it("比整行还宽的分量独占一行，不会死循环", () => {
    const boxes = [box("wide", 4000, 100), box("a"), box("b")];
    const positions = tidy(boxes, [], { aspect: 1 });
    expect(positions.wide).toEqual({ x: 0, y: 0 });
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("同一份输入排两次结果一致（确定性）", () => {
    const boxes = ["a", "b", "c", "d"].map((id) => box(id));
    const links = [{ source: "a", target: "c" }];
    expect(tidy(boxes, links, { aspect: 1.6 })).toEqual(
      tidy(boxes, links, { aspect: 1.6 }),
    );
  });
});

/* ------------------------------ 文档层入口 -------------------------------- */

const timestamp = "2026-09-04T00:00:00.000Z";

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    boardId: "board",
    type: "terminal",
    title: id,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  } as CanvasNode;
}

const link = (source: string, target: string): CanvasEdge =>
  ({
    id: `${source}-${target}`,
    boardId: "board",
    source,
    target,
    kind: "link",
    createdAt: timestamp,
    updatedAt: timestamp,
  }) as CanvasEdge;

describe("tidyPositions", () => {
  it("没写 size 的节点用 NODE_META 的默认尺寸", () => {
    const positions = tidyPositions([node("a"), node("b")], [link("a", "b")], {
      aspect: 100,
    });
    // 默认宽 240 → 第二列在 240 + COLUMN_GAP
    expect(positions.b).toEqual({ x: 240 + COLUMN_GAP, y: 0 });
  });

  it("折叠的节点按 COLLAPSED_HEIGHT 参与排布", () => {
    // root 分出两个折叠节点：同一列堆叠时按 40px 而不是 400px 算行距，
    // 否则折叠一排节点之后列里全是空气。
    const positions = tidyPositions(
      [
        node("root", { size: { width: 200, height: 100 } }),
        node("x", { size: { width: 200, height: 400 }, collapsed: true }),
        node("y", { size: { width: 200, height: 400 }, collapsed: true }),
      ],
      [link("root", "x"), link("root", "y")],
      { aspect: 100 },
    );
    expect(positions.x).toEqual({ x: 200 + COLUMN_GAP, y: 0 });
    expect(positions.y!.y).toBe(COLLAPSED_HEIGHT + ROW_GAP);
  });

  it("组框整体参与排布，组员的相对坐标不动", () => {
    const nodes = [
      node("solo", { size: { width: 200, height: 100 } }),
      node("frame", {
        type: "group",
        data: { kind: "group" },
        size: { width: 600, height: 400 },
        position: { x: 900, y: 900 },
      }),
      node("child", {
        parentId: "frame",
        size: { width: 200, height: 100 },
        position: { x: 24, y: 60 },
      }),
      node("child2", {
        parentId: "frame",
        size: { width: 200, height: 100 },
        position: { x: 260, y: 60 },
      }),
    ];
    const positions = tidyPositions(nodes, [], { aspect: 100 });

    // 组员不出现在结果里 → 保持相对组框的坐标，跟着组一起平移。
    expect(positions.child).toBeUndefined();
    expect(positions.child2).toBeUndefined();
    expect(Object.keys(positions).sort()).toEqual(["frame", "solo"]);

    // 组框按自己的 600×400 占位，排在 solo 右边一整个列距之外。
    expect(positions.solo).toEqual({ x: 0, y: 0 });
    expect(positions.frame).toEqual({ x: 200 + COLUMN_GAP, y: 0 });

    // 组一动，两个组员的**相对**偏移仍然是 236（= 260 - 24）。
    const frame = positions.frame;
    const absolute = (child: { x: number; y: number }) => ({
      x: frame!.x + child.x,
      y: frame!.y + child.y,
    });
    expect(absolute({ x: 260, y: 60 }).x - absolute({ x: 24, y: 60 }).x).toBe(
      236,
    );
  });
});
