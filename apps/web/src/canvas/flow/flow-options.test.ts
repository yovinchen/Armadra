import { describe, expect, it } from "vitest";
import { SelectionMode } from "@xyflow/react";

import type { WhiteboardPreferences } from "@/app/preferences/whiteboard";
import { flowOptions } from "./flow-options";

/**
 * 偏好 → `<ReactFlow>` props（React Flow 计划 §2.10 的映射表）。
 *
 * 纯函数，所以整张表逐条钉住：改坏一格就是这里红，不用开浏览器才发现
 * 「锁定之后还能平移」。
 */

const preferences: WhiteboardPreferences = {
  background: "theme",
  grid: true,
  gridSize: 24,
  snap: false,
  dynamicSize: false,
  animation: true,
  toolLock: false,
  wrap: false,
  focus: false,
  edgeScroll: true,
  pasteAtCursor: false,
  inputMode: "auto",
  defaultColor: "black",
  defaultSize: "m",
};

const options = (patch: Partial<WhiteboardPreferences> = {}, extra = {}) =>
  flowOptions({
    whiteboard: { ...preferences, ...patch },
    locked: false,
    ...extra,
  });

describe("手势分工", () => {
  it("默认（触控板 / 自动）：滚轮平移，⌘滚轮与捏合缩放", () => {
    const result = options();
    expect(result.panOnScroll).toBe(true);
    expect(result.zoomOnScroll).toBe(false);
    expect(result.zoomOnPinch).toBe(true);
    expect(result.zoomActivationKeyCode).toEqual(["Meta", "Control"]);
  });

  it("鼠标模式反过来：滚轮缩放，拖动平移", () => {
    const result = options({ inputMode: "mouse" });
    expect(result.panOnScroll).toBe(false);
    expect(result.zoomOnScroll).toBe(true);
  });

  it("中键拖平移、空格拖平移、左键空白框选、Shift 多选", () => {
    const result = options();
    expect(result.panOnDrag).toEqual([1]);
    expect(result.panActivationKeyCode).toBe("Space");
    expect(result.selectionOnDrag).toBe(true);
    expect(result.multiSelectionKeyCode).toBe("Shift");
  });

  it("双击不缩放：那一下留给进入文字编辑", () => {
    expect(options().zoomOnDoubleClick).toBe(false);
  });
});

/**
 * 手形工具（F21）。
 *
 * B2 曾经在 `whiteboard/tools/use-tool-pointer.ts` 里自己接一份左键平移；
 * 现在同一个手势只有 React Flow 这一份实现，所以这张表就是它的全部行为。
 */
describe("手形工具", () => {
  const hand = options({}, { tool: "hand" });

  it("左键也能平移，中键照旧", () => {
    expect(hand.panOnDrag).toEqual([0, 1]);
  });

  it("框选与节点拖动一起关掉：三者都吃左键", () => {
    expect(hand.selectionOnDrag).toBe(false);
    // 节点不装 d3-drag，按在节点上的那一下才落得到画布上。
    expect(hand.nodesDraggable).toBe(false);
  });

  it("选择工具不受影响：左键仍然是框选", () => {
    const result = options({}, { tool: "select" });
    expect(result.panOnDrag).toEqual([1]);
    expect(result.selectionOnDrag).toBe(true);
    expect(result.nodesDraggable).toBe(true);
    expect(result.elementsSelectable).toBe(true);
  });

  it("锁定优先于工具：手形也一样什么都不能拖", () => {
    const locked = options({}, { tool: "hand", locked: true });
    expect(locked.panOnDrag).toBe(false);
    expect(locked.selectionOnDrag).toBe(false);
  });
});

/**
 * 绘图工具（2026-09-06 用户反馈：选了画笔拖动时框选矩形照样出来）。
 *
 * 框选起点是 `Pane` 的 `onPointerDownCapture`，React 19 从根容器派发整条
 * 捕获路径，工具层装在 `.react-flow` 上的捕获监听器比它晚——所以只能在
 * 这张表里让 React Flow 压根不装那个 handler。六个绘图工具逐个钉住。
 */
describe("绘图工具", () => {
  const DRAWING = [
    "draw",
    "highlight",
    "geo",
    "line",
    "arrow",
    "text",
  ] as const;

  it("框选、节点拖动、拖动平移全关：左键整条归工具层", () => {
    for (const tool of DRAWING) {
      const result = options({}, { tool });
      expect({ tool, ...result }).toMatchObject({
        tool,
        selectionOnDrag: false,
        nodesDraggable: false,
        panOnDrag: false,
        // 画过一个节点之后那一下 `click` 不该顺手把它选中。
        elementsSelectable: false,
      });
    }
  });

  it("相机手势照旧：滚轮平移、⌘滚轮与捏合缩放、空格拖平移", () => {
    const result = options({}, { tool: "draw" });
    expect(result.panOnScroll).toBe(true);
    expect(result.zoomOnPinch).toBe(true);
    expect(result.panActivationKeyCode).toBe("Space");
  });

  it("锁定优先：工具已经退回选择，这张表也不该再放行", () => {
    const locked = options({}, { tool: "draw", locked: true });
    expect(locked.panOnDrag).toBe(false);
    expect(locked.selectionOnDrag).toBe(false);
    expect(locked.elementsSelectable).toBe(true);
  });
});

describe("锁定视图", () => {
  const locked = options({}, { locked: true });

  it("平移、缩放、框选全关", () => {
    expect(locked.panOnDrag).toBe(false);
    expect(locked.panOnScroll).toBe(false);
    expect(locked.zoomOnScroll).toBe(false);
    expect(locked.zoomOnPinch).toBe(false);
    expect(locked.selectionOnDrag).toBe(false);
  });

  it("两个手势修饰键也一起摘掉", () => {
    expect(locked.zoomActivationKeyCode).toBeNull();
    expect(locked.panActivationKeyCode).toBeNull();
  });

  it("锁的是相机不是选择：选中框还得看得见", () => {
    expect(locked.elementsSelectable).toBe(true);
  });
});

describe("偏好映射", () => {
  it("吸附跟着 `snap`，网格间距直接当 `snapGrid`", () => {
    expect(options({ snap: true, gridSize: 48 })).toMatchObject({
      snapToGrid: true,
      snapGrid: [48, 48],
    });
    expect(options({ snap: false }).snapToGrid).toBe(false);
  });

  it("「整体框住才选中」= `SelectionMode.Full`", () => {
    expect(options({ wrap: true }).selectionMode).toBe(SelectionMode.Full);
    expect(options({ wrap: false }).selectionMode).toBe(SelectionMode.Partial);
  });

  it("边缘滚动同时管拖节点与拉连线", () => {
    expect(options({ edgeScroll: false })).toMatchObject({
      autoPanOnNodeDrag: false,
      autoPanOnConnect: false,
    });
  });
});
