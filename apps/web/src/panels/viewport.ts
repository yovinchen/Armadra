/**
 * 浮层新建节点时的落点：视口中心。
 *
 * 抽屉和会话侧栏都在画布之外，没有鼠标位置可用，所以统一按当前视口
 * 换算画布坐标；画布自己的右键菜单则用鼠标点。
 */
import type { Position, Viewport } from "@ai-coding-canvas/shared";

import { screenToPage } from "../canvas/editor-context";
import { useCanvasStore } from "../store/canvas-store";

export function viewportCenter(
  viewport: Viewport,
  width: number,
  height: number,
): Position {
  return {
    x: (width / 2 - viewport.x) / viewport.zoom,
    y: (height / 2 - viewport.y) / viewport.zoom,
  };
}

/**
 * 当前视口中心的画布坐标。
 *
 * 画布挂着就问 tldraw（§9.1 的 `screenToPage`，它自己知道容器的位置与
 * 相机）；没挂时退回看板存的视口，再没有就是原点。
 */
export function currentViewportCenter(): Position {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 800 : window.innerHeight;
  const screenCenter = { x: width / 2, y: height / 2 };
  const page = screenToPage(screenCenter);
  if (page.x !== screenCenter.x || page.y !== screenCenter.y) return page;

  const viewport = useCanvasStore.getState().document?.board.viewport;
  if (!viewport) return { x: 0, y: 0 };
  return viewportCenter(viewport, width, height);
}
