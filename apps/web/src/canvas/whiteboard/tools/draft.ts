import type { Position } from "@armadra/shared";

import { getNextStyle, type CanvasToolId } from "../../interaction/tool-store";
import { inkBounds, simplifyPoints, translatePoints } from "../ink";
import { lineBounds } from "../geometry";
import { strokeWidth } from "../palette";
import {
  type InkItem,
  type InkPoint,
  type Item,
  type ItemStyle,
  type LineItem,
  type LinePoint,
  type ShapeItem,
  type TextItem,
} from "../model";

/**
 * 一次绘制手势的中间状态与落成规则（React Flow 计划 §2.4，归属 whiteboard）。
 *
 * 纯函数 + 一个不含 React 的数据结构：`ToolLayer` 负责收指针，这里负责
 * 「这些点画出来是什么」以及「松手之后落成哪一条对象」。分开是为了让
 * 落成规则（最小尺寸、点集压缩、包围盒外扩）能被单测直接盯住。
 */

export interface DraftBase {
  /** 起手点（画布坐标）。 */
  origin: Position;
  /** 当前点（画布坐标）。 */
  current: Position;
}

export interface InkDraft extends DraftBase {
  kind: "ink";
  highlight: boolean;
  /** 页面坐标的采样点，落成时才平移成相对坐标。 */
  points: InkPoint[];
  style: ItemStyle;
}

export interface ShapeDraft extends DraftBase {
  kind: "shape";
  style: ItemStyle;
  geo: ShapeItem["geo"];
}

export interface LineDraft extends DraftBase {
  kind: "line";
  style: ItemStyle;
  arrowEnd: boolean;
}

export interface FrameDraft extends DraftBase {
  kind: "frame";
}

export type Draft = InkDraft | ShapeDraft | LineDraft | FrameDraft;

/** 拖出来的矩形（起点与当前点的包围盒），四个方向都成立。 */
export function draftRect(draft: DraftBase): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  return {
    x: Math.min(draft.origin.x, draft.current.x),
    y: Math.min(draft.origin.y, draft.current.y),
    w: Math.abs(draft.current.x - draft.origin.x),
    h: Math.abs(draft.current.y - draft.origin.y),
  };
}

/** 点一下没拖动时给的默认尺寸（画布单位）。 */
export const CLICK_SHAPE_SIZE = { w: 160, h: 120 };
export const CLICK_TEXT_WIDTH = 240;
export const CLICK_FRAME_SIZE = { w: 480, h: 320 };

/** 小于这个位移算「点一下」，不算「拖一个框」。 */
export const DRAG_THRESHOLD = 4;

export function isClick(draft: DraftBase): boolean {
  return (
    Math.abs(draft.current.x - draft.origin.x) < DRAG_THRESHOLD &&
    Math.abs(draft.current.y - draft.origin.y) < DRAG_THRESHOLD
  );
}

/* -------------------------------- 起手 ------------------------------------ */

/** 工具 → 这一笔的草稿；`select` / `hand` / `text` 不走草稿，返回 null。 */
export function startDraft(
  tool: CanvasToolId,
  at: Position,
  pressure: number,
): Draft | null {
  const next = getNextStyle();
  const style: ItemStyle = {
    color: next.color,
    size: next.size,
    dash: next.dash,
    fill: next.fill,
  };
  const base = { origin: at, current: at };
  switch (tool) {
    case "draw":
    case "highlight":
      return {
        ...base,
        kind: "ink",
        highlight: tool === "highlight",
        points: [[at.x, at.y, pressure]],
        style: { color: next.color, size: next.size },
      };
    case "geo":
      return { ...base, kind: "shape", style, geo: next.geo };
    case "line":
      return { ...base, kind: "line", style, arrowEnd: false };
    case "arrow":
      return { ...base, kind: "line", style, arrowEnd: true };
    case "frame":
      return { ...base, kind: "frame" };
    default:
      return null;
  }
}

export function extendDraft(
  draft: Draft,
  at: Position,
  pressure: number,
): Draft {
  if (draft.kind !== "ink") return { ...draft, current: at };
  return {
    ...draft,
    current: at,
    points: [...draft.points, [at.x, at.y, pressure]],
  };
}

/* -------------------------------- 落成 ------------------------------------ */

/**
 * 松手：草稿 → 一条白板对象。
 *
 * 返回 null 表示这一笔不落成（拖出来的框太小、墨迹只有一个点又没移动）。
 * Frame 不在这里落成——它建的是 `group` 节点，不是白板对象。
 */
export function commitDraft(
  draft: Draft,
  id: string,
): Exclude<Item, { kind: "image" }> | null {
  if (draft.kind === "ink") return commitInk(draft, id);
  if (draft.kind === "shape") return commitShape(draft, id);
  if (draft.kind === "line") return commitLine(draft, id);
  return null;
}

function commitInk(draft: InkDraft, id: string): InkItem | null {
  if (draft.points.length === 0) return null;
  const width = strokeWidth(draft.style.size) * (draft.highlight ? 4 : 1);
  const simplified = simplifyPoints(draft.points);
  const box = inkBounds(simplified, width);
  if (!(box.w > 0) || !(box.h > 0)) return null;
  return {
    id,
    kind: "ink",
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    z: 0,
    parentId: null,
    style: draft.style,
    highlight: draft.highlight,
    points: translatePoints(simplified, -box.x, -box.y),
  };
}

function commitShape(draft: ShapeDraft, id: string): ShapeItem {
  const rect = isClick(draft)
    ? {
        x: draft.origin.x - CLICK_SHAPE_SIZE.w / 2,
        y: draft.origin.y - CLICK_SHAPE_SIZE.h / 2,
        ...CLICK_SHAPE_SIZE,
      }
    : draftRect(draft);
  return {
    id,
    kind: "shape",
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    z: 0,
    parentId: null,
    style: draft.style,
    geo: draft.geo,
    label: "",
  };
}

function commitLine(draft: LineDraft, id: string): LineItem | null {
  if (isClick(draft)) return null;
  const points: LinePoint[] = [
    [draft.origin.x, draft.origin.y],
    [draft.current.x, draft.current.y],
  ];
  const box = lineBounds(points);
  return {
    id,
    kind: "line",
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 1),
    h: Math.max(box.h, 1),
    z: 0,
    parentId: null,
    style: draft.style,
    points: points.map(([x, y]) => [x - box.x, y - box.y] as LinePoint),
    arrowStart: false,
    arrowEnd: draft.arrowEnd,
  };
}

/** 文字工具点一下：一条空文字对象，建好就进编辑（`TextNode.autoEdit`）。 */
export function textItemAt(at: Position, id: string): TextItem {
  const next = getNextStyle();
  return {
    id,
    kind: "text",
    x: at.x,
    y: at.y,
    w: CLICK_TEXT_WIDTH,
    h: 24,
    z: 0,
    parentId: null,
    style: { color: next.color, size: next.size, align: "start" },
    text: "",
  };
}
