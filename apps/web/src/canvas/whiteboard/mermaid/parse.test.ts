import { describe, expect, it } from "vitest";

import { BROKEN, FLOWCHART_LR, FLOWCHART_TD, SEQUENCE } from "./fixtures";
import {
  dashFromStroke,
  fillFromStyles,
  graphFromDb,
  MermaidParseError,
  normalizeDirection,
  parseMermaid,
  toParseError,
} from "./parse";

/**
 * 解析层（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §2）。
 *
 * 跑的是**真** mermaid：`mermaid.parse` 与 `getDiagramFromText` 在 jsdom 里
 * 都不需要度量 DOM，所以这一层可以钉死在真实行为上。需要真 DOM 的只有
 * `mermaid.render`，那条路在 `render.ts`，测试里一律 mock（设计 §7）。
 */

describe("parseMermaid：含 subgraph 与边标签的 LR 流程图", () => {
  it("方向、节点、边与子图都解得出来", async () => {
    const parsed = await parseMermaid(FLOWCHART_LR);
    expect(parsed.kind).toBe("graph");
    if (parsed.kind !== "graph") return;
    const { graph } = parsed;

    expect(graph.direction).toBe("LR");
    expect(graph.nodes.map((node) => node.id)).toEqual(["A", "B", "C", "D"]);
    expect(graph.nodes.map((node) => node.label)).toEqual([
      "开始",
      "要继续吗",
      "完成",
      "停下",
    ]);
    expect(graph.nodes.map((node) => node.shape)).toEqual([
      "square",
      "diamond",
      "circle",
      "stadium",
    ]);

    expect(graph.edges).toHaveLength(3);
    expect(graph.edges.map((edge) => [edge.from, edge.to, edge.label])).toEqual(
      [
        ["A", "B", ""],
        ["B", "C", "是"],
        ["B", "D", "否"],
      ],
    );
    // `-->` 是单向箭头。
    expect(graph.edges.every((edge) => edge.arrowEnd && !edge.arrowStart)).toBe(
      true,
    );

    expect(graph.groups).toEqual([
      { id: "S", label: "收尾", nodes: ["C", "D"] },
    ]);
  });
});

describe("parseMermaid：TD 方向与形状 / 样式覆盖", () => {
  it("TD 归一成 TB，六种形状与三种线型都对", async () => {
    const parsed = await parseMermaid(FLOWCHART_TD);
    expect(parsed.kind).toBe("graph");
    if (parsed.kind !== "graph") return;
    const { graph } = parsed;

    expect(graph.direction).toBe("TB");
    const shapes = new Map(graph.nodes.map((n) => [n.id, n.shape]));
    expect(shapes.get("a")).toBe("square");
    expect(shapes.get("b")).toBe("diamond");
    expect(shapes.get("c")).toBe("circle");
    expect(shapes.get("d")).toBe("stadium");
    expect(shapes.get("e")).toBe("hexagon");
    // 裸节点（`h --> bare`，没写形状）降级成 unknown，下游再映射成矩形，
    // 并且用 id 当标签。
    expect(shapes.get("bare")).toBe("unknown");
    expect(graph.nodes.find((n) => n.id === "bare")?.label).toBe("bare");

    // `-.->` → dashed；`==>` 与 `---` 白板没有对应档，降级实线。
    const byPair = new Map(
      graph.edges.map((edge) => [`${edge.from}${edge.to}`, edge]),
    );
    expect(byPair.get("ef")?.dash).toBe("dashed");
    expect(byPair.get("fg")?.dash).toBe("solid");
    // `---` 没有箭头。
    expect(byPair.get("gh")?.arrowEnd).toBe(false);
    expect(byPair.get("ab")?.arrowEnd).toBe(true);

    // `style a fill:…` 与 `classDef` + `class b cool` 都要映射到填充色。
    const fills = new Map(graph.nodes.map((n) => [n.id, n.fill]));
    expect(fills.get("a")).toBe("#e03131");
    expect(fills.get("b")).toBe("#4465e9");
    expect(fills.get("c")).toBeNull();
  });
});

describe("parseMermaid：其余图种走回退", () => {
  it("sequenceDiagram 判成 image，不产出图模型", async () => {
    const parsed = await parseMermaid(SEQUENCE);
    expect(parsed.kind).toBe("image");
    if (parsed.kind !== "image") return;
    expect(parsed.diagramType).toBe("sequence");
  });
});

describe("parseMermaid：错误输入", () => {
  it("语法错抛 MermaidParseError，带原话与 1 起的行号", async () => {
    const error = await parseMermaid(BROKEN).catch((cause) => cause);
    expect(error).toBeInstanceOf(MermaidParseError);
    expect((error as MermaidParseError).message).toMatch(/Parse error/u);
    expect((error as MermaidParseError).line).toBe(3);
  });

  it("空文本也抛，不返回一个空图", async () => {
    await expect(parseMermaid("   ")).rejects.toBeInstanceOf(MermaidParseError);
  });
});

/* ------------------------------ 纯函数部件 -------------------------------- */

describe("graphFromDb", () => {
  const db = {
    getDirection: () => "TD",
    getVertices: () =>
      new Map([
        ["x", { id: "x", text: "X", type: "diamond", styles: [], classes: [] }],
        ["y", { id: "y", text: "", type: null, styles: [], classes: ["c"] }],
      ]),
    getEdges: () => [
      {
        start: "x",
        end: "y",
        text: "go",
        type: "arrow_point",
        stroke: "dotted",
      },
      // 指向不存在的节点：必须被丢掉，否则布局里会冒出幽灵节点。
      { start: "x", end: "ghost", text: "", type: "arrow_point" },
    ],
    getSubGraphs: () => [
      { id: "g", title: "G", nodes: ["x", "ghost"] },
      // 成员全不存在的子图不产出框。
      { id: "empty", title: "E", nodes: ["ghost"] },
    ],
    getClasses: () => ({ c: { id: "c", styles: ["fill:#abc"] } }),
  };

  it("把 db 收敛成中间模型，并丢掉悬空的边与空子图", () => {
    const graph = graphFromDb(db);
    expect(graph).not.toBeNull();
    expect(graph!.direction).toBe("TB");
    expect(graph!.edges).toHaveLength(1);
    expect(graph!.edges[0]!.dash).toBe("dashed");
    expect(graph!.groups).toEqual([{ id: "g", label: "G", nodes: ["x"] }]);
    // 没写标签的节点用 id 当标签（和 Mermaid 渲染一致）。
    expect(graph!.nodes[1]!.label).toBe("y");
    // classDef 的填充色经 class 名带过来。
    expect(graph!.nodes[1]!.fill).toBe("#abc");
  });

  it("没有节点时返回 null（调用方据此退到图片回退）", () => {
    expect(graphFromDb({ getVertices: () => new Map() })).toBeNull();
    expect(graphFromDb({})).toBeNull();
  });

  it("读方法抛异常时退化，不炸整条路", () => {
    expect(
      graphFromDb({
        getVertices: () => {
          throw new Error("boom");
        },
      }),
    ).toBeNull();
  });

  it("节点自己的 style 压过 classDef", () => {
    const graph = graphFromDb({
      getVertices: () =>
        new Map([
          [
            "n",
            {
              id: "n",
              text: "n",
              type: "square",
              styles: ["fill:#111"],
              classes: ["c"],
            },
          ],
        ]),
      getClasses: () => ({ c: { id: "c", styles: ["fill:#999"] } }),
    });
    expect(graph!.nodes[0]!.fill).toBe("#111");
  });
});

describe("normalizeDirection", () => {
  it("TD 是 TB 的别名，认不出的退 TB", () => {
    expect(normalizeDirection("TD")).toBe("TB");
    expect(normalizeDirection("lr")).toBe("LR");
    expect(normalizeDirection("sideways")).toBe("TB");
    expect(normalizeDirection(undefined)).toBe("TB");
  });
});

describe("fillFromStyles", () => {
  it("只取 fill，忽略描边与字色", () => {
    expect(fillFromStyles(["stroke:#333", "fill:#f9f"])).toBe("#f9f");
    expect(fillFromStyles(["fill: #ffaa00 "])).toBe("#ffaa00");
    expect(fillFromStyles(["stroke:#333"])).toBeNull();
    expect(fillFromStyles(["fill:none"])).toBeNull();
    // `stroke-fill` 之类的不该被 `fill:` 命中。
    expect(fillFromStyles(["color:#fff"])).toBeNull();
  });
});

describe("dashFromStroke", () => {
  it("dotted → dashed，其余一律实线", () => {
    expect(dashFromStroke("dotted")).toBe("dashed");
    expect(dashFromStroke("thick")).toBe("solid");
    expect(dashFromStroke("normal")).toBe("solid");
    expect(dashFromStroke(undefined)).toBe("solid");
  });
});

describe("toParseError", () => {
  it("没有 hash 时行号是 null，消息只取首行", () => {
    const error = toParseError(new Error("bad thing\nstack line"));
    expect(error.message).toBe("bad thing");
    expect(error.line).toBeNull();
  });

  it("非 Error 也给得出一条消息", () => {
    expect(toParseError("nope").message).toBe("Mermaid parse failed");
  });
});
