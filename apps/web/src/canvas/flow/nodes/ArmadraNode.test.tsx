import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "w1", rootPath: "/tmp" },
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  setNodeLabels: vi.fn(),
  setNodeNote: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { installDomPolyfills } from "@/app/test-harness";
import { renderFlow } from "@/canvas/test-support";
import { COLLAPSED_HEIGHT } from "@/nodes/registry";
import { ArmadraNode } from "./ArmadraNode";

/**
 * 节点承载（React Flow 计划 T03）。
 *
 * 三条：折叠钉在 40px、`NodeResizer` 按 `NODE_META.minSize` 夹住、节点体
 * 带着 `nowheel`（终端的滚轮归 tmux 桥，不缩放画布）。
 */

beforeAll(installDomPolyfills);
afterEach(cleanup);

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "n1",
    boardId: "b1",
    type: "sticky",
    title: "便签",
    color: "#ffd60a",
    position: { x: 0, y: 0 },
    size: { width: 240, height: 200 },
    labels: [],
    note: "",
    data: { kind: "sticky", content: "" },
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...patch,
  } as CanvasNode;
}

function renderNode(target = node(), selected = false) {
  return renderFlow(
    <ArmadraNode
      id={target.id}
      type="armadra"
      data={target}
      selected={selected}
      dragging={false}
      zIndex={1}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      deletable
      selectable
      draggable
    />,
    { nodeId: target.id, selected },
  );
}

describe("ArmadraNode", () => {
  it("折叠时节点体隐藏，外壳高度钉在 40px", () => {
    const { container } = renderNode(node({ collapsed: true }));
    const shell = container.querySelector(
      '[data-slot="node-shell"]',
    ) as HTMLElement;
    expect(shell.style.height).toBe(`${COLLAPSED_HEIGHT}px`);
    expect(
      (container.querySelector('[data-slot="node-body"]') as HTMLElement).style
        .display,
    ).toBe("none");
  });

  it("节点体带 `nowheel`：普通滚轮归节点体，不缩放画布", () => {
    const { container } = renderNode();
    const body = container.querySelector(
      '[data-slot="node-body"]',
    ) as HTMLElement;
    expect(body.classList.contains("nowheel")).toBe(true);
  });

  it("没选中时不画 resize 把手，选中了才画", () => {
    const { container, unmount } = renderNode(node(), false);
    expect(
      container.querySelectorAll(".react-flow__resize-control"),
    ).toHaveLength(0);
    unmount();

    const selected = renderNode(node(), true);
    expect(
      selected.container.querySelectorAll(".react-flow__resize-control").length,
    ).toBeGreaterThan(0);
  });

  it("头部是 React Flow 认的拖拽把手，选择器与 `registry` 同一个", () => {
    const { container } = renderNode();
    const header = container.querySelector(
      '[data-slot="node-header"]',
    ) as HTMLElement;
    expect(header.classList.contains("drag-handle")).toBe(true);
  });

  it("便签走通用包壳，标题渲染在头部", () => {
    renderNode();
    expect(screen.getByText("便签")).toBeTruthy();
  });
});
