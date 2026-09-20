import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import { DropdownMenu } from "@/ui/dropdown-menu";
import { NodeHeader, NodeMenuContent, NodeShell } from "./NodeShell";
import { onNodeNamesRequest } from "./node-names";
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

/**
 * 折叠 / 最大化 / 标注全部收进了头部的 `···`（F5），而 Radix 的菜单正文只有
 * open 时才挂进 DOM，所以这些动作直接渲染菜单正文本身来断言。
 */
function openMenu(
  props: Partial<React.ComponentProps<typeof NodeMenuContent>> = {},
) {
  return render(
    <DropdownMenu open>
      <NodeMenuContent
        node={makeNode()}
        collapsed={false}
        maximized={false}
        {...props}
      />
    </DropdownMenu>,
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

  /**
   * 头部密度（契约 §3.4，2026-09-19）：30px 一行、标题 12px、图标钮 24×24。
   * 节点体拿走剩下的全部高度，所以内容是「按比例」铺满的，不靠固定像素。
   */
  it("keeps the header at 30px and the body on the remaining height", () => {
    const view = renderShell();
    const header = view.container.querySelector(
      '[data-slot="node-header"]',
    ) as HTMLElement;
    expect(header.style.height).toBe("30px");
    expect(HEADER_HEIGHT).toBe(30);

    expect(screen.getByText("便签 1").className).toContain("text-[12px]");
    expect(screen.getByLabelText("关闭").className).toContain("size-[24px]");

    const body = view.container.querySelector(
      '[data-slot="node-body"]',
    ) as HTMLElement;
    expect(body.className).toContain("flex-1");
    expect(body.className).toContain("min-h-0");
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

  /**
   * F4：单击只是选中 / 开始拖，双击才改名。文件管理器那种窄头部里，单击进
   * 编辑让「想拖节点」几乎必然变成「打开了一个输入框」。
   */
  it("renames on double click and leaves a single click to the drag", async () => {
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
    fireEvent.click(title, { detail: 1 });
    expect(screen.queryByLabelText("标题")).toBeNull();

    fireEvent.doubleClick(title);
    expect(screen.getByLabelText("标题")).toBeTruthy();
  });

  /**
   * 标题不再自己认一次点按（改名是双击），所以触屏上按住它就该和按住头部
   * 其它地方一样：事件原样冒泡出去，画布的长按右键菜单照常武装。
   */
  it("leaves a touch press on the title untouched for the long-press menu", () => {
    renderShell();
    const escaped = vi.fn((event: Event) =>
      expect(event.defaultPrevented).toBe(false),
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

  /**
   * 名字与标题是两件事（设计 §2.1）：自动命名只改标题，名字是 Agent 之间的
   * 称呼。所以菜单里它们是两项，头部的徽标也只在有名字时出现。
   */
  it("offers the name as its own menu item", () => {
    const asked: string[][] = [];
    const release = onNodeNamesRequest((ids) => asked.push([...ids]));
    try {
      openMenu({ onRename: vi.fn() });
      fireEvent.click(screen.getByRole("menuitem", { name: "名字…" }));
      expect(asked).toEqual([["n1"]]);
    } finally {
      release();
    }
  });

  it("draws the name badge only when the node has one, and opens it on click", () => {
    const plain = makeNode();
    const { unmount } = render(
      <NodeHeader node={plain} collapsed={false} maximized={false} />,
    );
    expect(screen.queryByLabelText("名字…")).toBeNull();
    unmount();

    const named = makeNode({
      data: { kind: "sticky", content: "", handle: "reviewer" },
    } as Partial<CanvasNode>);
    const asked: string[][] = [];
    const release = onNodeNamesRequest((ids) => asked.push([...ids]));
    try {
      render(<NodeHeader node={named} collapsed={false} maximized={false} />);
      fireEvent.click(screen.getByLabelText("名字…"));
      expect(screen.getByText("@reviewer")).toBeTruthy();
      expect(asked).toEqual([["n1"]]);
    } finally {
      release();
    }
  });

  /** 菜单里那一项翻的是同一个开关：标题当场变成输入框。 */
  it("enters rename when the header is told to", () => {
    const node = makeNode();
    render(<NodeHeader node={node} collapsed={false} maximized={false} />);
    expect(screen.queryByLabelText("标题")).toBeNull();
    fireEvent.doubleClick(screen.getByText("便签 1"));
    const input = screen.getByLabelText("标题");
    fireEvent.change(input, { target: { value: "菜单改的名" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.updateNode).toHaveBeenCalledWith("n1", {
      title: "菜单改的名",
    });
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
    fireEvent.doubleClick(screen.getByText("便签 1"));
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
    fireEvent.doubleClick(screen.getByText("便签 1"));
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
    fireEvent.doubleClick(screen.getByText("便签 1"));
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
    fireEvent.doubleClick(screen.getByText("便签 1"));
    const input = screen.getByLabelText("标题");
    fireEvent.change(input, { target: { value: "改过的标题" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.updateNode).toHaveBeenCalledWith("n1", {
      title: "改过的标题",
    });
  });

  it("drops the draft on Escape", () => {
    renderShell();
    fireEvent.doubleClick(screen.getByText("便签 1"));
    const input = screen.getByLabelText("标题");
    fireEvent.change(input, { target: { value: "不要" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(screen.getByText("便签 1")).toBeTruthy();
  });

  /** 头部只剩标题、常驻徽标、`···` 与关闭（F5）。 */
  it("keeps only the title, the chips, the menu and close in the header", () => {
    const { container } = renderShell();
    const header = container.querySelector(
      '[data-slot="node-header"]',
    ) as HTMLElement;
    const labels = [...header.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["更多", "关闭"]);
    expect(screen.queryByLabelText("折叠")).toBeNull();
    expect(screen.queryByLabelText("最大化")).toBeNull();
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
    // AI 命名 / 评论在每种节点共用的 `···` 里，头部不多按钮
    expect(screen.queryByLabelText("评论")).toBeNull();
    expect(screen.queryByLabelText("AI 命名")).toBeNull();
  });

  it("edits the comment in a dialog, not inside the node", () => {
    renderShell();
    act(() => openNodeAnnotation("n1", "note"));
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
