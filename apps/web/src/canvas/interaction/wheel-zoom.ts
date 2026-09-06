import type { Viewport } from "@armadra/shared";

import { isCanvasLocked } from "../canvas-lock";
import { getFlow, getFlowContainer } from "../flow/flow-context";
import { clampZoom, wheelZoomFactor, zoomAroundPoint } from "../zoom";

/**
 * 节点体上的 ⌘/Ctrl + 滚轮缩放（React Flow 计划 F11 / §6.3 A01）。
 *
 * 为什么不把这一下转发给 `.react-flow__pane` 让 React Flow 去缩放：它判定
 * 「这次滚轮是缩放还是平移」看的是 `useKeyPress(zoomActivationKeyCode)` 的
 * 状态，而那个状态由 **keydown 落在谁身上**决定。焦点在终端（xterm 的隐藏
 * textarea）或编辑器里时，那一串 keydown 归输入框，画布这边的 Meta 可能从
 * 没「按下过」，于是同一个手势在空白处缩放、在终端里变成平移——A01 记的
 * 就是这个。
 *
 * 所以缩放这一路自己算：`canvas/zoom.ts` 里已经有纯函数的倍率与定点公式，
 * 这里只负责把事件坐标换成容器内坐标、把结果写回视口。判定只看事件自己的
 * `metaKey` / `ctrlKey`，与键盘焦点无关。
 *
 * 普通滚轮不经过这里：节点体带 `nowheel`，滚轮归终端的 tmux 滚屏桥与编辑器
 * 自己（A01 的另一半）。
 */

/** 这次滚轮是不是缩放手势（与 `keyboard.ZOOM_ACTIVATION_KEY_CODE` 同一组键）。 */
export function isZoomWheel(event: {
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  return Boolean(event.metaKey || event.ctrlKey);
}

export interface WheelZoomInput {
  deltaY: number;
  clientX: number;
  clientY: number;
}

export interface WheelZoomBounds {
  left: number;
  top: number;
}

/**
 * 一次滚轮 → 新视口。纯函数，坐标全部换算成**画布容器内**的像素。
 *
 * 光标下的那一点在缩放前后不动（`zoomAroundPoint`）：在终端体上按住 ⌘ 滚，
 * 放大的中心就是指针，而不是画布中心。
 */
export function viewportAfterWheelZoom(
  viewport: Viewport,
  event: WheelZoomInput,
  bounds: WheelZoomBounds,
): Viewport {
  const zoom = clampZoom(viewport.zoom * wheelZoomFactor(event.deltaY));
  return zoomAroundPoint(viewport, zoom, {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  });
}

/**
 * 把一次 ⌘/Ctrl + 滚轮落到画布视口上。处理了就返回 true。
 *
 * 画布没挂载（启动页、单测）或锁定视图时什么都不做——锁定锁的就是相机。
 */
export function zoomCanvasByWheel(event: WheelZoomInput): boolean {
  if (isCanvasLocked()) return false;
  const flow = getFlow();
  const container = getFlowContainer();
  if (!flow || !container) return false;
  const rect = container.getBoundingClientRect();
  const next = viewportAfterWheelZoom(flow.getViewport(), event, rect);
  flow.setViewport(next);
  return true;
}
