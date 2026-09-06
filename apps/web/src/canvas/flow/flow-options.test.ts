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
    editable: true,
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

  it("「选择换行」= 整体包住才算选中", () => {
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

describe("只读态", () => {
  it("归属没落在本端时不能拖、不能连，但仍可选中", () => {
    const readonly = options({}, { editable: false });
    expect(readonly.nodesDraggable).toBe(false);
    expect(readonly.nodesConnectable).toBe(false);
    expect(readonly.elementsSelectable).toBe(true);
  });
});
