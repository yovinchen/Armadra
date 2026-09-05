import { DEFAULT_VIEWPORT, type Viewport } from "@armadra/shared";

/**
 * 打开画布时的视口（§20「打开比例」）。
 *
 * 结论先行：**首次打开不缩放**。以前这里是 `fitView`，节点一多就落到 70%
 * 左右，浏览器节点里的网页被整体缩小、字号发虚——那是缩放画布，不是缩放
 * 网页。所以现在固定 `zoom: 1`，只把画布平移到内容包围盒的左上角，四周留
 * 40px 边距；空画布回到 `{0,0,1}`。
 */

/** 包围盒只需要位置和尺寸；用最小结构，测试不必造整个 `CanvasNode`。 */
export interface ViewportBox {
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  /** 组员坐标是相对组框的，不参与包围盒。 */
  parentId?: string | null;
}

/** 内容左上角到画布左上角的边距（画布像素 = 屏幕像素，因为 zoom 恒为 1）。 */
export const INITIAL_VIEWPORT_MARGIN = 40;

/** 判断一个视口是不是「从没存过」的那个默认值。 */
export function isDefaultViewport(
  viewport: Viewport | null | undefined,
): boolean {
  return (
    !viewport ||
    (viewport.x === DEFAULT_VIEWPORT.x &&
      viewport.y === DEFAULT_VIEWPORT.y &&
      viewport.zoom === DEFAULT_VIEWPORT.zoom)
  );
}

/**
 * 100% 缩放下把内容左上角对齐到 `margin`。
 *
 * 只看顶层节点：组员的 `position` 是相对父组框的，混进来会把包围盒拉歪。
 * 没有可用节点（空画布 / 全是组员）时返回默认视口。
 */
export function initialViewportFor(
  nodes: readonly ViewportBox[],
  margin: number = INITIAL_VIEWPORT_MARGIN,
): Viewport {
  const roots = nodes.filter((node) => !node.parentId);
  if (roots.length === 0) return { ...DEFAULT_VIEWPORT };

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of roots) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { ...DEFAULT_VIEWPORT };
  }

  return { x: margin - minX, y: margin - minY, zoom: 1 };
}
