import { SelectionMode } from "@xyflow/react";
import type { KeyCode, SnapGrid } from "@xyflow/react";

import type { WhiteboardPreferences } from "@/app/preferences/whiteboard";
import { isDrawingTool, type CanvasToolId } from "../interaction/tool-store";
import {
  MULTI_SELECTION_KEY_CODE,
  PAN_ACTIVATION_KEY_CODE,
  ZOOM_ACTIVATION_KEY_CODE,
} from "../interaction/keyboard";

/**
 * 偏好 + 锁定 + 只读 → `<ReactFlow>` 的一组 props（React Flow 计划 §2.10，
 * 归属 canvas）。
 *
 * 纯函数，没有 React：映射表能被单测逐条覆盖，不用开浏览器。旧引擎
 * 的反向通道（editor 写回偏好）整条删掉了——现在偏好是唯一真相，单向推。
 */

export interface FlowOptionsInput {
  whiteboard: WhiteboardPreferences;
  /** 「锁定视图」（`canvas-lock.ts`）：锁相机，白板工具一并置灰。 */
  locked: boolean;
  /** 当前工具（`interaction/tool-store`）：手形与绘图工具各改一组值。 */
  tool?: CanvasToolId;
  /**
   * 编辑租约在别的设备手里（core JSON §9）：节点拖不动、连不了线，看和平移
   * 照旧。
   */
  readOnly?: boolean;
}

export interface FlowOptions {
  panOnDrag: boolean | number[];
  panOnScroll: boolean;
  zoomOnScroll: boolean;
  zoomOnPinch: boolean;
  zoomOnDoubleClick: boolean;
  zoomActivationKeyCode: KeyCode | null;
  panActivationKeyCode: KeyCode | null;
  multiSelectionKeyCode: KeyCode | null;
  selectionOnDrag: boolean;
  selectionMode: SelectionMode;
  snapToGrid: boolean;
  snapGrid: SnapGrid;
  autoPanOnNodeDrag: boolean;
  autoPanOnConnect: boolean;
  nodesDraggable: boolean;
  nodesConnectable: boolean;
  elementsSelectable: boolean;
}

/**
 * 手势分工（F11）：滚轮平移、⌘/Ctrl+滚轮与捏合缩放、空格 / 中键拖平移、
 * 左键空白框选、Shift 多选。输入设备选「鼠标」时反过来——鼠标只有一个
 * 滚轮，平移得靠拖。
 *
 * 手形工具（F21）也在这张表里，不再自己接一份指针通道：`panOnDrag` 含 0
 * 就是「左键拖动平移」，与空格、中键走的是同一条 d3-zoom。同时把框选与
 * 节点拖动关掉——两者都吃左键，留着会跟平移抢同一下按压；节点拖动关掉之后
 * React Flow 不再给节点装 d3-drag，按在节点上的那一下才落得到画布上，
 * 手形工具因此在节点上方也能平移，而不是只在空白处。
 *
 * 绘图工具（画笔 / 高亮 / 形状 / 直线 / 箭头 / 文字 / 画框）同理，而且**必须**
 * 在这张表里关掉框选：React Flow 的框选起点是 `Pane` 的 `onPointerDownCapture`
 * ——一个 React 的捕获相位 prop。React 19 把所有委托监听器装在根容器
 * （`#root`）上，根容器是 `.react-flow` 的祖先，所以它的捕获监听器比工具层
 * 装在 `.react-flow` 上的捕获监听器**更早**触发，整条捕获路径（含 Pane 的
 * `onPointerDownCapture`）在那一刻已经派发完毕。工具层再 `stopPropagation`
 * 也来不及——框选矩形已经建好了。唯一能让它不建的办法就是让 React Flow
 * 压根不装那个 handler，即 `selectionOnDrag: false`（`isSelecting` 随之为
 * false，`Pane` 就不再传 `onPointerDownCapture`）。
 */
export function flowOptions({
  whiteboard,
  locked,
  tool = "select",
  readOnly = false,
}: FlowOptionsInput): FlowOptions {
  const mouse = whiteboard.inputMode === "mouse";
  const grid = whiteboard.gridSize;
  const hand = !locked && tool === "hand";
  const drawing = !locked && isDrawingTool(tool);
  return {
    // 中键拖动平移；手形连左键一起，绘图工具全关（那一下归工具层）。
    panOnDrag: locked || drawing ? false : hand ? [0, 1] : [1],
    panOnScroll: !locked && !mouse,
    zoomOnScroll: !locked && mouse,
    zoomOnPinch: !locked,
    // 双击留给「空白处新建文字」（`tools/use-double-click-text.ts`），不缩放。
    zoomOnDoubleClick: false,
    zoomActivationKeyCode: locked ? null : ZOOM_ACTIVATION_KEY_CODE,
    panActivationKeyCode: locked ? null : PAN_ACTIVATION_KEY_CODE,
    multiSelectionKeyCode: MULTI_SELECTION_KEY_CODE,
    selectionOnDrag: !locked && !hand && !drawing,
    // 「整体框住才选中」= `SelectionMode.Full`；关掉时碰到就算选中。
    selectionMode: whiteboard.wrap ? SelectionMode.Full : SelectionMode.Partial,
    snapToGrid: whiteboard.snap,
    snapGrid: [grid, grid],
    autoPanOnNodeDrag: whiteboard.edgeScroll,
    autoPanOnConnect: whiteboard.edgeScroll,
    nodesDraggable: !readOnly && !hand && !drawing,
    nodesConnectable: !readOnly,
    // 绘图时关掉：画过一个节点之后那一下 `click` 不该顺手把它选中。
    elementsSelectable: !drawing,
  };
}
