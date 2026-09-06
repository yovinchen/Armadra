import type { Position } from "@armadra/shared";

import { beginCoalesce, endCoalesce } from "@/store/canvas/history";
import { useCanvasStore } from "@/store/canvas-store";
import { isCanvasLocked } from "./canvas-lock";
import { nodeBox, type Box } from "./geometry";
import { tidy, type TidyLink, type TidyOptions } from "./tidy";
import { toItemId, type Item } from "./whiteboard/model";

/**
 * 整理排布的画布侧（React Flow 计划 §1.2 F09，替代 `tidy-editor.ts`）。
 *
 * 算法本身一行没动，还在 `tidy.ts`：连通分量分组 + 按视口宽高比裹行。
 * 这里负责三件事——取矩形、取链接、一次提交。
 *
 * **参与排布的是「顶层对象」**：没有父级的节点与白板对象各算一个矩形。
 * 组员（`parentId` 指向某个 Frame 的节点与白板对象）不单独参与，Frame
 * 整体移动时它们靠相对坐标跟着走，内部布局一点不变。
 *
 * **链接**取两处：`document.edges`（上下文连线）与 `whiteboard.references`
 * （内容引用）。两端各自上溯到自己的顶层容器，连在一起的东西才不会被拆到
 * 画布两头。
 *
 * **一次手势一条历史**：节点走 `moveNodes`、白板对象走 `setWhiteboard`，
 * 两次 commit 由 `beginCoalesce` / `endCoalesce` 合并成一条，所以整理之后
 * 按一下 ⌘Z 就整块回到原位。
 *
 * 锁定视图（`canvas-lock.ts`）时什么都不动：锁的是相机，但「画布自己重排
 * 一遍」比平移更突兀，旧引擎在只读编辑器上也是直接返回空的。
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

/** 顶层白板对象的矩形。id 用 `wb:` 前缀，和节点共用一张排布表。 */
function movableItems(items: readonly Item[]): Movable[] {
  return items
    .filter((item) => !item.parentId)
    .map((item) => ({
      id: toItemId(item.id),
      box: { x: item.x, y: item.y, width: item.w, height: item.h },
    }));
}

/**
 * 连线与引用当链接：两端各自上溯到顶层容器，同一个容器内部的连线忽略。
 *
 * 节点只嵌套一层（组不能进组，沿用 store 的规则），白板对象同理，所以
 * 一次 `parentId` 查表就够，不必像旧引擎那样走祖先链。
 */
function links(ids: ReadonlySet<string>): TidyLink[] {
  const state = useCanvasStore.getState();
  const document = state.document;
  const parentOf = new Map<string, string>();
  for (const node of document?.nodes ?? []) {
    parentOf.set(node.id, node.parentId ?? node.id);
  }
  for (const item of state.whiteboard.items) {
    parentOf.set(toItemId(item.id), item.parentId ?? toItemId(item.id));
  }
  const root = (id: string): string => parentOf.get(id) ?? id;

  const result: TidyLink[] = [];
  const add = (from: string, to: string) => {
    const source = root(from);
    const target = root(to);
    if (source === target) return;
    if (!ids.has(source) || !ids.has(target)) return;
    result.push({ source, target });
  };
  for (const edge of document?.edges ?? []) add(edge.source, edge.target);
  for (const reference of state.whiteboard.references) {
    add(toItemId(reference.itemId), reference.nodeId);
  }
  return result;
}

/**
 * 把整块画布重排一次，保持内容包围盒的左上角不动。
 *
 * 返回值只给测试用：真正的效果是一次 `moveNodes` + 一次 `setWhiteboard`，
 * 合并成一条历史。
 */
export function arrangeCanvas(
  options: TidyOptions = {},
): Record<string, Position> {
  if (isCanvasLocked()) return {};
  const state = useCanvasStore.getState();
  const items = state.whiteboard.items;
  const movable = [...movableNodes(), ...movableItems(items)];
  if (movable.length === 0) return {};

  const ids = new Set(movable.map((entry) => entry.id));
  const positions = tidy(
    movable.map((entry) => ({
      id: entry.id,
      width: Math.max(1, entry.box.width),
      height: Math.max(1, entry.box.height),
    })),
    links(ids),
    options,
  );

  // 排布结果的原点是 (0,0)；平移回原来那块内容的左上角，画布不会突然跳走。
  const originX = Math.min(...movable.map((entry) => entry.box.x));
  const originY = Math.min(...movable.map((entry) => entry.box.y));
  const nodeMoves: { id: string; position: Position }[] = [];
  const itemMoves = new Map<string, Position>();
  const applied: Record<string, Position> = {};

  for (const entry of movable) {
    const packed = positions[entry.id];
    if (!packed) continue;
    const position = { x: originX + packed.x, y: originY + packed.y };
    applied[entry.id] = position;
    if (position.x === entry.box.x && position.y === entry.box.y) continue;
    if (ids.has(entry.id) && entry.id.startsWith("wb:")) {
      itemMoves.set(entry.id, position);
    } else {
      nodeMoves.push({ id: entry.id, position });
    }
  }
  if (nodeMoves.length === 0 && itemMoves.size === 0) return applied;

  // 一条历史：两次 commit 并成一次（§2.7 的合并会话）。
  beginCoalesce("canvas.tidy");
  try {
    if (nodeMoves.length > 0) useCanvasStore.getState().moveNodes(nodeMoves);
    if (itemMoves.size > 0) {
      const current = useCanvasStore.getState().whiteboard;
      useCanvasStore.getState().setWhiteboard({
        ...current,
        items: current.items.map((item) => {
          const move = itemMoves.get(toItemId(item.id));
          return move ? { ...item, x: move.x, y: move.y } : item;
        }),
      });
    }
  } finally {
    endCoalesce();
  }
  return applied;
}
