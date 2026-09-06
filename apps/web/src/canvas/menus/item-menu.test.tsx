import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/ui/context-menu";

import type { Item } from "../whiteboard/model";

/**
 * 白板对象的右键菜单（React Flow 计划 F18）。
 *
 * 三条约定：作用范围跟着选区（命中项在选区里就整选区一起动）、层级 / 复制 /
 * 删除全部经 `whiteboard` 的 store 动作（AGENTS.md：画布修改经 canvas-store
 * 动作）、「转成便签」只在真有文字时出现。
 */

const state = {
  selectedItemIds: [] as string[],
  addNode: vi.fn(() => "node-1"),
  // 「引用到 Agent」子菜单（`reference-menu.tsx`）现在挂在这份菜单里，
  // 它订阅文档与引用行。板子上没有 Agent 终端时它只渲染一条禁用提示。
  document: null,
  whiteboard: { engine: "armadra-flow", version: 2, items: [], references: [] },
};
const items: Item[] = [];

const reorder = vi.fn();
const removeItems = vi.fn();
const addItems = vi.fn((next: Item[]) => next.map((item) => item.id));
const select = vi.fn();

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (value: typeof state) => T) =>
    selector(state);
  useCanvasStore.getState = () => state;
  return { useCanvasStore };
});

vi.mock("../whiteboard/store", () => ({
  reorder,
  removeItems,
  addItems,
  select,
  createItemId: () => "copy-1",
  itemsByIds: (ids: readonly string[]) =>
    items.filter((item) => ids.includes(`wb:${item.id}`)),
}));

const { installDomPolyfills, TestProviders } = await import(
  "@/app/test-harness"
);
const { makeItem } = await import("@/canvas/test-support");
const { ItemMenuContent, itemMenuTargets, stickyTextOf } = await import(
  "./item-menu"
);

installDomPolyfills();
afterEach(cleanup);

/** 走真的右键：`open` 直接置 true 时 Radix 会警告定位不确定。 */
function open(itemId: string) {
  const result = render(
    <TestProviders>
      <ContextMenu>
        <ContextMenuTrigger>
          <div data-testid="stage" />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ItemMenuContent itemId={itemId} />
        </ContextMenuContent>
      </ContextMenu>
    </TestProviders>,
  );
  fireEvent.contextMenu(screen.getByTestId("stage"));
  return result;
}

describe("itemMenuTargets", () => {
  it("命中项在选区里就作用于整个选区", () => {
    expect(itemMenuTargets("wb:a", ["wb:a", "wb:b"])).toEqual(["wb:a", "wb:b"]);
  });

  it("命中项不在选区里就只作用于它自己", () => {
    expect(itemMenuTargets("wb:c", ["wb:a", "wb:b"])).toEqual(["wb:c"]);
  });
});

describe("stickyTextOf", () => {
  it("文字对象取正文，几何形取标签，其余没有文字", () => {
    expect(
      stickyTextOf([
        makeItem("text", { text: "第一段" }),
        makeItem("shape", { label: "标注" }),
        makeItem("ink"),
      ]),
    ).toBe("第一段\n\n标注");
  });

  it("只有空白时算没有文字（菜单里那一项不出现）", () => {
    expect(stickyTextOf([makeItem("text", { text: "  \n " })])).toBe("");
  });
});

describe("ItemMenuContent", () => {
  beforeEach(() => {
    for (const fn of [reorder, removeItems, addItems, select, state.addNode])
      fn.mockClear();
    items.length = 0;
    state.selectedItemIds = [];
  });

  it("置顶走 `whiteboard.reorder`", () => {
    items.push(makeItem("shape", { id: "a" }));
    open("wb:a");
    fireEvent.click(screen.getByText("置顶"));
    expect(reorder).toHaveBeenCalledWith(["wb:a"], "front");
  });

  it("置底走 `whiteboard.reorder`", () => {
    items.push(makeItem("shape", { id: "a" }));
    open("wb:a");
    fireEvent.click(screen.getByText("置底"));
    expect(reorder).toHaveBeenCalledWith(["wb:a"], "back");
  });

  it("复制建一份新 id 的副本并偏移 16，选中新的那一份", () => {
    items.push(makeItem("shape", { id: "a", x: 10, y: 20 }));
    open("wb:a");
    fireEvent.click(screen.getByText("复制"));
    const copies = addItems.mock.calls[0]![0];
    expect(copies).toHaveLength(1);
    expect(copies[0]!.id).toBe("copy-1");
    expect({ x: copies[0]!.x, y: copies[0]!.y }).toEqual({ x: 26, y: 36 });
    expect(select).toHaveBeenCalledWith(["copy-1"]);
  });

  /** 组员的坐标相对 Frame，带着 `parentId` 复制会把偏移落在另一个坐标系。 */
  it("复制出来的对象一律落在页面级", () => {
    items.push(makeItem("shape", { id: "a", parentId: "frame-1" }));
    open("wb:a");
    fireEvent.click(screen.getByText("复制"));
    const copies = addItems.mock.calls[0]![0];
    expect(copies[0]!.parentId).toBeNull();
  });

  it("「转成便签」建一个 sticky 节点并删掉原对象", () => {
    items.push(makeItem("text", { id: "a", x: 40, y: 50, text: "记一笔" }));
    open("wb:a");
    fireEvent.click(screen.getByText("转成便签"));
    expect(state.addNode).toHaveBeenCalledWith("sticky", {
      position: { x: 40, y: 50 },
      data: { kind: "sticky", content: "记一笔" },
    });
    expect(removeItems).toHaveBeenCalledWith(["wb:a"]);
  });

  it("没有文字的对象不显示「转成便签」", () => {
    items.push(makeItem("ink", { id: "a" }));
    open("wb:a");
    expect(screen.queryByText("转成便签")).toBeNull();
  });

  it("删除走 `whiteboard.removeItems`，作用于整个选区", () => {
    items.push(makeItem("shape", { id: "a" }), makeItem("ink", { id: "b" }));
    state.selectedItemIds = ["wb:a", "wb:b"];
    open("wb:a");
    fireEvent.click(screen.getByText("删除"));
    expect(removeItems).toHaveBeenCalledWith(["wb:a", "wb:b"]);
  });

  /** 颜色 / 粗细归样式面板，一份样式两个入口只会互相打架（§2.4）。 */
  it("菜单里没有颜色与粗细", () => {
    items.push(makeItem("shape", { id: "a" }));
    open("wb:a");
    expect(screen.queryByText("颜色")).toBeNull();
    expect(screen.queryByText("粗细")).toBeNull();
  });
});
