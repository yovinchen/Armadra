import { beforeEach, describe, expect, it } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@ai-coding-canvas/shared";
import {
  DEFAULT_NODE_SIZES,
  inferEdgeType,
  useCanvasStore,
} from "./canvas-store";

const timestamp = "2026-08-13T00:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  gatewayEnabled: false,
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const document: BoardDocument = {
  board,
  nodes: [],
  edges: [],
  strokes: [],
};

function node(
  id: string,
  type: CanvasNode["type"],
): Pick<CanvasNode, "id" | "type"> {
  return { id, type };
}

function reset() {
  useCanvasStore.setState({
    workspace,
    boards: [board],
    boardId: board.id,
    document,
    selectedNodeId: null,
    saveState: "saved",
    saveError: null,
    tool: "select",
    modal: null,
  });
}

describe("canvas store workspace boundary", () => {
  beforeEach(reset);

  it("atomically clears prior board state when switching workspace", () => {
    useCanvasStore.setState({
      selectedNodeId: "019ff7d1-d1e2-780e-86f4-71a2296a8012",
      saveState: "dirty",
    });
    useCanvasStore.getState().setWorkspace({
      ...workspace,
      id: "019ff7d1-5f72-7cc3-953f-12d9e0cf023d",
      rootPath: "/tmp/two",
    });
    expect(useCanvasStore.getState()).toMatchObject({
      boards: [],
      boardId: null,
      document: null,
      selectedNodeId: null,
      saveState: "idle",
    });
  });

  it("drops the loaded document when the user switches board", () => {
    useCanvasStore
      .getState()
      .selectBoard("019ff7d1-5f72-7cc3-953f-12d9e0cf023d");
    expect(useCanvasStore.getState()).toMatchObject({
      boardId: "019ff7d1-5f72-7cc3-953f-12d9e0cf023d",
      document: null,
      saveState: "idle",
    });
  });

  it("keeps the open board when the board list is refreshed", () => {
    useCanvasStore.getState().setBoards([{ ...board, name: "Renamed" }]);
    expect(useCanvasStore.getState().document).not.toBeNull();
    expect(useCanvasStore.getState().boards[0]?.name).toBe("Renamed");
  });
});

describe("node lifecycle", () => {
  beforeEach(reset);

  it("adds a node with the design default size and selects it", () => {
    const added = useCanvasStore
      .getState()
      .addNode({ kind: "note", title: "Note", status: "idle", content: "" });

    expect(added).not.toBeNull();
    expect(added?.size).toEqual(DEFAULT_NODE_SIZES.note);
    expect(added?.size).toEqual({ width: 260, height: 180 });
    expect(added?.zoom).toBe("normal");
    expect(added?.boardId).toBe(board.id);
    expect(useCanvasStore.getState().selectedNodeId).toBe(added?.id);
    expect(useCanvasStore.getState().saveState).toBe("dirty");
  });

  it("honours an explicit size and suppressed selection", () => {
    const added = useCanvasStore
      .getState()
      .addNode(
        { kind: "note", title: "Note", status: "idle", content: "" },
        { x: 10, y: 20 },
        { size: { width: 100, height: 90 }, zoom: "mini", select: false },
      );

    expect(added).toMatchObject({
      position: { x: 10, y: 20 },
      size: { width: 100, height: 90 },
      zoom: "mini",
    });
    expect(useCanvasStore.getState().selectedNodeId).toBeNull();
  });

  it("keeps a single focused node", () => {
    const store = useCanvasStore.getState();
    const first = store.addNode({
      kind: "note",
      title: "A",
      status: "idle",
      content: "",
    })!;
    const second = store.addNode({
      kind: "note",
      title: "B",
      status: "idle",
      content: "",
    })!;

    useCanvasStore.getState().setNodeZoom(first.id, "focus");
    useCanvasStore.getState().setNodeZoom(second.id, "focus");
    const nodes = useCanvasStore.getState().document!.nodes;

    expect(nodes.find((item) => item.id === first.id)?.zoom).toBe("normal");
    expect(nodes.find((item) => item.id === second.id)?.zoom).toBe("focus");
  });

  it("duplicates a node without carrying its live session", () => {
    const agent = useCanvasStore.getState().addNode({
      kind: "agent",
      title: "Codex",
      status: "running",
      adapter: "codex",
      sessionId: "019ff7d1-ab76-728d-be18-3acfd6181af8",
      projectPath: ".",
      command: "codex",
      args: [],
      contextChips: [],
    })!;

    const copy = useCanvasStore.getState().duplicateNode(agent.id)!;
    expect(copy.id).not.toBe(agent.id);
    expect(copy.position).toEqual({
      x: agent.position.x + 32,
      y: agent.position.y + 32,
    });
    expect(copy.data).toMatchObject({ status: "idle", sessionId: undefined });
    expect(useCanvasStore.getState().selectedNodeId).toBe(copy.id);
  });

  it("resizes and rearranges nodes", () => {
    const added = useCanvasStore
      .getState()
      .addNode({ kind: "note", title: "Note", status: "idle", content: "" })!;

    useCanvasStore.getState().resizeNode(added.id, { width: 400, height: 300 });
    useCanvasStore.getState().arrangeNodes({ [added.id]: { x: 900, y: 40 } });

    const stored = useCanvasStore.getState().document!.nodes[0];
    expect(stored?.size).toEqual({ width: 400, height: 300 });
    expect(stored?.position).toEqual({ x: 900, y: 40 });
  });
});

describe("edges, strokes and viewport", () => {
  beforeEach(reset);

  it("refuses self links and duplicates", () => {
    const store = useCanvasStore.getState();
    const task = store.addNode({
      kind: "task",
      title: "Task",
      status: "idle",
      description: "",
      checklist: [],
    })!;
    const agent = store.addNode({
      kind: "agent",
      title: "Agent",
      status: "idle",
      adapter: "codex",
      projectPath: ".",
      command: "codex",
      args: [],
      contextChips: [],
    })!;

    expect(
      useCanvasStore.getState().addEdge(task.id, task.id, "link"),
    ).toBeNull();
    expect(
      useCanvasStore.getState().addEdge(task.id, agent.id, "dispatch"),
    ).not.toBeNull();
    expect(
      useCanvasStore.getState().addEdge(task.id, agent.id, "dispatch"),
    ).toBeNull();
    expect(useCanvasStore.getState().document!.edges).toHaveLength(1);
    expect(useCanvasStore.getState().document!.edges[0]?.boardId).toBe(
      board.id,
    );
  });

  it("records and clears strokes", () => {
    useCanvasStore.getState().addStroke({
      id: "019ff7d1-9e6d-7d45-aa28-4d125ac12fd2",
      color: "#DC4C4A",
      width: 3,
      points: [{ x: 0, y: 0 }],
    });
    expect(useCanvasStore.getState().document!.strokes).toHaveLength(1);
    expect(useCanvasStore.getState().saveState).toBe("dirty");

    useCanvasStore.setState({ saveState: "saved" });
    useCanvasStore.getState().clearStrokes();
    expect(useCanvasStore.getState().document!.strokes).toEqual([]);
    expect(useCanvasStore.getState().saveState).toBe("dirty");
  });

  it("never marks the document dirty for a pan or zoom", () => {
    useCanvasStore.getState().setViewport({ x: -120, y: 44, zoom: 0.45 });

    expect(useCanvasStore.getState().document!.board.viewport).toEqual({
      x: -120,
      y: 44,
      zoom: 0.45,
    });
    expect(useCanvasStore.getState().saveState).toBe("saved");
  });
});

describe("inferEdgeType", () => {
  it("maps the design semantics onto node pairs", () => {
    const pairs: Array<[CanvasNode["type"], CanvasNode["type"], string]> = [
      ["task", "agent", "dispatch"],
      ["file", "agent", "ref"],
      ["context", "agent", "ref"],
      ["note", "agent", "ref"],
      ["browser", "agent", "ref"],
      ["image", "agent", "ref"],
      ["log", "agent", "ref"],
      ["agent", "diff", "produce"],
      ["diff", "file", "write"],
      ["agent", "terminal", "trigger"],
      ["terminal", "agent", "trigger"],
      ["agent", "agent", "trigger"],
      ["file", "terminal", "link"],
      ["note", "note", "link"],
    ];

    for (const [source, target, expected] of pairs) {
      expect(
        inferEdgeType(
          node("a", source) as CanvasNode,
          node("b", target) as CanvasNode,
        ),
      ).toBe(expected);
    }
  });
});
