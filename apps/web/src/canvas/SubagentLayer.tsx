import * as React from "react";
import type { CanvasNode } from "@armadra/shared";

import {
  useAllSubagentCards,
  useSubagentEvents,
  subagentNodeId,
  type SubagentCardModel,
} from "@/agent/subagent-store";
import { useCanvasStore } from "@/store/canvas-store";
import { nodeBox } from "./geometry";

/**
 * 子代理临时卡片的摆位（§3.4 / §5.9 / §4.4）。
 *
 * 卡片不是 shape：不可选中、不可拖拽、不可删除、不进撤销、不落盘。
 * 它们由 `overlays/CanvasOverlays.tsx` 在 `components.OnTheCanvas` 里按
 * **页面坐标**绝对定位，所以跟着相机缩放平移，一行对齐 CSS 都不用写。
 */

/** 折叠状态下的卡片高度（`SubagentCard` 的头部是 28px + 1px 边）。 */
export const CARD_HEIGHT = 30;
/** 卡片之间的垂直间距。 */
export const CARD_GAP = 12;
/** 第一张卡距父节点底边的距离。 */
export const CARD_OFFSET = 24;
export const CARD_MIN_WIDTH = 240;
export const CARD_MAX_WIDTH = 420;

export interface SubagentPlacement {
  /** 与 `derived-edges` 的 target 对齐：`subagentNodeId(card.id)`。 */
  id: string;
  card: SubagentCardModel;
  x: number;
  y: number;
  width: number;
}

/**
 * 卡片 → 页面坐标。父节点不在画布上（刚被删掉、或在别的画布）时直接跳过：
 * 一张飘在原点的卡片比没有卡片更糟。
 */
export function buildSubagentPlacements(
  documentNodes: readonly CanvasNode[],
  cards: Readonly<Record<string, readonly SubagentCardModel[]>>,
): SubagentPlacement[] {
  const out: SubagentPlacement[] = [];
  for (const parent of documentNodes) {
    const list = cards[parent.id];
    if (!list || list.length === 0) continue;
    // 折叠起来的父节点不占它原本的高度，卡片跟着贴上去。
    const box = nodeBox(documentNodes, parent);
    const height = parent.collapsed ? 40 : box.height;
    const width = Math.min(Math.max(box.width, CARD_MIN_WIDTH), CARD_MAX_WIDTH);
    list.forEach((card, index) => {
      out.push({
        id: subagentNodeId(card.id),
        card,
        x: box.x,
        y: box.y + height + CARD_OFFSET + index * (CARD_HEIGHT + CARD_GAP),
        width,
      });
    });
  }
  return out;
}

/** 覆盖层每次渲染取一次。 */
export function useSubagentPlacements(): SubagentPlacement[] {
  useSubagentEvents();
  const documentNodes = useCanvasStore((state) => state.document?.nodes);
  const cards = useAllSubagentCards();

  return React.useMemo(
    () => buildSubagentPlacements(documentNodes ?? [], cards),
    [cards, documentNodes],
  );
}
