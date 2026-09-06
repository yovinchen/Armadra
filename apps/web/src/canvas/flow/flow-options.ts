import { SelectionMode } from "@xyflow/react";
import type { KeyCode, SnapGrid } from "@xyflow/react";

import type { WhiteboardPreferences } from "@/app/preferences/whiteboard";
import type { CanvasToolId } from "../interaction/tool-store";
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
  /** 归属网关说这块画布现在能不能写（`canEditCanvas`）。 */
  editable: boolean;
  /** 当前工具（`interaction/tool-store`）。只有「手」改这张表。 */
  tool?: CanvasToolId;
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
 */
export function flowOptions({
  whiteboard,
  locked,
  editable,
  tool = "select",
}: FlowOptionsInput): FlowOptions {
  const mouse = whiteboard.inputMode === "mouse";
  const grid = whiteboard.gridSize;
  const hand = !locked && tool === "hand";
  return {
    // 中键拖动始终能平移；左键留给框选，手形工具或锁定时另说。
    panOnDrag: locked ? false : hand ? [0, 1] : [1],
    panOnScroll: !locked && !mouse,
    zoomOnScroll: !locked && mouse,
    zoomOnPinch: !locked,
    // 双击留给「进入文字编辑」（B2），不缩放。
    zoomOnDoubleClick: false,
    zoomActivationKeyCode: locked ? null : ZOOM_ACTIVATION_KEY_CODE,
    panActivationKeyCode: locked ? null : PAN_ACTIVATION_KEY_CODE,
    multiSelectionKeyCode: MULTI_SELECTION_KEY_CODE,
    selectionOnDrag: !locked && !hand,
    // 「选择换行」= 整体包住才算选中。
    selectionMode: whiteboard.wrap ? SelectionMode.Full : SelectionMode.Partial,
    snapToGrid: whiteboard.snap,
    snapGrid: [grid, grid],
    autoPanOnNodeDrag: whiteboard.edgeScroll,
    autoPanOnConnect: whiteboard.edgeScroll,
    nodesDraggable: editable && !hand,
    nodesConnectable: editable,
    // 只读时仍然可选：看得见选中框才知道右键菜单作用在谁身上。
    elementsSelectable: true,
  };
}
