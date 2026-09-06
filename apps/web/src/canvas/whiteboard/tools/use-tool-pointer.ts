import * as React from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import type { Position } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { canEditCanvas, useCanvasOwnership } from "@/canvas-ownership";
import { useCanvasStore } from "@/store/canvas-store";
import { isCanvasLocked } from "../../canvas-lock";
import {
  getNextStyle,
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

/**
 * 白板工具的指针通道（React Flow 计划 §2.4 / F21–F25，归属 whiteboard）。
 *
 * 不铺一层 `pointer-events: all` 的覆盖层，而是在 React Flow 的容器上装一个
 * **捕获相位**的 `pointerdown`：命中就 `stopPropagation`，d3-drag、框选、
 * 节点拖动全都收不到这一下。这么做有一个覆盖层给不了的好处——滚轮事件
 * 一个都不拦，所以画画的时候仍然能滚轮平移、⌘滚轮缩放，手不用先切回选择。
 *
 * 手形工具也在这里：`flow-options` 只给了中键平移（`panOnDrag: [1]`），
 * 左键留给框选，所以「手」得自己按住左键改视口。
 */

export interface ToolPointerState {
  draft: Draft | null;
  /** 手形工具正在平移；光标要变成攥紧的手。 */
  panning: boolean;
}

/** 吸附到网格（偏好 `snap`）。 */
function snapped(point: Position, grid: number, snap: boolean): Position {
  if (!snap || grid <= 0) return point;
  return {
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid,
  };
}

export function useToolPointer(): ToolPointerState {
  const tool = useTool();
  const flow = useReactFlow();
  const store = useStoreApi();
  const preferences = usePreferencesStore((state) => state.whiteboard);
  const ownership = useCanvasOwnership((state) => state.status);
  const editable = canEditCanvas(ownership);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [panning, setPanning] = React.useState(false);

  // 回调里要读最新的偏好，但 effect 不该因为改了一次网格间距就重挂。
  const latest = React.useRef({ preferences, tool, editable });
  latest.current = { preferences, tool, editable };

  React.useEffect(() => {
    const dom = store.getState().domNode;
    if (!dom) return;
    if (tool === "select") return;

    let pointerId: number | null = null;
    let current: Draft | null = null;

    const pageOf = (event: PointerEvent): Position =>
      snapped(
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        latest.current.preferences.gridSize,
        latest.current.preferences.snap,
      );

    /* ------------------------------ 手形 -------------------------------- */

    let panFrom: { x: number; y: number; vx: number; vy: number } | null = null;

    const panMove = (event: PointerEvent) => {
      if (!panFrom) return;
      const viewport = flow.getViewport();
      flow.setViewport({
        x: panFrom.vx + (event.clientX - panFrom.x),
        y: panFrom.vy + (event.clientY - panFrom.y),
        zoom: viewport.zoom,
      });
    };

    const panEnd = () => {
      panFrom = null;
      setPanning(false);
      window.removeEventListener("pointermove", panMove);
      window.removeEventListener("pointerup", panEnd);
    };

    /* ------------------------------ 绘制 -------------------------------- */

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
      if (event.button !== 0) return;
      // 样式面板、锁按钮、节点体里的输入框不归工具管。
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable='true']")
      ) {
        return;
      }
      const active = latest.current;
      if (active.tool === "hand") {
        event.stopPropagation();
        event.preventDefault();
        const viewport = flow.getViewport();
        panFrom = {
          x: event.clientX,
          y: event.clientY,
          vx: viewport.x,
          vy: viewport.y,
        };
        setPanning(true);
        window.addEventListener("pointermove", panMove);
        window.addEventListener("pointerup", panEnd);
        return;
      }
      if (isCanvasLocked() || !active.editable) return;
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
    return () => {
      dom.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      panEnd();
    };
  }, [flow, store, tool]);

  return { draft, panning };
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
