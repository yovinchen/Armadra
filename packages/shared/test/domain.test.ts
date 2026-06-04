import { describe, expect, it } from "vitest";
import {
  EDGE_TYPES,
  NODE_STATUSES,
  NODE_TYPES,
  boardDocumentSchema,
  buildContextPrompt,
  canvasNodeSchema,
  gitStatusSchema,
  migrateLegacyEdgeType,
  migrateLegacyNodeStatus,
  migrateLegacyNodeType,
  projectEdge,
  projectNode,
  strokeSchema,
  workspaceSchema,
  type CanvasEdge,
  type CanvasNode,
  type ContextItem,
} from "../src/index.js";

const timestamp = "2026-08-13T00:00:00.000Z";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const nodeId = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";

describe("canvas domain", () => {
  it("exposes the v2 enumerations as arrays for the UI", () => {
    expect(NODE_TYPES).toHaveLength(10);
    expect(NODE_TYPES).toContain("context");
    expect(NODE_TYPES).not.toContain("folder");
    expect(EDGE_TYPES).toEqual([
      "link",
      "dispatch",
      "produce",
      "write",
      "trigger",
      "ref",
    ]);
    expect(NODE_STATUSES).toContain("error");
    expect(NODE_STATUSES).not.toContain("failed");
  });

  it("rejects a node whose data kind does not match its type", () => {
    const result = canvasNodeSchema.safeParse({
      id: nodeId,
      boardId,
      type: "file",
      position: { x: 0, y: 0 },
      data: {
        kind: "task",
        title: "Mismatch",
        status: "idle",
        description: "This must fail",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(result.success).toBe(false);
  });

  it("defaults a node to the normal display mode", () => {
    const result = canvasNodeSchema.safeParse({
      id: nodeId,
      boardId,
      type: "note",
      position: { x: 0, y: 0 },
      data: { kind: "note", title: "Note", content: "" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.zoom).toBe("normal");
    expect(result.success && result.data.data.status).toBe("idle");
  });

  it("keeps oversized inline images out of the document", () => {
    const oversized = `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}`;
    const result = canvasNodeSchema.safeParse({
      id: nodeId,
      boardId,
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        kind: "image",
        title: "Screenshot",
        src: oversized,
        mimeType: "image/png",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(result.success).toBe(false);
  });

  it("projects semantic edges without leaking permissions into the renderer", () => {
    const edge: CanvasEdge = {
      id: "019ff7d1-9e6d-7d45-aa28-4d125ac12fd2",
      boardId,
      sourceNodeId: nodeId,
      targetNodeId: "019ff7d1-ab76-728d-be18-3acfd6181af8",
      type: "ref",
      label: "只读引用",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const projection = projectEdge(edge);
    expect(projection).toMatchObject({
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      type: "semantic",
      data: { semanticType: "ref", label: "只读引用" },
    });
    expect(projection.data).not.toHaveProperty("permissions");
  });

  it("projects the display mode and board so the canvas can enforce summaries", () => {
    const node: CanvasNode = {
      id: nodeId,
      boardId,
      type: "task",
      position: { x: 80, y: 80 },
      zoom: "focus",
      data: {
        kind: "task",
        title: "Move anywhere",
        status: "idle",
        description: "",
        checklist: [],
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(projectNode(node)).toMatchObject({ zoom: "focus", boardId });
    expect(projectNode(node)).not.toHaveProperty("dragHandle");
  });

  it("allows an incomplete custom adapter configuration to be saved", () => {
    const result = canvasNodeSchema.safeParse({
      id: nodeId,
      boardId,
      type: "agent",
      position: { x: 0, y: 0 },
      data: {
        kind: "agent",
        title: "Custom agent",
        status: "idle",
        adapter: "custom",
        projectPath: ".",
        command: "",
        args: [],
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.data).toMatchObject({
      contextChips: [],
    });
  });

  it("defaults stroke width and board viewport", () => {
    const stroke = strokeSchema.parse({
      id: "019ff7d1-ab76-728d-be18-3acfd6181af8",
      color: "#5B5BD6",
      points: [{ x: 0, y: 0 }],
    });
    expect(stroke.width).toBe(3);

    const document = boardDocumentSchema.parse({
      board: {
        id: boardId,
        workspaceId: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
        name: "Default",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      nodes: [],
      edges: [],
    });
    expect(document.board.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(document.board.sortOrder).toBe(0);
    expect(document.strokes).toEqual([]);
  });

  it("gives a workspace the permission and gateway fields the shell renders", () => {
    const workspace = workspaceSchema.parse({
      id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
      name: "One",
      rootPath: "/tmp/one",
      lastOpenedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(workspace).toMatchObject({
      gatewayEnabled: false,
      permissions: { read: true, write: true, execute: true },
    });
    expect(workspace.color).toMatch(/^#/);
  });
});

describe("legacy mapping", () => {
  it("renames folder nodes and failed statuses", () => {
    expect(migrateLegacyNodeType("folder")).toBe("context");
    expect(migrateLegacyNodeType("agent")).toBe("agent");
    expect(migrateLegacyNodeStatus("failed")).toBe("error");
    expect(migrateLegacyNodeStatus("running")).toBe("running");
  });

  it("maps every v1 edge semantic onto a v2 semantic", () => {
    expect(migrateLegacyEdgeType("context")).toBe("ref");
    expect(migrateLegacyEdgeType("input")).toBe("dispatch");
    expect(migrateLegacyEdgeType("output")).toBe("produce");
    expect(migrateLegacyEdgeType("patches")).toBe("write");
    expect(migrateLegacyEdgeType("depends_on")).toBe("trigger");
    expect(migrateLegacyEdgeType("verifies")).toBe("link");
    expect(migrateLegacyEdgeType("nonsense")).toBe("link");
  });
});

describe("git status", () => {
  // The runtime omits ahead/behind when there is no upstream, but a stale
  // binary sends them as null. Both must parse: a topbar that throws here
  // loses the branch name and the changed-count badge entirely.
  it("accepts every shape the runtime reports", () => {
    expect(
      gitStatusSchema.parse({
        repository: false,
        branch: null,
        changedCount: 0,
      }),
    ).toMatchObject({ repository: false, branch: null });

    expect(
      gitStatusSchema.parse({
        repository: true,
        branch: "main",
        changedCount: 221,
      }).ahead,
    ).toBeUndefined();

    expect(
      gitStatusSchema.parse({
        repository: true,
        branch: "main",
        changedCount: 221,
        ahead: null,
        behind: null,
      }).ahead,
    ).toBeNull();

    expect(
      gitStatusSchema.parse({
        repository: true,
        branch: "main",
        changedCount: 3,
        ahead: 1,
        behind: 2,
      }),
    ).toMatchObject({ ahead: 1, behind: 2 });
  });

  it("still rejects a missing branch key", () => {
    expect(
      gitStatusSchema.safeParse({ repository: true, changedCount: 0 }).success,
    ).toBe(false);
  });
});

describe("context prompt", () => {
  it("uses task text and paths without injecting file contents", () => {
    const items: ContextItem[] = [
      {
        nodeId: "019ff7d1-d1e2-780e-86f4-71a2296a8012",
        kind: "task",
        title: "Task",
        value: "修复启动白屏",
      },
      {
        nodeId: "019ff7d1-df88-77c1-b9dc-e07d15e684ba",
        kind: "file",
        title: "App.tsx",
        value: "src/App.tsx",
      },
    ];

    const prompt = buildContextPrompt(items);
    expect(prompt).toContain("修复启动白屏");
    expect(prompt).toContain("src/App.tsx");
    expect(prompt).toContain("危险操作");
  });

  it("renders the new note / browser / context / text kinds", () => {
    const prompt = buildContextPrompt([
      {
        nodeId: "019ff7d1-d1e2-780e-86f4-71a2296a8012",
        kind: "context",
        title: "src",
        value: "apps/web/src",
      },
      {
        nodeId: "019ff7d1-df88-77c1-b9dc-e07d15e684ba",
        kind: "note",
        title: "决策",
        value: "先修状态栏",
      },
      {
        nodeId: "019ff7d1-ab76-728d-be18-3acfd6181af8",
        kind: "browser",
        title: "React Flow",
        value: "https://reactflow.dev",
      },
      {
        nodeId: "019ff7d1-9e6d-7d45-aa28-4d125ac12fd2",
        kind: "text",
        title: "片段",
        value: "粘贴的片段",
      },
    ]);

    expect(prompt).toContain("apps/web/src");
    expect(prompt).toContain("笔记");
    expect(prompt).toContain("先修状态栏");
    expect(prompt).toContain("参考网页");
    expect(prompt).toContain("https://reactflow.dev");
    expect(prompt).toContain("补充上下文");
    expect(prompt).toContain("粘贴的片段");
  });
});
