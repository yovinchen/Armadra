import type { CanvasNodeType, Position, Size, Viewport } from "@armadra/shared";

import { getFlow, getFlowContainer, screenToPage } from "./flow/flow-context";
import type { Box } from "./geometry";
import { useCanvasStore } from "../store/canvas-store";
import { defaultNodeSize } from "../store/defaults";

/**
 * 新建节点的落点 —— 画布平台设计 §3.2。
 *
 * 两条规则，别处不再各写一份：
 *
 * 1. 落点是**中心**，不是左上角。以前把视口中心直接当 `position`（左上角），
 *    一个 640×440 的终端有一半在屏幕外。
 * 2. 压在别的节点上就让开。连着建四个节点时它们过去全叠在同一个像素上，
 *    现在按 32px 级联，第一个空位就落下。
 *
 * 纯几何（`placeNode` / `centeredAt`）不碰 store，单测直接喂矩形；
 * `nodeDropPosition` 是它在运行时的入口，负责把当前文档与可见区域喂进去。
 */

/** 级联步长：一步既看得出错位，又不至于把节点甩出视口。 */
export const CASCADE_STEP = 32;

/** 最多让 24 步（±768px）；再让下去就不是「附近的空位」了。 */
const MAX_CASCADE_STEPS = 24;

export interface PlacementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 把 `size` 的矩形摆成以 `anchor` 为中心，返回左上角。 */
export function centeredAt(anchor: Position, size: Size): Position {
  return {
    x: Math.round(anchor.x - size.width / 2),
    y: Math.round(anchor.y - size.height / 2),
  };
}

function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function within(box: Box, rect: PlacementRect): boolean {
  return (
    box.x >= rect.x &&
    box.y >= rect.y &&
    box.x + box.width <= rect.x + rect.width &&
    box.y + box.height <= rect.y + rect.height
  );
}

/**
 * 候选落点：正中，然后沿对角线按 `CASCADE_STEP` 往右下、往左上交替让。
 *
 * `visible` 给了就把整块都装不进视口的那些候选筛掉——宁可叠着，也不要把
 * 节点建在看不见的地方。正中那一个永远保留：节点比视口还大时它是唯一
 * 合理的落点。
 */
function candidates(
  start: Position,
  size: Size,
  visible: PlacementRect | null,
): Position[] {
  const list = [start];
  for (let step = 1; step <= MAX_CASCADE_STEPS; step += 1) {
    const offset = step * CASCADE_STEP;
    for (const delta of [offset, -offset]) {
      const position = { x: start.x + delta, y: start.y + delta };
      if (visible && !within({ ...position, ...size }, visible)) continue;
      list.push(position);
    }
  }
  return list;
}

/**
 * 以 `anchor` 为中心找落点，尽量不压住 `taken`。
 *
 * 两轮：
 *
 * 1. 挑第一个**完全不重叠**的候选。画布空的时候这就是正中那一个。
 * 2. 都重叠（画布挤满，或视口只装得下一两个节点）时退一步：挑第一个跟所有
 *    已有节点**左上角都不重合**的候选。窗口式地错开 32px 的两张卡片各自还
 *    抓得住标题栏，完全重合的两张抓不住——这才是「叠在一起」真正的毛病。
 * 3. 连这个都找不到就落在正中，绝不返回视口外的坐标。
 */
export function placeNode(
  anchor: Position,
  size: Size,
  taken: readonly Box[],
  visible: PlacementRect | null = null,
): Position {
  const start = centeredAt(anchor, size);
  const list = candidates(start, size, visible);

  const clear = list.find(
    (position) =>
      !taken.some((box) => intersects({ ...position, ...size }, box)),
  );
  if (clear) return clear;

  const staggered = list.find(
    (position) =>
      !taken.some(
        (box) =>
          Math.abs(box.x - position.x) < CASCADE_STEP &&
          Math.abs(box.y - position.y) < CASCADE_STEP,
      ),
  );
  return staggered ?? start;
}

/* -------------------------------------------------------------------------- */

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
 * 优先量**画布容器**而不是窗口：左侧栏占掉的那一条不是画布，按窗口中心算
 * 会把节点往右推半个侧栏宽。容器量不出来（画布没挂载、jsdom）时退回窗口
 * 中心配画布存下的视口，再没有就是原点。
 */
export function currentViewportCenter(): Position {
  const rect = visibleRect();
  if (rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 800 : window.innerHeight;
  const screenCenter = { x: width / 2, y: height / 2 };
  const page = screenToPage(screenCenter);
  if (page.x !== screenCenter.x || page.y !== screenCenter.y) return page;

  const viewport = useCanvasStore.getState().document?.board.viewport;
  if (!viewport) return { x: 0, y: 0 };
  return viewportCenter(viewport, width, height);
}

/**
 * 画布可见区域的画布坐标矩形。画布没挂载 / 容器还没量出尺寸时返回 null。
 */
export function visibleRect(): PlacementRect | null {
  const flow = getFlow();
  const container = getFlowContainer();
  if (!flow || !container) return null;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const topLeft = flow.screenToFlowPosition({ x: rect.left, y: rect.top });
  const bottomRight = flow.screenToFlowPosition({
    x: rect.right,
    y: rect.bottom,
  });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

/**
 * 当前文档里参与避让的矩形。
 *
 * 只看顶层节点：组员的 `position` 是相对组框的，混进来会把避让算歪。
 * 顶层节点的绝对坐标就是它自己的 `position`，所以这里不必绕 `nodeBox`
 * ——那条路会把整棵节点渲染树拉进来。
 */
function occupied(): Box[] {
  const document = useCanvasStore.getState().document;
  if (!document) return [];
  return document.nodes
    .filter((node) => !node.parentId)
    .map((node) => {
      const size = node.size ?? defaultNodeSize(node.type);
      return {
        x: node.position.x,
        y: node.position.y,
        width: size.width,
        height: size.height,
      };
    });
}

export interface DropOptions {
  /** 落点中心；默认视口中心。右键菜单传鼠标点。 */
  anchor?: Position;
  /** 覆盖默认尺寸（画框比一个终端稍大，见 `menus/add-menu.ts`）。 */
  size?: Size;
}

/**
 * 新建一个 `type` 节点时的 `position`（左上角）。
 *
 * 所有「没有明确落点」的入口都走这里：Dock 的 `+`、画布右键、命令面板、
 * 抽屉里的各种「在画布上打开」。
 */
export function nodeDropPosition(
  type: CanvasNodeType,
  options: DropOptions = {},
): Position {
  const size = options.size ?? defaultNodeSize(type);
  const anchor = options.anchor ?? currentViewportCenter();
  return placeNode(anchor, size, occupied(), visibleRect());
}
