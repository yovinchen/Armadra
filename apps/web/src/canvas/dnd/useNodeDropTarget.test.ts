import { beforeEach, describe, expect, it } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../../store/canvas-store";
import { attachToAgent } from "./useNodeDropTarget";
import { getDropHint, setDropHint } from "./hint";

const timestamp = "2026-09-02T00:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
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

const agent: CanvasNode = {
  id: "019ff7d1-7419-74df-89e2-b1619d36eaaa",
  boardId: board.id,
  type: "agent",
  position: { x: 600, y: 200 },
  size: { width: 430, height: 600 },
  zoom: "normal",
  data: {
    kind: "agent",
    title: "Agent",
    status: "idle",
    adapter: "custom",
    projectPath: "/repo",
    command: "",
    args: [],
    contextChips: [],
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};

const t = (key: string) => key;

function seed(nodes: CanvasNode[] = [agent]) {
  const document: BoardDocument = { board, nodes, edges: [], strokes: [] };
  useCanvasStore.setState({
    workspace,
    boards: [board],
    boardId: board.id,
    document,
    selectedNodeId: null,
    saveState: "saved",
  });
}

beforeEach(() => seed());

describe("attachToAgent", () => {
  it("creates the node left of the Agent, links it and adds a chip", () => {
    attachToAgent(
      agent.id,
      { kind: "file", path: "src/login.ts", name: "login.ts", size: 20 },
      t,
    );

    const state = useCanvasStore.getState();
    const created = state.document!.nodes.find((node) => node.id !== agent.id)!;
    expect(created.type).toBe("file");
    // Prototype `dropOnNode`: (agent.x - 320, agent.y + 40).
    expect(created.position).toEqual({ x: 280, y: 240 });
    // The Agent stays the inspector subject.
    expect(state.selectedNodeId).toBeNull();

    const edge = state.document!.edges[0]!;
    expect(edge).toMatchObject({
      sourceNodeId: created.id,
      targetNodeId: agent.id,
      type: "ref",
    });

    const updated = state.document!.nodes.find((node) => node.id === agent.id)!;
    expect(updated.data.kind === "agent" && updated.data.contextChips).toEqual([
      {
        id: expect.any(String),
        kind: "file",
        label: "login.ts",
        value: "src/login.ts",
      },
    ]);
  });

  it("uses a Context node and a context chip for folders", () => {
    attachToAgent(agent.id, { kind: "folder", path: "src", name: "src" }, t);
    const state = useCanvasStore.getState();
    const created = state.document!.nodes.find((node) => node.id !== agent.id)!;
    expect(created.type).toBe("context");
    const updated = state.document!.nodes.find((n) => n.id === agent.id)!;
    expect(
      updated.data.kind === "agent" && updated.data.contextChips[0]?.kind,
    ).toBe("context");
  });

  it("does not add the same path twice", () => {
    const payload = {
      kind: "file",
      path: "src/login.ts",
      name: "login.ts",
      size: 20,
    } as const;
    attachToAgent(agent.id, payload, t);
    attachToAgent(agent.id, payload, t);
    const updated = useCanvasStore
      .getState()
      .document!.nodes.find((node) => node.id === agent.id)!;
    expect(
      updated.data.kind === "agent" && updated.data.contextChips,
    ).toHaveLength(1);
  });

  it("ignores unknown or non-Agent targets", () => {
    const note: CanvasNode = {
      ...agent,
      id: "019ff7d1-7419-74df-89e2-b1619d36ebbb",
      type: "note",
      data: { kind: "note", title: "n", status: "idle", content: "" },
    };
    seed([note]);
    attachToAgent(note.id, { kind: "folder", path: "src", name: "src" }, t);
    attachToAgent("missing", { kind: "folder", path: "src", name: "src" }, t);
    expect(useCanvasStore.getState().document!.nodes).toHaveLength(1);
  });
});

describe("drop hint store", () => {
  it("shares one hint between the stage and the node layers", () => {
    const seen: (string | null)[] = [];
    setDropHint("松开创建 File 节点");
    seen.push(getDropHint());
    setDropHint("松开加入 Agent 上下文并自动连线");
    seen.push(getDropHint());
    setDropHint(null);
    seen.push(getDropHint());
    expect(seen).toEqual([
      "松开创建 File 节点",
      "松开加入 Agent 上下文并自动连线",
      null,
    ]);
  });
});
