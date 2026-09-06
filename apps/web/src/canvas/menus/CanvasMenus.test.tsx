import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CanvasEdge, CanvasNode, Workspace } from "@armadra/shared";
import { ContextMenu, ContextMenuTrigger } from "@/ui/context-menu";

/**
 * 右键菜单的分流（React Flow 计划 F18）。
 *
 * 四种目标各一套内容：空白 = 新建菜单、节点 = 节点菜单、白板对象 = 对象
 * 菜单、边 = 删除连线。分流不靠我们自己命中测试，靠 React Flow 的四个
 * 回调——所以这里直接调那四个回调，断言展开的是哪一套。
 */

const now = "2026-09-06T00:00:00.000Z";
const workspace: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha",
  rootPath: "/tmp/alpha",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: now,
  createdAt: now,
  updatedAt: now,
};

const node: CanvasNode = {
  id: "22222222-2222-4222-8222-222222222222",
  boardId: "33333333-3333-4333-8333-333333333333",
  type: "sticky",
  title: "便签",
  color: "#ffd60a",
  position: { x: 0, y: 0 },
  size: { width: 240, height: 200 },
  labels: [],
  note: "",
  data: { kind: "sticky", content: "" },
  createdAt: now,
  updatedAt: now,
};

const edge: CanvasEdge = {
  id: "44444444-4444-4444-8444-444444444444",
  boardId: node.boardId,
  source: node.id,
  target: node.id,
  kind: "link",
  createdAt: now,
  updatedAt: now,
};

const state = {
  workspace,
  document: { nodes: [node], edges: [edge] },
  selectedNodeIds: [] as string[],
  selectedItemIds: [] as string[],
  selectedEdgeIds: [] as string[],
  maximized: {} as Record<string, unknown>,
  addNode: vi.fn(),
  removeEdges: vi.fn(),
  selectNodes: vi.fn(),
  setParent: vi.fn(),
  duplicateNodes: vi.fn(),
  setCollapsed: vi.fn(),
  updateNodeData: vi.fn(),
};

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (value: typeof state) => T) =>
    selector(state);
  useCanvasStore.getState = () => state;
  return { useCanvasStore };
});

vi.mock("@/app/use-agents", () => ({ useEnabledAgents: () => [] }));

/** `screenToFlowPosition` 只在挂载后的画布上有；这里给一个恒等替身。 */
vi.mock("../flow/flow-context", () => ({
  getFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  }),
}));

vi.mock("../whiteboard/store", () => ({
  reorder: vi.fn(),
  removeItems: vi.fn(),
  addItems: vi.fn(() => []),
  select: vi.fn(),
  createItemId: () => "copy-1",
  itemsByIds: () => [],
}));

const { installDomPolyfills, TestProviders } = await import(
  "@/app/test-harness"
);
const { targetForNodeId, targetForSelection, useCanvasMenus } = await import(
  "./CanvasMenus"
);

installDomPolyfills();
afterEach(cleanup);

type Handlers = ReturnType<typeof useCanvasMenus>["handlers"];

let handlers: Handlers;

function Harness() {
  const { handlers: bound, menus } = useCanvasMenus();
  handlers = bound;
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div data-testid="stage" />
      </ContextMenuTrigger>
      {menus}
    </ContextMenu>
  );
}

/** 先设目标（RF 的回调），再右键（Radix 开菜单）——真实顺序就是这样。 */
function openWith(set: () => void) {
  render(
    <TestProviders>
      <Harness />
    </TestProviders>,
  );
  act(set);
  fireEvent.contextMenu(screen.getByTestId("stage"));
}

const mouse = { clientX: 40, clientY: 60 } as React.MouseEvent;

describe("targetForNodeId", () => {
  it("`wb:` 前缀是白板对象，其余是文档节点", () => {
    expect(targetForNodeId("wb:abc")).toEqual({
      kind: "item",
      itemId: "wb:abc",
    });
    expect(targetForNodeId(node.id)).toEqual({ kind: "node", nodeId: node.id });
  });
});

describe("targetForSelection", () => {
  it("混合选区以节点为准（节点菜单才能一次删完）", () => {
    expect(targetForSelection(["wb:a", node.id])).toEqual({
      kind: "node",
      nodeId: node.id,
    });
  });

  it("全是白板对象时给对象菜单", () => {
    expect(targetForSelection(["wb:a", "wb:b"])).toEqual({
      kind: "item",
      itemId: "wb:a",
    });
  });

  it("空选区退回新建菜单", () => {
    expect(targetForSelection([])).toEqual({ kind: "pane" });
  });
});

describe("useCanvasMenus", () => {
  beforeEach(() => {
    state.selectedNodeIds = [];
    state.selectedItemIds = [];
    state.selectedEdgeIds = [];
    state.removeEdges.mockClear();
  });

  it("空白右键 → 新建菜单", () => {
    openWith(() => handlers.onPaneContextMenu(mouse));
    expect(screen.getByText("新建终端")).toBeTruthy();
  });

  it("节点右键 → 节点菜单", () => {
    openWith(() => handlers.onNodeContextMenu(mouse, { id: node.id } as never));
    expect(screen.getByText("复制")).toBeTruthy();
    expect(screen.queryByText("新建终端")).toBeNull();
  });

  it("白板对象右键 → 对象菜单", () => {
    openWith(() =>
      handlers.onNodeContextMenu(mouse, { id: "wb:abc" } as never),
    );
    expect(screen.getByText("置顶")).toBeTruthy();
    expect(screen.queryByText("新建终端")).toBeNull();
  });

  it("边右键 → 只有「删除连线」，点它就删", () => {
    openWith(() => handlers.onEdgeContextMenu(mouse, { id: edge.id } as never));
    const remove = screen.getByText("删除连线");
    fireEvent.click(remove);
    expect(state.removeEdges).toHaveBeenCalledWith([edge.id]);
  });

  it("混合选区的多选框右键给节点菜单", () => {
    openWith(() =>
      handlers.onSelectionContextMenu(mouse, [
        { id: "wb:abc" },
        { id: node.id },
      ] as never),
    );
    expect(screen.getByText("删除")).toBeTruthy();
    // 对象菜单那一套（层级）不该出现：它只认白板那一半，删不干净。
    expect(screen.queryByText("置顶")).toBeNull();
  });

  /** 节点在菜单展开前被远端删掉时不该弹一个空菜单。 */
  it("目标节点不在文档里时退回新建菜单", () => {
    openWith(() =>
      handlers.onNodeContextMenu(mouse, { id: "missing" } as never),
    );
    expect(screen.getByText("新建终端")).toBeTruthy();
  });
});
