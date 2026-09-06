import * as React from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import type { Position } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { canEditCanvas, useCanvasOwnership } from "@/canvas-ownership";
import { useCanvasStore } from "@/store/canvas-store";
import { isCanvasLocked } from "../../canvas-lock";
import {
  getNextStyle,
  isDrawingTool,
  setNextStyle,
  setTool,
  useTool,
} from "../../interaction/tool-store";
import { rememberPointer } from "../../interaction/pointer";
import { scaledSize } from "../palette";
import { addItems, createItemId, select } from "../store";
import {
  commitDraft,
  extendDraft,
  startDraft,
  textItemAt,
  type Draft,
} from "./draft";
import { snapToGrid } from "./grid";

/**
 * 白板工具的指针通道（React Flow 计划 §2.4 / F21–F25，归属 whiteboard）。
 *
 * 不铺一层 `pointer-events: all` 的覆盖层，而是在 React Flow 的容器上装一个
 * **捕获相位**的 `pointerdown`。这么做有一个覆盖层给不了的好处——滚轮事件
 * 一个都不拦，所以画画的时候仍然能滚轮平移、⌘滚轮缩放，手不用先切回选择。
 *
 * 但这个监听器**挡不住 React Flow 的框选**（2026-09-06 用户反馈：选了画笔
 * 拖动时框选矩形照样出来）。原因是相位：React Flow 的框选起点是 `Pane` 的
 * `onPointerDownCapture`，而 React 19 把委托监听器装在根容器（`#root`）上，
 * 根容器是 `.react-flow` 的祖先——它的捕获监听器先跑，并在那一刻就把整条
 * 捕获路径派发完了。等这里的 `stopPropagation` 执行时，`userSelectionRect`
 * 已经建好，收不回来。所以「绘图工具不框选」只能由
 * `flow/flow-options.ts` 关掉 `selectionOnDrag` 来保证，这里的
 * `stopPropagation` 只负责挡住真正装在 DOM 上的那些监听器（d3-drag 等）。
 *
 * 手形工具**不在**这里：它是一次视口平移，与空格、中键是同一件事，所以
 * 归 `flow/flow-options.panOnDrag`（工具是「手」时含 0）。同一个手势有两份
 * 实现的话，两边的惯性、边缘自动平移、锁定判据迟早会分叉。
 */

export interface ToolPointerState {
  draft: Draft | null;
}

export function useToolPointer(): ToolPointerState {
  const tool = useTool();
  const flow = useReactFlow();
  const store = useStoreApi();
  const preferences = usePreferencesStore((state) => state.whiteboard);
  const ownership = useCanvasOwnership((state) => state.status);
  const editable = canEditCanvas(ownership);
  const [draft, setDraft] = React.useState<Draft | null>(null);

  // 回调里要读最新的偏好，但 effect 不该因为改了一次网格间距就重挂。
  const latest = React.useRef({ preferences, tool, editable });
  latest.current = { preferences, tool, editable };

  React.useEffect(() => {
    const dom = store.getState().domNode;
    if (!dom) return;
    // 选择与手形都不画东西：手形整个交给 React Flow 的 `panOnDrag`。
    // 判据与 `flow-options` 共用一个，两边不会对「哪些工具吃左键」有分歧。
    if (!isDrawingTool(tool)) return;

    let pointerId: number | null = null;
    let current: Draft | null = null;
    let swallowClick = false;

    /**
     * 吞掉这一笔松手之后紧跟着的那一下 `click`。
     *
     * 绘图工具下 `selectionOnDrag` 是关的（`flow/flow-options.ts`），React Flow
     * 的 `Pane` 因此改用它的 `onClick` —— 那个 handler 会
     * `resetSelectedElements()`，把刚落成的对象重新取消选中。`click` 是**冒泡**
     * 相位的 React prop，根容器的委托监听器要等事件冒泡上去才跑，所以装在
     * `.react-flow` 上的捕获监听器能赶在它前面把事件截住（`pointerdown`
     * 那条路不行，原因见文件顶部）。
     */
    const onClickCapture = (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
    };

    const pageOf = (event: PointerEvent): Position =>
      snapToGrid(
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        latest.current.preferences.gridSize,
        latest.current.preferences.snap,
      );

    const finish = () => {
      const drawn = current;
      current = null;
      pointerId = null;
      setDraft(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!drawn) return;
      if (drawn.kind === "frame") {
        commitFrame(drawn);
      } else {
        const item = commitDraft(drawn, createItemId());
        if (item) {
          addItems([item]);
          select([item.id]);
        }
      }
      if (!latest.current.preferences.toolLock) setTool("select");
    };

    const onMove = (event: PointerEvent) => {
      if (!current || event.pointerId !== pointerId) return;
      current = extendDraft(current, pageOf(event), pressureOf(event));
      setDraft(current);
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (current)
        current = extendDraft(current, pageOf(event), pressureOf(event));
      finish();
    };

    const onPointerDown = (event: PointerEvent) => {
      swallowClick = false;
      if (event.button !== 0) return;
      // 样式面板、锁按钮、节点体里的输入框不归工具管。
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable='true']")
      ) {
        return;
      }
      const active = latest.current;
      if (isCanvasLocked() || !active.editable) return;
      swallowClick = true;
      event.stopPropagation();
      event.preventDefault();
      const at = pageOf(event);
      rememberPointer({ x: event.clientX, y: event.clientY });

      if (active.tool === "text") {
        const item = textItemAt(at, createItemId());
        addItems([item]);
        select([item.id]);
        if (!active.preferences.toolLock) setTool("select");
        return;
      }

      applyDynamicSize(active.preferences.dynamicSize, flow.getZoom());
      current = startDraft(active.tool, at, pressureOf(event));
      if (!current) return;
      pointerId = event.pointerId;
      setDraft(current);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

    dom.addEventListener("pointerdown", onPointerDown, true);
    dom.addEventListener("click", onClickCapture, true);
    return () => {
      dom.removeEventListener("pointerdown", onPointerDown, true);
      dom.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [flow, store, tool]);

  return { draft };
}

/** 触屏与压感笔给真实压力，鼠标恒为 0.5（`pressure` 在鼠标上是 0 或 0.5）。 */
function pressureOf(event: PointerEvent): number {
  if (event.pointerType === "mouse") return 0.5;
  return event.pressure > 0 ? event.pressure : 0.5;
}

/**
 * 「动态尺寸」（§2.10）：缩小时新对象自动粗一档。改的是
 * `tool-store.nextStyle`，所以样式面板显示的也是这一档，不会出现
 * 「面板写着 M、画出来是 L」。
 */
function applyDynamicSize(enabled: boolean, zoom: number): void {
  if (!enabled) return;
  const size = scaledSize(getNextStyle().size, zoom);
  if (size !== getNextStyle().size) setNextStyle({ size });
}

/**
 * 画框（F21 的 `frame` 工具）建的是 `group` 节点，不是白板对象——它要能
 * 绑 worktree、能装节点、能在整理里整块移动，那些都是节点的能力。
 */
function commitFrame(draft: Draft): void {
  const rect = {
    x: Math.min(draft.origin.x, draft.current.x),
    y: Math.min(draft.origin.y, draft.current.y),
    width: Math.abs(draft.current.x - draft.origin.x),
    height: Math.abs(draft.current.y - draft.origin.y),
  };
  const size =
    rect.width < 40 || rect.height < 40
      ? { width: 480, height: 320 }
      : { width: rect.width, height: rect.height };
  const position =
    rect.width < 40 || rect.height < 40
      ? {
          x: draft.origin.x - size.width / 2,
          y: draft.origin.y - size.height / 2,
        }
      : { x: rect.x, y: rect.y };
  useCanvasStore.getState().addNode("group", { position, size });
}
