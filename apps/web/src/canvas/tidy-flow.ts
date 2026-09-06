import type { Position } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { nodeBox, type Box } from "./geometry";
import { tidy, type TidyLink, type TidyOptions } from "./tidy";

/**
 * 整理排布的画布侧（React Flow 计划 §1.2 F09，替代 `tidy-editor.ts`）。
 *
 * 算法本身一行没动，还在 `tidy.ts`：连通分量分组 + 按视口宽高比裹行。
 * 这里只负责「取矩形、取链接、一次提交」——一次提交等于一条历史，
 * 所以整理之后按一下 ⌘Z 就整块回到原位。
 *
 * B0 只排 `document.nodes` 的顶层节点。白板对象（`whiteboard.items`）与
 * 内容引用参与排布是 B1 的事：那时这里再取 `whiteboard.items` 的矩形，
 * 并把 `moveItems` 并进同一次提交。
 */

interface Movable {
  id: string;
  box: Box;
}

/** 顶层节点的矩形；组员跟着自己的 Frame 一起动，不单独参与。 */
function movableNodes(): Movable[] {
  const nodes = useCanvasStore.getState().document?.nodes ?? [];
  return nodes
    .filter((node) => !node.parentId)
    .map((node) => ({ id: node.id, box: nodeBox(nodes, node) }));
}

/** 连线当链接：连在一起的节点排成一组，不会被拆到画布两头。 */
function links(ids: ReadonlySet<string>): TidyLink[] {
  const document = useCanvasStore.getState().document;
  if (!document) return [];
  const parentOf = new Map(
    document.nodes.map((node) => [node.id, node.parentId ?? node.id]),
  );
  const root = (id: string): string => parentOf.get(id) ?? id;
  const result: TidyLink[] = [];
  for (const edge of document.edges) {
    const source = root(edge.source);
    const target = root(edge.target);
    if (source === target) continue;
    if (!ids.has(source) || !ids.has(target)) continue;
    result.push({ source, target });
  }
  return result;
}

/**
 * 把整块画布重排一次，保持内容包围盒的左上角不动。
 *
 * 返回值只给测试用：真正的效果是一次 `moveNodes`。
 */
export function arrangeCanvas(
  options: TidyOptions = {},
): Record<string, Position> {
  const movable = movableNodes();
  if (movable.length === 0) return {};
  const ids = new Set(movable.map((item) => item.id));
  const positions = tidy(
    movable.map((item) => ({
      id: item.id,
      width: Math.max(1, item.box.width),
      height: Math.max(1, item.box.height),
    })),
    links(ids),
    options,
  );

  // 排布结果的原点是 (0,0)；平移回原来那块内容的左上角，画布不会突然跳走。
  const originX = Math.min(...movable.map((item) => item.box.x));
  const originY = Math.min(...movable.map((item) => item.box.y));
  const moves: { id: string; position: Position }[] = [];
  const applied: Record<string, Position> = {};
  for (const item of movable) {
    const packed = positions[item.id];
    if (!packed) continue;
    const position = { x: originX + packed.x, y: originY + packed.y };
    applied[item.id] = position;
    if (position.x === item.box.x && position.y === item.box.y) continue;
    moves.push({ id: item.id, position });
  }
  if (moves.length > 0) useCanvasStore.getState().moveNodes(moves);
  return applied;
}
