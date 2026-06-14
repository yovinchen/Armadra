import { describe, expect, it } from "vitest";
import type {
  BoardDocument,
  CanvasEdge,
  CanvasEdgeType,
  CanvasNode,
} from "@ai-coding-canvas/shared";
import { collectContextItems } from "./context";

const timestamp = "2026-08-13T00:00:00.000Z";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";
const taskId = "019ff7d1-d1e2-780e-86f4-71a2296a8012";
const noteId = "019ff7d1-df88-77c1-b9dc-e07d15e684ba";
const contextId = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";
const terminalId = "019ff7d1-5f72-7cc3-953f-12d9e0cf023d";
const agentId = "019ff7d1-ab76-728d-be18-3acfd6181af8";

function makeNode(id: string, data: CanvasNode["data"]): CanvasNode {
  return {
    id,
    boardId,
    type: data.kind,
    position: { x: 0, y: 0 },
    zoom: "normal",
    data,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeEdge(
  id: string,
  sourceNodeId: string,
  type: CanvasEdgeType,
): CanvasEdge {
  return {
    id,
    boardId,
    sourceNodeId,
    targetNodeId: agentId,
    type,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const document: BoardDocument = {
  board: {
    id: boardId,
    workspaceId: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
    name: "Default",
    sortOrder: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  nodes: [
    makeNode(taskId, {
      kind: "task",
      title: "Fix startup",
      description: "修复启动白屏",
      status: "idle",
      checklist: [],
    }),
    makeNode(noteId, {
      kind: "note",
      title: "决策",
      content: "先修状态栏",
      status: "idle",
    }),
    makeNode(contextId, {
      kind: "context",
      title: "src",
      path: "apps/web/src",
      includePatterns: [],
      excludePatterns: [],
      status: "idle",
    }),
    makeNode(terminalId, {
      kind: "terminal",
      title: "Shell",
      cwd: ".",
      shell: "/bin/zsh",
      status: "idle",
    }),
    makeNode(agentId, {
      kind: "agent",
      title: "Codex",
      adapter: "codex",
      command: "codex",
      args: [],
      projectPath: ".",
      status: "idle",
      contextChips: [
        {
          id: "chip-1",
          kind: "text",
          label: "粘贴片段",
          value: "复现步骤",
        },
      ],
    }),
  ],
  edges: [
    makeEdge("019ff7d1-9e6d-7d45-aa28-4d125ac12fd2", taskId, "dispatch"),
    makeEdge("019ff7d1-9e6d-7d45-aa28-4d125ac12fd3", noteId, "ref"),
    makeEdge("019ff7d1-9e6d-7d45-aa28-4d125ac12fd4", contextId, "ref"),
    // trigger is control flow, not context: it must not leak into the prompt.
    makeEdge("019ff7d1-9e6d-7d45-aa28-4d125ac12fd5", terminalId, "trigger"),
  ],
  strokes: [],
};

describe("collectContextItems", () => {
  it("collects ref and dispatch sources plus the agent's own chips", () => {
    expect(collectContextItems(document, agentId)).toEqual([
      {
        nodeId: taskId,
        kind: "task",
        title: "Fix startup",
        value: "修复启动白屏",
      },
      { nodeId: noteId, kind: "note", title: "决策", value: "先修状态栏" },
      {
        nodeId: contextId,
        kind: "context",
        title: "src",
        value: "apps/web/src",
      },
      { nodeId: agentId, kind: "text", title: "粘贴片段", value: "复现步骤" },
    ]);
  });

  it("ignores nodes that carry no transferable context", () => {
    const items = collectContextItems(document, agentId);
    expect(items.some((item) => item.nodeId === terminalId)).toBe(false);
  });

  it("returns nothing for a node that is not an agent", () => {
    expect(collectContextItems(document, terminalId)).toEqual([]);
  });
});
