import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { useFlowNodes } from "./use-flow-nodes";

const now = "2026-01-01T00:00:00.000Z";
const node = (id: string, type: CanvasNode["type"]): CanvasNode => ({
  id,
  boardId: "board",
  type,
  title: id,
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  size: { width: 240, height: 200 },
  labels: [],
  note: "",
  data:
    type === "sticky"
      ? { kind: "sticky", content: "" }
      : ({ kind: type } as never),
  createdAt: now,
  updatedAt: now,
});

const document: BoardDocument = {
  board: {
    id: "board",
    workspaceId: "ws",
    name: "b",
    sortOrder: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    whiteboard: "",
    createdAt: now,
    updatedAt: now,
  } as Board,
  nodes: [node("a", "sticky"), node("b", "sticky")],
  edges: [
    {
      id: "e1",
      boardId: "board",
      source: "a",
      target: "b",
      kind: "link",
      createdAt: now,
      updatedAt: now,
    },
  ],
};

beforeEach(() => {
  useCanvasStore.setState({
    selectedNodeIds: [],
    selectedEdgeIds: [],
    selectedItemIds: [],
  });
  useCanvasStore.getState().setWorkspace({ id: "ws" } as Workspace);
  useCanvasStore.getState().setDocument(document);
});
afterEach(cleanup);

describe("useFlowNodes", () => {
  /**
   * 只改边的选区时节点表的身份必须不变。换了身份 React Flow 的
   * `StoreUpdater` 就多跑一次 `setNodes`，那一次会把「节点新 + 边旧」的半成品
   * 喂给选区监听器，边在选中 / 没选中之间来回弹直到 React 白屏。
   */
  it("只改边的选区，nodes 数组身份不变", () => {
    const { result } = renderHook(() => useFlowNodes());
    const before = result.current.nodes;

    act(() => {
      useCanvasStore.getState().setSelection({ edges: ["e1"] });
    });

    expect(
      result.current.edges.find((edge) => edge.id === "e1")?.selected,
    ).toBe(true);
    expect(result.current.nodes).toBe(before);
  });

  /** 反过来同理：只改节点的选区不该重建边表。 */
  it("只改节点的选区，edges 数组身份不变", () => {
    const { result } = renderHook(() => useFlowNodes());
    const before = result.current.edges;

    act(() => {
      useCanvasStore.getState().selectNodes(["a"]);
    });

    expect(result.current.nodes.find((item) => item.id === "a")?.selected).toBe(
      true,
    );
    expect(result.current.edges).toBe(before);
  });

  /**
   * 选区只从 `onNodesChange` / `onEdgesChange` 两条变更流写回。
   * React Flow 的 `onSelectionChange` 慢一帧，照着它写回就是自激。
   */
  it("不再向 React Flow 交出 onSelectionChange", () => {
    const { result } = renderHook(() => useFlowNodes());
    expect("onSelectionChange" in result.current).toBe(false);
  });
});
