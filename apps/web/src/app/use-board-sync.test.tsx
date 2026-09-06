import * as React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardDocument, Workspace } from "@armadra/shared";

/**
 * 壳的加载链里与 A04 有关的那一段（React Flow 计划 §6.3 A04）。
 *
 * 两处原来都在 `canvas/` 之外，也是 A04 判失败的两个原因：
 *
 *  1. `board.changed` 到了却没让 `["board", …]` 失效，另一个窗口永远不重取；
 *  2. 重取回来的同一块板被 `if (document?.board.id === …) return;` 直接丢掉。
 *
 * 这里跑的是真的 hook + 真的 store，只把 Runtime 那一侧换成假的。
 */

vi.mock("../nodes/registry", () => {
  const meta = {
    labelKey: "node.terminal",
    icon: null,
    defaultSize: { width: 200, height: 100 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#0a84ff",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
    has: () => true,
  });
  return {
    NODE_META: table,
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const stamp = "2026-09-06T00:00:00.000Z";
const later = "2026-09-06T00:00:05.000Z";

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
};

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
};

const NODE = "019ff7d1-1111-7000-8000-000000000001";

function document(x: number, updatedAt = stamp): BoardDocument {
  return {
    board: { ...board, updatedAt },
    nodes: [
      {
        id: NODE,
        boardId: board.id,
        type: "sticky",
        title: "note",
        color: "#ffd60a",
        position: { x, y: 0 },
        size: { width: 200, height: 100 },
        labels: [],
        note: "",
        data: { kind: "sticky", content: "" },
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    edges: [],
  } as never as BoardDocument;
}

let remote = document(0);
const loadBoard = vi.fn(async () => JSON.parse(JSON.stringify(remote)));

vi.mock("../api/client", () => ({
  runtimeApi: {
    listBoards: vi.fn(async () => [board]),
    openWorkspace: vi.fn(async () => undefined),
  },
}));

vi.mock("../canvas-ownership", () => ({
  canvasGateway: {
    loadBoard: (...args: unknown[]) => loadBoard(...(args as [])),
  },
  useCanvasOwnership: { getState: () => ({ probe: async () => undefined }) },
  useCanvasEventFollower: () => undefined,
}));

vi.mock("./workspaces-query", () => ({
  useWorkspacesQuery: () => ({ data: [workspace] }),
}));

vi.mock("../save/autosave", () => ({
  flushBoardSaves: async () => undefined,
}));

const { dispatchWorkspaceEvent, resetWorkspaceEvents } = await import(
  "../api/events"
);
const { useCanvasStore } = await import("../store/canvas-store");
const { useBoardSync } = await import("./use-board-sync");

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const positionOf = () =>
  useCanvasStore.getState().document?.nodes[0]?.position.x;

beforeEach(() => {
  remote = document(0);
  loadBoard.mockClear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  resetWorkspaceEvents();
  useCanvasStore.getState().setWorkspace(null);
});

describe("useBoardSync", () => {
  it("`board.changed` 带着别人的版本号时重取并把改动合进来", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    const reads = loadBoard.mock.calls.length;

    remote = document(515, later);
    act(() => {
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: board.id,
        updatedAt: later,
      });
    });

    await waitFor(() => expect(positionOf()).toBe(515));
    expect(loadBoard.mock.calls.length).toBeGreaterThan(reads);
    expect(useCanvasStore.getState().document?.board.updatedAt).toBe(later);
  });

  it("版本号与手里这份一样时（自己刚存的那一次）不重取", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    const reads = loadBoard.mock.calls.length;

    act(() => {
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: board.id,
        updatedAt: stamp,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadBoard.mock.calls.length).toBe(reads);
  });

  it("别的板改了不动这一块", async () => {
    renderHook(() => useBoardSync(), { wrapper });
    await waitFor(() => expect(positionOf()).toBe(0));
    const reads = loadBoard.mock.calls.length;

    act(() => {
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: "019ff7d1-7419-74df-89e2-b1619d36eaaa",
        updatedAt: later,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadBoard.mock.calls.length).toBe(reads);
  });
});
