import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/**
 * 空白处双击 = 新建文字（2026-09-06 用户反馈）。
 *
 * 三条断言：空白处双击真的建出一条空文字并选中它（`TextNode` 的
 * `autoEdit` 靠「空文本」触发）、非空白处（节点、对象、输入框）一下都不建、
 * 绘图工具与锁定态下不建。
 */

const mocks = vi.hoisted(() => ({
  added: [] as unknown[],
  selected: [] as string[],
  tool: "select",
  locked: false,
  editable: true,
  snap: false,
  gridSize: 24,
}));

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  }),
  useStoreApi: () => ({
    getState: () => ({ domNode: document.querySelector(".react-flow") }),
  }),
}));
vi.mock("@/app/preferences-store", () => ({
  usePreferencesStore: (select: (state: unknown) => unknown) =>
    select({ whiteboard: { snap: mocks.snap, gridSize: mocks.gridSize } }),
}));
vi.mock("@/canvas-ownership", () => ({
  canEditCanvas: () => mocks.editable,
  useCanvasOwnership: () => "owned",
}));
vi.mock("../../canvas-lock", () => ({
  isCanvasLocked: () => mocks.locked,
}));
vi.mock("../../interaction/tool-store", () => ({
  getTool: () => mocks.tool,
  getNextStyle: () => ({
    color: "black",
    size: "m",
    dash: "solid",
    fill: "none",
    geo: "rectangle",
  }),
}));
vi.mock("../store", () => ({
  addItems: (items: unknown[]) => {
    mocks.added.push(...items);
    return items.map((_, index) => `i${index}`);
  },
  createItemId: () => "item-1",
  select: (ids: string[]) => mocks.selected.push(...ids),
}));

const { useDoubleClickText } = await import("./use-double-click-text");

function Harness() {
  useDoubleClickText();
  return null;
}

/** 一个最小的 `.react-flow` 容器：内含一个 pane 与一个节点。 */
function mount() {
  const host = document.createElement("div");
  host.className = "react-flow";
  host.innerHTML =
    '<div class="react-flow__pane"></div><div class="react-flow__node"></div>';
  document.body.append(host);
  render(<Harness />);
  return {
    host,
    pane: host.querySelector(".react-flow__pane") as HTMLElement,
    node: host.querySelector(".react-flow__node") as HTMLElement,
  };
}

function doubleClick(target: HTMLElement, x = 120, y = 80) {
  target.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
    }),
  );
}

describe("空白处双击建文字", () => {
  beforeEach(() => {
    mocks.added = [];
    mocks.selected = [];
    mocks.tool = "select";
    mocks.locked = false;
    mocks.editable = true;
    mocks.snap = false;
    document.body.innerHTML = "";
  });
  afterEach(cleanup);

  it("画布空白处：建一条空文字并选中（选中 + 空文本 = 直接进编辑）", () => {
    const { pane } = mount();
    doubleClick(pane, 120, 80);
    expect(mocks.added).toEqual([
      expect.objectContaining({ kind: "text", text: "", x: 120, y: 80 }),
    ]);
    expect(mocks.selected).toEqual(["item-1"]);
  });

  it("吸附开着时落点吸到网格上", () => {
    mocks.snap = true;
    const { pane } = mount();
    doubleClick(pane, 121, 79);
    expect(mocks.added[0]).toMatchObject({ x: 120, y: 72 });
  });

  it("节点上的双击原样放过：节点里的输入框还要靠它进编辑", () => {
    const { node } = mount();
    doubleClick(node);
    expect(mocks.added).toEqual([]);
  });

  it("绘图工具下不建：那两下是两笔各自的起手", () => {
    mocks.tool = "draw";
    const { pane } = mount();
    doubleClick(pane);
    expect(mocks.added).toEqual([]);
  });

  it("锁定视图与只读态都不建", () => {
    mocks.locked = true;
    const locked = mount();
    doubleClick(locked.pane);
    expect(mocks.added).toEqual([]);
    cleanup();

    mocks.locked = false;
    mocks.editable = false;
    document.body.innerHTML = "";
    const readonly = mount();
    doubleClick(readonly.pane);
    expect(mocks.added).toEqual([]);
  });
});
