import * as React from "react";
import {
  getNodesBounds,
  getViewportForBounds,
  useOnViewportChange,
  type Viewport as FlowViewport,
} from "@xyflow/react";
import type { BoardDocument } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { usePreferencesStore } from "@/app/preferences-store";
import type { Box } from "../geometry";
import { initialViewportFor, isDefaultViewport } from "../viewport";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_DURATION,
  ZOOM_STEP,
  clampZoom,
} from "../zoom";
import { containerSize, getFlow } from "./flow-context";

/**
 * 视口（React Flow 计划 §1.2 F10 / §2.9，归属 canvas）。
 *
 * 存储值一直是 React Flow 语义（`{x, y, zoom}`，§3.4），所以打开画布就是
 * `setViewport(board.viewport)`，一行换算都没有。
 *
 * 相机 → 文档是**节流**而不是防抖：连续平移时每 300ms 记一次，松手后最后
 * 一次也会落下。平移不置 dirty，`save/autosave.ts` 有单独的视口通道。
 */

export const CAMERA_THROTTLE_MS = 300;

/** 适应视图时四周留的比例边距。 */
const FIT_PADDING = 0.05;
const FIT_DURATION = 200;

/** 「居中到那个节点」时至少放大到这个比例，否则等于定位到一个点。 */
const CENTER_MIN_ZOOM = 0.6;

/** 视口动画时长：关掉「动画」偏好时为 0（§2.10）。 */
function duration(base: number): number {
  return usePreferencesStore.getState().whiteboard.animation ? base : 0;
}

/** 画布上所有对象的外包围盒；节点、分组与白板对象都算在内。 */
export function visibleBounds(): Box | null {
  const flow = getFlow();
  if (!flow) return null;
  const nodes = flow.getNodes();
  if (nodes.length === 0) return null;
  const rect = getNodesBounds(nodes);
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return null;
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * 适应视图：**只缩小不放大**（§20）。够放得下就停在 100%，
 * Dock 的「适应」与 `canvas.fitView` 走的是同一条路径。
 */
export function fitView(): void {
  const flow = getFlow();
  const bounds = visibleBounds();
  if (!flow || !bounds) return;
  const { width, height } = containerSize();
  if (width <= 0 || height <= 0) return;
  const target = getViewportForBounds(
    { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    width,
    height,
    MIN_ZOOM,
    1,
    FIT_PADDING,
  );
  void flow.setViewport(
    { ...target, zoom: clampZoom(Math.min(target.zoom, 1)) },
    { duration: duration(FIT_DURATION) },
  );
}

/** 缩放到某一档，锚点是容器中心。 */
export function zoomToLevel(level: number): void {
  const flow = getFlow();
  if (!flow) return;
  void flow.zoomTo(clampZoom(level), { duration: duration(ZOOM_DURATION) });
}

export function zoomByStep(direction: 1 | -1): void {
  const flow = getFlow();
  if (!flow) return;
  const current = flow.getViewport().zoom;
  zoomToLevel(direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP);
}

/** 会话侧栏点一行 → 把画布居中到那个节点。 */
export function centerOnNode(nodeId: string): void {
  const flow = getFlow();
  if (!flow) return;
  const node = flow.getNode(nodeId);
  if (!node) return;
  const rect = getNodesBounds([node]);
  const zoom = Math.max(flow.getViewport().zoom, CENTER_MIN_ZOOM);
  void flow.setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, {
    zoom: clampZoom(zoom),
    duration: duration(FIT_DURATION),
  });
}

/**
 * 首次打开一块画布：从没存过视口（或还是默认的 `{0,0,1}`）就按 100% 对齐
 * 内容左上角；存过的视口原样恢复，用户上次停在哪就还在哪。
 */
export function applyBoardViewport(document: BoardDocument): void {
  const persisted = document.board.viewport;
  if (!isDefaultViewport(persisted)) {
    useCanvasStore.getState().setViewport(persisted);
    return;
  }
  useCanvasStore.getState().setViewport(
    initialViewportFor(
      document.nodes.map((node) => ({
        x: node.position.x,
        y: node.position.y,
        parentId: node.parentId ?? null,
      })),
    ),
  );
}

/** 相机 → 文档，节流 300ms。必须在 `<ReactFlow>` 的 provider 之下调用。 */
export function useViewportSync(): void {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<FlowViewport | null>(null);

  const flush = React.useCallback(() => {
    timer.current = null;
    const latest = pending.current;
    if (!latest) return;
    useCanvasStore.getState().setViewport({
      x: latest.x,
      y: latest.y,
      zoom: clampZoom(latest.zoom),
    });
  }, []);

  useOnViewportChange({
    onChange: React.useCallback(
      (viewport: FlowViewport) => {
        pending.current = viewport;
        if (timer.current) return;
        timer.current = setTimeout(flush, CAMERA_THROTTLE_MS);
      },
      [flush],
    ),
    // 松手时立刻落一次：节流窗口里的最后一段位移不该等到下一次平移才写。
    onEnd: React.useCallback(
      (viewport: FlowViewport) => {
        pending.current = viewport;
        if (timer.current) clearTimeout(timer.current);
        flush();
      },
      [flush],
    ),
  });

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}

export { MAX_ZOOM, MIN_ZOOM };
