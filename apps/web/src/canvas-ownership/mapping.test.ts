import { describe, expect, it } from "vitest";
import {
  create,
  CanvasDocumentSchema,
  CanvasNodeSchema,
} from "@armadra/protocol";
import type { BoardDocument } from "@armadra/shared";

import {
  assertWhiteboardDigest,
  fromCanvasDocument,
  toCanvasDocument,
  whiteboardDigest,
  CanvasMappingError,
  WHITEBOARD_ENGINE,
  WHITEBOARD_SCHEMA_VERSION,
} from "./mapping";

const created = "2026-08-13T00:00:00.000Z";
const updated = "2026-08-13T00:00:01.000Z";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const frameId = "019ff7d1-9999-7000-8000-000000000001";
const stickyId = "019ff7d1-9999-7000-8000-000000000002";
const bareId = "019ff7d1-9999-7000-8000-000000000003";

const document: BoardDocument = {
  board: {
    id: boardId,
    workspaceId,
    name: "默认画布",
    sortOrder: -3,
    viewport: { x: -1024.5, y: 2048.25, zoom: 1.5 },
    whiteboard: '{"shapes":["手绘 📦"]}',
    createdAt: created,
    updatedAt: updated,
  },
  nodes: [
    {
      id: frameId,
      boardId,
      type: "group",
      title: "Frame",
      color: "#0a84ff",
      position: { x: 0, y: 0 },
      size: { width: 640, height: 480 },
      labels: [],
      note: "",
      data: { kind: "group" },
      createdAt: created,
      updatedAt: created,
    },
    {
      id: stickyId,
      boardId,
      type: "sticky",
      title: "构建 📦",
      color: "#0a84ff",
      position: { x: -12.5, y: 7.25 },
      size: { width: 240, height: 200 },
      collapsed: false,
      expandedHeight: 320,
      parentId: frameId,
      labels: ["构建", "夜间"],
      note: "备注 🈶",
      data: { kind: "sticky", content: "正文" },
      createdAt: created,
      updatedAt: updated,
    },
    {
      // 从来没设过尺寸的节点：缺省表示「按类型默认」，不是 0×0。
      id: bareId,
      boardId,
      type: "sticky",
      title: "裸便签",
      color: "#0a84ff",
      position: { x: 1, y: 2 },
      labels: [],
      note: "",
      data: { kind: "sticky", content: "" },
      createdAt: created,
      updatedAt: created,
    },
  ],
  edges: [
    {
      id: "019ff7d1-9999-7000-8000-000000000004",
      boardId,
      source: stickyId,
      target: frameId,
      kind: "link",
      createdAt: created,
      updatedAt: created,
    },
  ],
};

async function roundTrip(source: BoardDocument): Promise<BoardDocument> {
  const parts = await toCanvasDocument(source, 7n);
  const wire = create(CanvasDocumentSchema, {
    canvas: parts.canvas,
    nodes: parts.nodes,
    edges: parts.edges,
    annotations: parts.annotations,
  });
  await assertWhiteboardDigest(wire);
  return fromCanvasDocument(wire);
}

describe("画布文档映射", () => {
  it("id、坐标、frame 嵌套、标签与备注都原样回来", async () => {
    expect(await roundTrip(document)).toEqual(document);
  });

  it("没设过的尺寸留成缺省，而不是写成 0", async () => {
    const parts = await toCanvasDocument(document, 0n);
    const bare = parts.nodes.find((node) => node.nodeId === bareId)!;
    expect(bare.size).toBeUndefined();
    expect(bare.collapsed).toBeUndefined();
    expect(bare.expandedHeight).toBeUndefined();
    // 显式的零是另一份文档：两者的字节必须不同。
    const zero = create(CanvasNodeSchema, {
      nodeId: bareId,
      canvasId: boardId,
      size: {},
      collapsed: false,
      expandedHeight: 0,
    });
    expect(zero.size).toBeDefined();
    const back = await roundTrip(document);
    expect(back.nodes.find((node) => node.id === bareId)?.size).toBeUndefined();
  });

  it("父级引用与不带父级的节点分得清", async () => {
    const back = await roundTrip(document);
    expect(back.nodes.find((node) => node.id === stickyId)?.parentId).toBe(
      frameId,
    );
    // 空字符串是「不在任何 frame 里」，不是一个叫「""」的父级。
    expect(back.nodes.find((node) => node.id === frameId)?.parentId).toBe(
      undefined,
    );
  });

  it("白板快照带着摘要走，长度与摘要都能校验", async () => {
    const parts = await toCanvasDocument(document, 1n);
    const whiteboard = parts.canvas.whiteboard!;
    expect(whiteboard.schemaVersion).toBe(WHITEBOARD_SCHEMA_VERSION);
    expect(whiteboard.engineVersion).toBe(WHITEBOARD_ENGINE);
    expect(whiteboard.bytes).toBe(BigInt(whiteboard.snapshot.byteLength));
    expect(whiteboard.sha256).toEqual(
      await whiteboardDigest(whiteboard.snapshot),
    );
    const back = await roundTrip(document);
    expect(back.board.whiteboard).toBe(document.board.whiteboard);
  });

  it("摘要对不上就报错，不把坏快照当成空白板", async () => {
    const parts = await toCanvasDocument(document, 1n);
    const wire = create(CanvasDocumentSchema, {
      canvas: {
        ...parts.canvas,
        whiteboard: {
          ...parts.canvas.whiteboard!,
          sha256: new Uint8Array(32).fill(9),
        },
      },
      nodes: parts.nodes,
    });
    await expect(assertWhiteboardDigest(wire)).rejects.toBeInstanceOf(
      CanvasMappingError,
    );
  });

  it("没有画布行的文档解不出来，不交半份给界面", () => {
    expect(() => fromCanvasDocument(create(CanvasDocumentSchema, {}))).toThrow(
      CanvasMappingError,
    );
  });

  it("空白板留成空字符串，不长出一段假快照", async () => {
    const blank: BoardDocument = {
      ...document,
      board: { ...document.board, whiteboard: "" },
    };
    const parts = await toCanvasDocument(blank, 0n);
    expect(parts.canvas.whiteboard).toBeUndefined();
    expect((await roundTrip(blank)).board.whiteboard).toBe("");
  });

  it("既无标签也无备注的节点不生成注解", async () => {
    const parts = await toCanvasDocument(document, 0n);
    expect(parts.annotations.map((item) => item.nodeId)).toEqual([stickyId]);
  });
});
