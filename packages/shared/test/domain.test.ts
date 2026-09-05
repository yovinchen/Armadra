import { describe, expect, it } from "vitest";
import {
  DEFAULT_NODE_COLOR,
  EDGE_KINDS,
  NODE_COLORS,
  NODE_TYPES,
  agentStatusSchema,
  boardDocumentSchema,
  boardSchema,
  canvasEdgeSchema,
  canvasNodeSchema,
  editorNodeDataSchema,
  workspaceSchema,
} from "../src/index.js";

const timestamp = "2026-08-13T00:00:00.000Z";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const nodeId = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";
const otherNodeId = "019ff7d1-5c48-7d75-a0ed-64b52f44e215";
const groupId = "019ff7d1-5c48-7d75-a0ed-64b52f44e216";

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: nodeId,
    boardId,
    type: "sticky",
    title: "Sticky",
    position: { x: 0, y: 0 },
    data: { kind: "sticky", content: "hello" },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("canvas domain v3", () => {
  it("exposes the v3 enumerations as arrays for the UI", () => {
    expect(NODE_TYPES).toEqual([
      "terminal",
      "sticky",
      "group",
      "editor",
      "diff",
      "files",
      "browser",
    ]);
    expect(NODE_TYPES).not.toContain("agent");
    expect(NODE_TYPES).not.toContain("log");
    expect(EDGE_KINDS).toEqual(["link"]);
    expect(NODE_COLORS).toHaveLength(7);
    expect(NODE_COLORS.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(
      true,
    );
    expect(DEFAULT_NODE_COLOR).toBe("#0a84ff");
  });

  it("rejects a node whose data kind does not match its type", () => {
    const result = canvasNodeSchema.safeParse(
      node({ type: "editor", data: { kind: "sticky", content: "" } }),
    );
    expect(result.success).toBe(false);
  });

  it("defaults the node colour and keeps status/zoom out of the model", () => {
    const result = canvasNodeSchema.safeParse(node());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.color).toBe(DEFAULT_NODE_COLOR);
    expect(result.data).not.toHaveProperty("zoom");
    expect(result.data.data).not.toHaveProperty("status");
  });

  it("accepts every v3 node payload", () => {
    const payloads: Record<string, unknown>[] = [
      {
        kind: "terminal",
        cwd: "/tmp",
        shell: "/bin/zsh",
        agent: {
          id: "claude",
          permissionMode: "auto-edit",
          model: "opus",
          initialCommand: "claude --permission-mode acceptEdits",
        },
      },
      { kind: "sticky", content: "note" },
      { kind: "group" },
      { kind: "editor", path: "src/App.tsx", language: "tsx", readonly: false },
      { kind: "diff", repoPath: ".", scope: "staged", paths: ["a.ts"] },
      { kind: "files", path: "src" },
      { kind: "browser", url: "https://example.com" },
    ];
    for (const data of payloads) {
      const parsed = canvasNodeSchema.safeParse(
        node({ type: data.kind, title: String(data.kind), data }),
      );
      expect(parsed.success, `${String(data.kind)} rejected`).toBe(true);
    }
    expect(payloads).toHaveLength(NODE_TYPES.length);
  });

  it("rejects unknown agent ids but accepts custom ones", () => {
    const withCustom = canvasNodeSchema.safeParse(
      node({
        type: "terminal",
        data: { kind: "terminal", agent: { id: "custom:mytool" } },
      }),
    );
    expect(withCustom.success).toBe(true);

    const withUnknown = canvasNodeSchema.safeParse(
      node({
        type: "terminal",
        data: { kind: "terminal", agent: { id: "wat" } },
      }),
    );
    expect(withUnknown.success).toBe(false);
  });

  it("carries group membership through parentId", () => {
    const parsed = canvasNodeSchema.parse(node({ parentId: groupId }));
    expect(parsed.parentId).toBe(groupId);
    expect(canvasNodeSchema.safeParse(node({ parentId: nodeId })).success).toBe(
      false,
    );
  });

  it("persists exactly one edge kind", () => {
    const parsed = canvasEdgeSchema.parse({
      id: groupId,
      boardId,
      source: nodeId,
      target: otherNodeId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(parsed.kind).toBe("link");
    expect(
      canvasEdgeSchema.safeParse({
        id: groupId,
        boardId,
        source: nodeId,
        target: otherNodeId,
        kind: "dispatch",
        createdAt: timestamp,
        updatedAt: timestamp,
      }).success,
    ).toBe(false);
  });

  it("drops strokes from the board document", () => {
    const document = boardDocumentSchema.parse({
      board: {
        id: boardId,
        workspaceId: nodeId,
        name: "Default",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      nodes: [],
      edges: [],
    });
    expect(document).not.toHaveProperty("strokes");
    expect(document.board.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("keeps the workspace fields but not the gateway flag", () => {
    const workspace = workspaceSchema.parse({
      id: nodeId,
      name: "Canvas",
      rootPath: "/tmp",
      lastOpenedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(workspace.permissions.read).toBe(true);
    expect(workspace).not.toHaveProperty("gatewayEnabled");
  });
});

describe("agent status", () => {
  it("carries the optional hook context on an agent status", () => {
    const base = {
      nodeId: "019ff7d1-5c48-7d75-a0ed-64b52f44e214",
      workspaceId: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
      agentId: "claude",
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    // Every new key is optional: a runtime that reports none still parses.
    const minimal = agentStatusSchema.parse(base);
    expect(minimal.transcriptPath).toBeUndefined();
    expect(minimal.lastEventAt).toBeUndefined();
    expect(minimal.sessionPhase).toBeUndefined();
    expect(minimal.lastMessage).toBeUndefined();

    const full = agentStatusSchema.parse({
      ...base,
      transcriptPath: "/home/u/.claude/projects/x/abc.jsonl",
      lastEventAt: "2026-09-04T00:00:01.000Z",
      sessionPhase: "start",
      lastMessage: "done",
    });
    expect(full.sessionPhase).toBe("start");
    expect(full.transcriptPath).toContain("abc.jsonl");

    expect(
      agentStatusSchema.safeParse({ ...base, sessionPhase: "middle" }).success,
    ).toBe(false);
    expect(
      agentStatusSchema.safeParse({ ...base, lastEventAt: "not a date" })
        .success,
    ).toBe(false);
  });
});

describe("retired board state, labels and notes", () => {
  const board = {
    id: boardId,
    workspaceId: "019ff7d1-7419-74df-89e2-b1619d36ea99",
    name: "Default",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  it("gives a v3 board and node the empty defaults", () => {
    // A document written before migration 0008 has none of the three keys and
    // must still parse — that is what keeps the upgrade from rewriting rows.
    const parsedBoard = boardSchema.parse(board);
    expect("kanban" in parsedBoard).toBe(false);

    const parsedNode = canvasNodeSchema.parse(node());
    expect(parsedNode.labels).toEqual([]);
    expect(parsedNode.note).toBe("");
  });

  it("reads older responses without retaining writable task-board state", () => {
    const parsed = boardSchema.parse({
      ...board,
      kanban: { columns: [{ id: "old", title: "Old" }], cards: {} },
    });
    expect("kanban" in parsed).toBe(false);
  });

  it("bounds labels at eight short chips and the note at 4000 characters", () => {
    expect(
      canvasNodeSchema.parse(node({ labels: ["  ship  ", "P0"] })).labels,
    ).toEqual(["ship", "P0"]);
    expect(
      canvasNodeSchema.safeParse(node({ labels: Array(9).fill("x") })).success,
    ).toBe(false);
    expect(
      canvasNodeSchema.safeParse(node({ labels: ["x".repeat(25)] })).success,
    ).toBe(false);
    expect(canvasNodeSchema.safeParse(node({ labels: [""] })).success).toBe(
      false,
    );
    expect(
      canvasNodeSchema.safeParse(node({ note: "n".repeat(4_000) })).success,
    ).toBe(true);
    expect(
      canvasNodeSchema.safeParse(node({ note: "n".repeat(4_001) })).success,
    ).toBe(false);
  });

  it("reserves a language-service field that can only say it is unavailable", () => {
    // Absent on every node today — there is no LSP to report.
    expect(
      editorNodeDataSchema.parse({ kind: "editor", path: "a.ts" })
        .languageService,
    ).toBeUndefined();
    expect(
      editorNodeDataSchema.parse({
        kind: "editor",
        path: "a.ts",
        languageService: { status: "unavailable", reason: "not_implemented" },
      }).languageService?.status,
    ).toBe("unavailable");
    // A node file cannot assert capabilities the product does not have.
    expect(
      editorNodeDataSchema.safeParse({
        kind: "editor",
        path: "a.ts",
        languageService: { status: "ready" },
      }).success,
    ).toBe(false);
  });
});
