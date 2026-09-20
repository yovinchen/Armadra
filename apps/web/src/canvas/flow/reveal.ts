import type { Viewport } from "@armadra/shared";

import type { Box } from "../geometry";
import { clampZoom } from "../zoom";

/**
 * 「新建了一个节点，相机要不要动、动到哪」——只有数学，没有 React。
 *
 * 两条规则，手动新建与 Agent 新建共用同一条（契约 §3.4，2026-09-19 那条
 * 「抬到 100%」是其中第一条）：
 *
 *  1. **缩放太小就抬到 100% 并居中**。默认尺寸是按 100% 设计的，用户停在
 *     27% 这样的总览上新建，拿到的是一张读不了的缩略图。
 *  2. **看不全就居中，缩放不动**。手动新建落在鼠标或视口中心，多半本来就
 *     在眼前，这一条不会触发；Agent 建的节点摆在**发起它的那个节点右边**，
 *     常常整块都在屏幕外——那正是「只出现在角落」的样子。
 *
 * 其余情况一动不动：用户正看着某块区域，抢他的相机是更坏的事。
 */

/** 低于这个缩放就抬到 100%。 */
export const REVEAL_ZOOM_THRESHOLD = 0.5;
export const REVEAL_ZOOM = 1;

/**
 * 判「看得全」时四周留的余量（画布坐标）。
 *
 * 贴着视口边缘算「看得见」会让新节点正好卡在边上还不居中，而那和看不见
 * 差不多；留出一点边距，节点至少要整块落在这圈之内才算数。
 */
export const REVEAL_MARGIN = 24;

export interface CameraTarget {
  /** 居中到这个画布坐标。 */
  x: number;
  y: number;
  zoom: number;
}

/** 视口变换 + 容器像素尺寸 → 画布坐标下的可见矩形。 */
export function visibleBox(
  viewport: Viewport,
  container: { width: number; height: number },
): Box | null {
  const { zoom } = viewport;
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  if (container.width <= 0 || container.height <= 0) return null;
  return {
    x: -viewport.x / zoom,
    y: -viewport.y / zoom,
    width: container.width / zoom,
    height: container.height / zoom,
  };
}

/** `node` 是否整块落在 `visible` 里（带 {@link REVEAL_MARGIN} 余量）。 */
export function fullyVisible(node: Box, visible: Box): boolean {
  return (
    node.x >= visible.x + REVEAL_MARGIN &&
    node.y >= visible.y + REVEAL_MARGIN &&
    node.x + node.width <= visible.x + visible.width - REVEAL_MARGIN &&
    node.y + node.height <= visible.y + visible.height - REVEAL_MARGIN
  );
}

/**
 * 新建节点之后的相机目标；`null` = 不动相机。
 *
 * `container` 量不出来（画布没挂载、单测里没有 DOM）时只剩第一条规则：
 * 缩放太小照样抬，看得全不全无从判断，就不判。
 */
export function cameraForNewNode(input: {
  node: Box;
  viewport: Viewport;
  container: { width: number; height: number };
}): CameraTarget | null {
  const { node, viewport, container } = input;
  if (
    !Number.isFinite(node.width) ||
    !Number.isFinite(node.height) ||
    node.width <= 0 ||
    node.height <= 0
  ) {
    return null;
  }
  const center = {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
  if (viewport.zoom < REVEAL_ZOOM_THRESHOLD) {
    return { ...center, zoom: clampZoom(REVEAL_ZOOM) };
  }
  const visible = visibleBox(viewport, container);
  if (!visible) return null;
  if (fullyVisible(node, visible)) return null;
  return { ...center, zoom: clampZoom(viewport.zoom) };
}
