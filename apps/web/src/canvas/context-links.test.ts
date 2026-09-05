import { describe, expect, it, vi } from "vitest";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

/** tldraw 在模块加载时就读 `matchMedia`（`derive.ts` 会把它拉进来）。 */
vi.hoisted(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
});

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
  buildLinkDocuments,
  changedDocuments,
  sameLinks,
} from "./context-links";
import { deriveEdges } from "./sync/derive";

const stamp = "2026-09-04T00:00:00.000Z";

function node(id: string, type: CanvasNode["type"], title: string): CanvasNode {
  return {
    id,
    boardId: "board",
    type,
    title,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: type },
    createdAt: stamp,
    updatedAt: stamp,
  } as CanvasNode;
}

function document(edges: { source: string; target: string }[]): BoardDocument {
  return {
    board: {} as BoardDocument["board"],
    nodes: [
      node("claude", "terminal", "Claude"),
      node("codex", "terminal", "Codex"),
      node("note", "sticky", "结论"),
      node("sketch", "browser", "草图"),
    ],
    edges: edges.map((edge, index) => ({
      id: `e${index}`,
      boardId: "board",
      kind: "link" as const,
      createdAt: stamp,
      updatedAt: stamp,
      ...edge,
    })),
  };
}

describe("buildLinkDocuments", () => {
  it("每个终端节点都拿到它连着的所有节点，含非便签类型", () => {
    const documents = buildLinkDocuments(
      document([
        { source: "note", target: "claude" },
        { source: "claude", target: "sketch" },
        { source: "claude", target: "codex" },
      ]),
    );
    expect(documents.claude?.map((link) => [link.id, link.kind])).toEqual([
      ["note", "sticky"],
      ["sketch", "browser"],
      ["codex", "terminal"],
    ]);
    // 无向：从终端拖出去的边，对端也要能读回来。
    expect(documents.codex).toEqual([
      { id: "claude", title: "Claude", kind: "terminal" },
    ]);
  });

  it("只给终端节点建文档（只有它们会去调那个接口）", () => {
    const documents = buildLinkDocuments(
      document([{ source: "note", target: "sketch" }]),
    );
    expect(Object.keys(documents).sort()).toEqual(["claude", "codex"]);
    expect(documents.claude).toEqual([]);
  });

  it("同一对节点连两次也只记一条", () => {
    const documents = buildLinkDocuments(
      document([
        { source: "note", target: "claude" },
        { source: "claude", target: "note" },
      ]),
    );
    expect(documents.claude).toHaveLength(1);
  });
});

describe("changedDocuments", () => {
  it("只推变了的节点", () => {
    const previous = {
      claude: [{ id: "note", title: "结论", kind: "sticky" }],
      codex: [],
    };
    const next = {
      claude: [{ id: "note", title: "改过的标题", kind: "sticky" }],
      codex: [],
    };
    expect(changedDocuments(previous, next)).toEqual(["claude"]);
    expect(changedDocuments(next, next)).toEqual([]);
    // 没推过的节点一定要推一次（第一次挂载）。
    expect(changedDocuments({}, next).sort()).toEqual(["claude", "codex"]);
  });
});

/**
 * 全链路：用户拉出来的连线（`link` shape）→ `edges` → 终端的链接文档。
 *
 * 边的 uuid 在 `props.edgeId` 里（`shapes/LinkArrow.ts` 换形时写的）。
 * 派生层认得它，`usePublishContextLinks` 才有东西可推。
 */
describe("link shape → edges → 链接文档", () => {
  const TERM = "019ff7d1-0d12-7421-833d-2c5e8d64ed11";
  const NOTE = "019ff7d1-0d12-7421-833d-2c5e8d64ed12";
  const EDGE = "019ff7d1-0d12-7421-833d-2c5e8d64ed13";

  it("link shape 派生出边并推成链接文档", () => {
    const link = {
      id: `shape:link-${EDGE}`,
      type: "link",
      typeName: "shape",
      props: {
        from: `shape:${NOTE}`,
        to: `shape:${TERM}`,
        edgeId: EDGE,
        kind: "link",
        createdAt: stamp,
        updatedAt: stamp,
      },
      meta: {},
    };

    const derived = deriveEdges([link] as never, "board", []);
    expect(derived.items).toHaveLength(1);
    expect(derived.items[0]!.id).toBe(EDGE);

    const board: BoardDocument = {
      board: {} as BoardDocument["board"],
      nodes: [node(TERM, "terminal", "Claude"), node(NOTE, "sticky", "结论")],
      edges: derived.items,
    };
    expect(buildLinkDocuments(board)[TERM]).toEqual([
      { id: NOTE, title: "结论", kind: "sticky" },
    ]);
  });
});

/**
 * 内容链接（白板图形，`kind: "shape"`）并进终端的链接文档（§6.3）。
 *
 * 白板 shape 不在 `BoardDocument` 里，所以这一半由 `useContentLinks()` 从 editor
 * 收集后作为第二个参数传进来。
 */
describe("buildLinkDocuments · 内容链接", () => {
  const SHAPE = "019ff7d1-0d12-7421-833d-2c5e8d64edaa";
  const shapeLink = {
    id: SHAPE,
    title: "架构图",
    kind: "shape",
    content: { text: "入口在 main.rs", pngPath: ".armadra/exports/x.png" },
  };

  it("终端拿到节点链接 + 内容链接", () => {
    const documents = buildLinkDocuments(
      document([{ source: "note", target: "claude" }]),
      { claude: [shapeLink] },
    );
    expect(documents.claude).toEqual([
      { id: "note", title: "结论", kind: "sticky" },
      shapeLink,
    ]);
    // 没有内容链接的终端不受影响。
    expect(documents.codex).toEqual([]);
  });

  it("不是终端的节点即使连了图形也没有文档", () => {
    const documents = buildLinkDocuments(document([]), {
      note: [shapeLink],
      claude: [shapeLink],
    });
    expect(documents.note).toBeUndefined();
    expect(documents.claude).toEqual([shapeLink]);
  });

  it("超过 64 条时截断（Runtime 会 400 掉整份文档）", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      ...shapeLink,
      id: `${SHAPE.slice(0, -2)}${index.toString(16).padStart(2, "0")}`,
    }));
    expect(buildLinkDocuments(document([]), { claude: many }).claude).toHaveLength(
      64,
    );
  });

  it("`sameLinks`：正文或 PNG 路径变了就要重推", () => {
    const changed = {
      ...shapeLink,
      content: { ...shapeLink.content, text: "改过了" },
    };
    expect(sameLinks([shapeLink], [shapeLink])).toBe(true);
    expect(sameLinks([shapeLink], [changed])).toBe(false);
    expect(changedDocuments({ claude: [shapeLink] }, { claude: [changed] })).toEqual(
      ["claude"],
    );
  });
});
