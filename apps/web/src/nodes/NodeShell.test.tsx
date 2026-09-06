import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
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
  addNode: vi.fn(),
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
import {
  setFlow,
  setFlowContainer,
  type FlowHandle,
} from "@/canvas/flow/flow-context";
import { openNodeAnnotation } from "@/meta/annotations";
import { NodeShell } from "./NodeShell";
import { COLLAPSED_HEIGHT, HEADER_HEIGHT } from "./geometry";

beforeAll(installDomPolyfills);

function makeNode(patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "n1",
    boardId: "b1",
    type: "sticky",
    title: "便签 1",
    color: "#ffd60a",
    position: { x: 0, y: 0 },
    data: { kind: "sticky", content: "" },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...patch,
  } as CanvasNode;
}

/**
 * `NodeShell` 的把手是真的 `<Handle>`，它要 React Flow 在**节点包装层**里
 * 给的两个 context，所以壳必须挂进一个真的画布里（`canvas/test-support`）。
 */
function renderShell(
  props: Partial<React.ComponentProps<typeof NodeShell>> = {},
) {
  const node = props.node ?? makeNode();
  return renderFlow(
    <NodeShell node={node} selected={false} {...props}>
      <div>body</div>
    </NodeShell>,
    { nodeId: node.id },
  );
}

/** ⌘滚轮那条路要一个挂着的画布：一个假实例 + 一个量得出尺寸的容器。 */
function mountFlow() {
  const setViewport = vi.fn((_viewport: { zoom: number }) =>
    Promise.resolve(true),
  );
  const handle = {
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport,
  } as unknown as FlowHandle;
  const container = document.createElement("div");
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
  setFlow(handle);
  setFlowContainer(container);
  return { setViewport };
}

afterEach(() => {
  cleanup();
  setFlow(null);
  setFlowContainer(null);
  vi.clearAllMocks();
});

describe("NodeShell", () => {
  it("uses the shared header geometry and keeps the body mounted across collapse", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Body() {
      React.useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <div data-testid="persistent-body" />;
    }
    const node = makeNode();
    const view = renderFlow(
      <NodeShell node={node} selected={false}>
        <Body />
      </NodeShell>,
      { nodeId: node.id },
    );
    const body = screen.getByTestId("persistent-body");
    expect(
      (view.container.querySelector('[data-slot="node-header"]') as HTMLElement)
        .style.height,
    ).toBe(`${HEADER_HEIGHT}px`);
    view.rerenderNode(
      <NodeShell node={{ ...node, collapsed: true }} selected={false}>
        <Body />
      </NodeShell>,
    );
    expect(
      (view.container.querySelector('[data-slot="node-shell"]') as HTMLElement)
        .style.height,
    ).toBe(`${COLLAPSED_HEIGHT}px`);
    expect(
      (view.container.querySelector('[data-slot="node-body"]') as HTMLElement)
        .style.display,
    ).toBe("none");
    view.rerenderNode(
      <NodeShell node={node} selected={false}>
        <Body />
      </NodeShell>,
    );
    expect(screen.getByTestId("persistent-body")).toBe(body);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("does not enter rename after dragging the title", async () => {
    renderShell();
    const title = screen.getByText("便签 1");
    fireEvent.pointerDown(title, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, {
      isPrimary: true,
      pointerId: 1,
      clientX: 150,
      clientY: 130,
    });
    await act(async () => {
      fireEvent.pointerUp(window, {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: 150,
        clientY: 130,
      });
      await Promise.resolve();
    });
    fireEvent.click(title, { detail: 1, clientX: 150, clientY: 130 });
    expect(screen.queryByLabelText("标题")).toBeNull();
  });

  it.each(["shiftKey", "ctrlKey", "metaKey", "altKey"])(
    "preserves %s modified selection gestures",
    async (modifier) => {
      renderShell();
      const event = {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        [modifier]: true,
      };
      fireEvent.pointerDown(screen.getByText("便签 1"), event);
      await act(async () => {
        fireEvent.pointerUp(window, event);
        await Promise.resolve();
      });
      expect(screen.queryByLabelText("标题")).toBeNull();
    },
  );

  it("opens rename after pointerup is captured by the canvas", async () => {
    renderShell();
    const title = screen.getByText("便签 1");
    fireEvent.pointerDown(title, {
      button: 0,
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 100,
    });
    await act(async () => {
      fireEvent.pointerUp(window, {
        button: 0,
        pointerId: 1,
        isPrimary: true,
        clientX: 100,
        clientY: 100,
      });
      await Promise.resolve();
    });
    expect(screen.getByLabelText("标题")).toBeTruthy();
  });

  it("keeps touch dragging events bubbling without arming the enclosing long-press menu", () => {
    renderShell();
    const escaped = vi.fn((event: Event) =>
      expect(event.defaultPrevented).toBe(true),
    );
    document.addEventListener("pointerdown", escaped);
    try {
      fireEvent.pointerDown(screen.getByText("便签 1"), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        pointerType: "touch",
        clientX: 100,
        clientY: 100,
      });
      expect(escaped).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("pointerdown", escaped);
    }
  });

  it("does not rename after dragging away and back to the starting point", async () => {
    renderShell();
    fireEvent.pointerDown(screen.getByText("便签 1"), {
      button: 0,
      pointerId: 1,
      isPrimary: true,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      isPrimary: true,
      clientX: 150,
      clientY: 130,
    });
    await act(async () => {
      fireEvent.pointerUp(window, {
        button: 0,
        pointerId: 1,
        isPrimary: true,
        clientX: 100,
        clientY: 100,
      });
      await Promise.resolve();
    });
    expect(screen.queryByLabelText("标题")).toBeNull();
  });

  it("lets IME confirm or cancel composition without committing the node title", () => {
    renderShell();
    fireEvent.click(screen.getByText("便签 1"));
    const input = screen.getByLabelText("标题");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文标题" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByLabelText("标题")).toBe(input);
    expect(store.updateNode).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(store.updateNode).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.updateNode).toHaveBeenCalledTimes(1);
    expect(store.updateNode).toHaveBeenCalledWith("n1", { title: "中文标题" });
  });

  it("does not send composition keys to canvas keyboard handlers", () => {
    renderShell();
    fireEvent.click(screen.getByText("便签 1"));
    const escaped = vi.fn();
    const canvas = screen
      .getByLabelText("标题")
      .closest('[data-slot="node-shell"]')!;
    canvas.addEventListener("keydown", escaped);
    try {
      fireEvent.keyDown(screen.getByLabelText("标题"), {
        key: "Enter",
        isComposing: true,
      });
      fireEvent.keyDown(screen.getByLabelText("标题"), {
        key: "Escape",
        isComposing: true,
      });
      expect(escaped).not.toHaveBeenCalled();
      expect(store.updateNode).not.toHaveBeenCalled();
    } finally {
      canvas.removeEventListener("keydown", escaped);
    }
  });

  it("ignores blur after Escape cancels a rename in the same event batch", () => {
    renderShell();
    fireEvent.click(screen.getByText("便签 1"));
    const input = screen.getByLabelText("标题");
    fireEvent.change(input, { target: { value: "cancelled draft" } });
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
    });
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(screen.getByText("便签 1")).toBeTruthy();
  });

  it("ignores historical custom colours and does not expose a colour picker", () => {
    const node = makeNode({
      type: "terminal",
      color: "#ff453a",
      data: { kind: "terminal" },
    });
    const { container } = renderShell({ node, selected: true });
    expect(screen.queryByRole("button", { name: "颜色" })).toBeNull();
    expect(container.querySelector('[data-slot="color-dot"]')).toBeNull();
    expect(
      container.querySelector('[style*="#ff453a"], [style*="255, 69, 58"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-slot="node-shell"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
    expect(
      container.querySelectorAll('[data-slot="connection-handle"]'),
    ).toHaveLength(2);
  });

  it("commits an edited title on Enter", () => {
    renderShell();
    fireEvent.click(screen.getByText("便签 1"));
    const input = screen.getByLabelText("标题");
    fireEvent.change(input, { target: { value: "改过的标题" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.updateNode).toHaveBeenCalledWith("n1", {
      title: "改过的标题",
    });
  });

  it("drops the draft on Escape", () => {
    renderShell();
    fireEvent.click(screen.getByText("便签 1"));
    const input = screen.getByLabelText("标题");
    fireEvent.change(input, { target: { value: "不要" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(screen.getByText("便签 1")).toBeTruthy();
  });

  it("toggles collapse through the store", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("折叠"));
    expect(store.setCollapsed).toHaveBeenCalledWith("n1", true);
  });

  it("expands again when the node is collapsed", () => {
    renderShell({ node: makeNode({ collapsed: true }) });
    fireEvent.click(screen.getByLabelText("展开"));
    expect(store.setCollapsed).toHaveBeenCalledWith("n1", false);
  });

  it("keeps the body mounted but hidden while collapsed", () => {
    const { container } = renderShell({ node: makeNode({ collapsed: true }) });
    const body = container.querySelector('[data-slot="node-body"]');
    expect(body?.textContent).toBe("body");
    expect((body as HTMLElement).style.display).toBe("none");
  });

  it("calls the approval handler for both decisions", () => {
    const onAnswer = vi.fn();
    renderShell({ approval: { pendingId: "p1", onAnswer } });
    fireEvent.click(screen.getByText("允许"));
    expect(onAnswer).toHaveBeenCalledWith("allow");
    fireEvent.click(screen.getByText("拒绝"));
    expect(onAnswer).toHaveBeenCalledWith("deny");
  });

  it("closes the node from the header", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("关闭"));
    expect(store.removeNodes).toHaveBeenCalledWith(["n1"]);
  });

  /**
   * 头部按钮改文档之前必须先同步选中态：按钮自己吃掉了 pointerdown（否则
   * 一按就开始拖节点），React Flow 的选择不会经手这次点击。
   */
  it("selects the node before mutating it from the header", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("折叠"));
    expect(store.selectNodes).toHaveBeenCalledWith(["n1"]);
    expect(store.setCollapsed).toHaveBeenCalledWith("n1", true);

    store.selectNodes.mockClear();
    fireEvent.click(screen.getByLabelText("最大化"));
    expect(store.selectNodes).toHaveBeenCalledWith(["n1"]);
  });

  it("maximizes with a canvas rect and restores without one", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("最大化"));
    expect(store.maximizeNode).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({ x: expect.any(Number) }),
    );

    store.maximized = { n1: {} };
    cleanup();
    renderShell();
    fireEvent.click(screen.getByLabelText("还原"));
    expect(store.restoreNode).toHaveBeenCalledWith("n1");
    store.maximized = {};
  });

  it("renders a status pill only when a status is given", () => {
    const { container, unmount } = renderShell();
    expect(container.querySelector('[data-slot="status-pill"]')).toBeNull();
    unmount();

    const second = renderShell({
      status: { tone: "working", label: "RUNNING" },
    });
    expect(
      second.container.querySelector('[data-slot="status-pill"]'),
    ).not.toBeNull();
  });

  it("keeps the header to a single row and adds no strip below it", () => {
    const { container } = renderShell({
      node: makeNode({
        type: "terminal",
        data: { kind: "terminal", agent: { id: "claude" } },
      } as Partial<CanvasNode>),
    });
    const shell = container.querySelector('[data-slot="node-shell"]')!;
    // 终端节点：头部之后直接是节点体，中间不许再插任何一行
    const children = [...shell.querySelector(".flex-col")!.children].map((el) =>
      el.getAttribute("data-slot"),
    );
    expect(children).toEqual(["node-header", "node-body"]);
    // 终端的 AI 命名 / 评论在自己的「更多」下拉里，头部不多按钮
    expect(screen.queryByLabelText("评论")).toBeNull();
    expect(screen.queryByLabelText("AI 命名")).toBeNull();
  });

  it("puts the comment button in the header of non-terminal nodes", () => {
    renderShell();
    expect(screen.getByLabelText("评论")).toBeTruthy();
    expect(screen.queryByLabelText("AI 命名")).toBeNull();
  });

  it("edits the comment in a dialog, not inside the node", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("评论"));
    const textarea = screen
      .getAllByLabelText("评论")
      .find((element) => element.tagName === "TEXTAREA") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "记一笔" } });
    fireEvent.blur(textarea);
    expect(store.setNodeNote).toHaveBeenCalledWith("n1", "记一笔");
  });

  it("adds and removes labels from the labels dialog", () => {
    renderShell({ node: makeNode({ labels: ["紧急"] }) });
    act(() => openNodeAnnotation("n1", "labels"));

    fireEvent.click(screen.getByLabelText("移除标签 紧急"));
    expect(store.setNodeLabels).toHaveBeenCalledWith("n1", []);

    const input = screen.getByPlaceholderText("标签名");
    fireEvent.change(input, { target: { value: "重构" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.setNodeLabels).toHaveBeenCalledWith("n1", ["紧急", "重构"]);
  });

  it("draws connection handles on every type but group (§21)", () => {
    const { container, unmount } = renderShell({
      node: makeNode({ type: "sticky" }),
    });
    expect(
      container.querySelectorAll('[data-slot="connection-handle"]'),
    ).toHaveLength(2);
    unmount();

    // 任意互连：编辑器也能被连线读取，所以它也有两个把手。
    const editor = renderShell({
      node: makeNode({
        type: "editor",
        data: { kind: "editor", path: "a.ts" },
      } as Partial<CanvasNode>),
    });
    expect(
      editor.container.querySelectorAll('[data-slot="connection-handle"]'),
    ).toHaveLength(2);
  });

  /**
   * F02：拖拽只从头部起。React Flow 认的是 `dragHandle` 选择器与 `nodrag`
   * 类，而不是「谁吞掉了 pointerdown」，所以断言的是类名与结构。
   */
  it("marks the body nodrag/nowheel and keeps the header a drag handle", () => {
    const { container } = renderShell();
    const body = container.querySelector(
      '[data-slot="node-body"]',
    ) as HTMLElement;
    expect(body.classList.contains("nodrag")).toBe(true);
    // 普通滚轮归节点体自己（终端的 tmux 桥、编辑器的滚动），不缩放画布。
    expect(body.classList.contains("nowheel")).toBe(true);

    const header = container.querySelector(
      '[data-slot="node-header"]',
    ) as HTMLElement;
    expect(header.classList.contains("drag-handle")).toBe(true);
  });

  /**
   * A01：终端拿到键盘焦点时 ⌘滚轮仍然缩放画布。
   *
   * 转发给 `.react-flow__pane` 那条老路会在这时失灵（React Flow 判定缩放看
   * `useKeyPress`，而 keydown 落在 xterm 的隐藏 textarea 上），所以壳自己算。
   * 这里断言的是两件事：⌘滚轮不进节点体（终端不跟着滚历史），普通滚轮照进。
   */
  it("zooms the canvas on cmd+wheel over the body and leaves plain wheel to it", () => {
    const flow = mountFlow();
    const node = makeNode();
    renderFlow(
      <NodeShell node={node} selected={false}>
        <div data-testid="terminal-body" />
      </NodeShell>,
      { nodeId: node.id },
    );
    const surface = screen.getByTestId("terminal-body");
    const inner = vi.fn();
    // 终端的滚屏桥就是这么挂的：节点体**子树**上的捕获相位监听器。
    surface.addEventListener("wheel", inner, { capture: true });

    fireEvent.wheel(surface, {
      deltaY: -120,
      metaKey: true,
      clientX: 0,
      clientY: 0,
    });
    expect(inner).not.toHaveBeenCalled();
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(flow.setViewport.mock.calls[0]![0].zoom).toBeGreaterThan(1);

    fireEvent.wheel(surface, { deltaY: -120 });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
  });

  /** 头部里的按钮仍然要挡住 pointerdown：一按就拖整个节点就点不中它们。 */
  it("keeps header controls from starting a node drag", () => {
    renderShell();
    const seen = vi.fn();
    document.addEventListener("pointerdown", seen);
    try {
      fireEvent.pointerDown(screen.getByLabelText("关闭"));
      expect(seen).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("pointerdown", seen);
    }
  });
});
