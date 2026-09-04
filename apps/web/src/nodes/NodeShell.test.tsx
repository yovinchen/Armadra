import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { openNodeAnnotation } from "@/meta/annotations";
import { NodeShell } from "./NodeShell";

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

function renderShell(
  props: Partial<React.ComponentProps<typeof NodeShell>> = {},
) {
  const node = props.node ?? makeNode();
  return render(
    <NodeShell node={node} selected={false} {...props}>
      <div>body</div>
    </NodeShell>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NodeShell", () => {
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
   * 一按就开始拖 shape），tldraw 的 select 工具不会经手这次点击。
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

  /** tldraw 计划 §4.1：体内指针事件不冒泡，拖拽只认头部。 */
  it("keeps body pointer events out of the canvas", () => {
    const { container } = renderShell();
    const body = container.querySelector(
      '[data-slot="node-body"]',
    ) as HTMLElement;
    // React 19 把监听器委托到根容器上，所以「冒不冒泡到画布」等价于
    // 「document 上还收不收得到」——tldraw 的 `.tl-canvas` 也在更外层。
    const seen = vi.fn();
    document.addEventListener("pointerdown", seen);
    try {
      fireEvent.pointerDown(body);
      expect(seen).not.toHaveBeenCalled();

      // 头部空白处相反：放行给 select 工具，否则节点拖不动。
      const header = container.querySelector(
        '[data-slot="node-header"]',
      ) as HTMLElement;
      fireEvent.pointerDown(header);
      expect(seen).toHaveBeenCalledTimes(1);

      // 头部里的按钮又要挡住：一按就拖整个节点的话，点不中任何一个钮。
      seen.mockClear();
      fireEvent.pointerDown(screen.getByLabelText("关闭"));
      expect(seen).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("pointerdown", seen);
    }
  });
});
