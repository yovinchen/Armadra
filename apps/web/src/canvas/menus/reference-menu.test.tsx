import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@armadra/shared";

import { installDomPolyfills } from "@/app/test-harness";

/**
 * 「引用到 Agent」子菜单（React Flow 计划 §2.5 / F29）。
 *
 * 第一条用例是回归：这个组件最早在选择器里 `map` 出新对象，
 * `useSyncExternalStore` 每次比对都判成变了，真机上直接
 * "Maximum update depth exceeded" 把整个画布打白。React 会把那个循环抛成
 * 渲染错误，所以「菜单能打开」这一条就是它的哨兵。
 */
vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "node.sticky",
    icon: null,
    defaultSize: { width: 240, height: 200 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#ffd60a",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
  });
  return {
    NODE_META: table,
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const { useCanvasStore } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("../whiteboard/model");
const { ContextMenu, ContextMenuContent, ContextMenuTrigger } = await import(
  "@/ui/context-menu"
);
const { ReferenceSubmenu, isReferenceEdgeId } = await import(
  "./reference-menu"
);
const { EdgeMenuContent } = await import("./edge-menu");

const stamp = "2026-09-06T00:00:00.000Z";

const workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
} as Workspace;

const board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
} as Board;

function node(id: string, title: string, agent: boolean): CanvasNode {
  return {
    id,
    boardId: board.id,
    type: "terminal",
    title,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: "terminal", ...(agent ? { agent: { id: "claude" } } : {}) },
    createdAt: stamp,
    updatedAt: stamp,
  } as CanvasNode;
}

const item = {
  id: "04b138ba-c9e0-43b6-81ac-671798809c8e",
  kind: "shape" as const,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 0,
  parentId: null,
  style: { color: "black" as const, size: "m" as const },
  geo: "rectangle" as const,
};

function load(nodes: CanvasNode[], references: unknown[] = []): void {
  const document: BoardDocument = { board, nodes, edges: [] };
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(document);
  useCanvasStore
    .getState()
    .setWhiteboard(
      { ...emptyWhiteboard(), items: [item], references } as never,
      { history: "ignore" },
    );
}

function open(): void {
  render(
    <ContextMenu>
      <ContextMenuTrigger>目标</ContextMenuTrigger>
      <ContextMenuContent>
        <ReferenceSubmenu itemId={`wb:${item.id}`} />
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("目标"));
}

beforeAll(installDomPolyfills);
beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

describe("ReferenceSubmenu", () => {
  it("打开菜单不会把渲染打成死循环（选择器返回 store 里已有的数组）", () => {
    load([node("agent", "Claude Code", true)]);
    open();
    expect(screen.getByText("引用到 Agent")).toBeTruthy();
  });

  it("没有带 Agent 的终端时给一条不可点的提示", () => {
    load([node("plain", "裸终端", false)]);
    open();
    expect(screen.queryByText("引用到 Agent")).toBeNull();
    expect(screen.getByText("先创建一个 Agent 终端")).toBeTruthy();
  });

  it("已经引用过的对象不会让菜单消失（仍然列出，点它是定位）", () => {
    load(
      [node("agent", "Claude Code", true)],
      [{ id: "r1", itemId: item.id, nodeId: "agent" }],
    );
    open();
    expect(screen.getByText("引用到 Agent")).toBeTruthy();
  });
});

/**
 * 边菜单的分流（F18 的第四种 × F29）。
 *
 * 引用不在 `document.edges` 里，走 `removeEdges` 删只会静静地什么都不发生。
 * 所以「命中的是哪一种边」必须在菜单里就分开，而不是在删除动作里补救。
 */
describe("引用边的右键菜单", () => {
  const reference = { id: "r1", itemId: item.id, nodeId: "agent" };

  function openEdgeMenu(edgeId: string): void {
    render(
      <ContextMenu>
        <ContextMenuTrigger>边</ContextMenuTrigger>
        <ContextMenuContent>
          <EdgeMenuContent edgeId={edgeId} />
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("边"));
  }

  it("`isReferenceEdgeId` 只认引用行的 id", () => {
    const whiteboard = {
      ...emptyWhiteboard(),
      references: [reference],
    } as never;
    expect(isReferenceEdgeId(whiteboard, "r1")).toBe(true);
    expect(isReferenceEdgeId(whiteboard, "e1")).toBe(false);
    expect(isReferenceEdgeId(emptyWhiteboard(), "r1")).toBe(false);
  });

  it("命中引用边时给「重新同步 / 移除引用」两项，而不是「删除连线」", () => {
    load([node("agent", "Claude Code", true)], [reference]);
    openEdgeMenu("r1");
    expect(screen.getByText("重新同步引用")).toBeTruthy();
    expect(screen.getByText("移除引用")).toBeTruthy();
    expect(screen.queryByText("删除连线")).toBeNull();
  });

  it("命中普通连线时仍然只有删除一项", () => {
    load([node("agent", "Claude Code", true)], [reference]);
    openEdgeMenu("e1");
    expect(screen.getByText("删除连线")).toBeTruthy();
    expect(screen.queryByText("移除引用")).toBeNull();
  });
});
