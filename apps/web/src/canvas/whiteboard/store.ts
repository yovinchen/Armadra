import type { Position } from "@armadra/shared";

import {
  beginCoalesce,
  endCoalesce,
  useCanvasStore,
  type CommitOptions,
} from "@/store/canvas-store";
import {
  fromItemId,
  toItemId,
  type Item,
  type ItemStyle,
  type Reference,
  type WhiteboardDoc,
} from "./model";

/**
 * 白板文档的动作（React Flow 计划 §2.4 / §2.11，归属 whiteboard）。
 *
 * 这些不是一个独立的 store：白板与画布文档必须在**同一份内存真相**里，
 * 否则撤销栈没法把「删一个节点顺带删掉指向它的引用」记成一条。所以每个
 * 动作都是「读 `canvas-store.whiteboard` → 算出新文档 → `setWhiteboard`」，
 * 置脏与历史由 `setWhiteboard` 统一做（AGENTS.md：画布修改经 canvas-store
 * 动作）。
 *
 * id 一律两头都收：文档里存的是裸 uuid，React Flow 上是 `wb:<uuid>`，
 * 调用方（工具、剪贴板、右键菜单、B1 的整理、B5 的引用）不该为这件事分心。
 *
 * 手势（拖动、resize、文字编辑）用 `beginGesture` / `endGesture` 把一串
 * 逐帧写入合并成一条历史（`store/canvas/history.ts` 的 coalesce）。
 */

/* -------------------------------- 读 -------------------------------------- */

export function whiteboardDoc(): WhiteboardDoc {
  return useCanvasStore.getState().whiteboard;
}

export function itemById(id: string): Item | null {
  const bare = fromItemId(id);
  return whiteboardDoc().items.find((item) => item.id === bare) ?? null;
}

export function itemsByIds(ids: readonly string[]): Item[] {
  const wanted = new Set(ids.map(fromItemId));
  return whiteboardDoc().items.filter((item) => wanted.has(item.id));
}

/** 当前选中的白板对象（`selectedItemIds` 存的是带前缀的 id）。 */
export function selectedItems(): Item[] {
  return itemsByIds(useCanvasStore.getState().selectedItemIds);
}

/** 下一个对象的 `z`：永远落在最上面。 */
export function nextZ(): number {
  const items = whiteboardDoc().items;
  return items.reduce((top, item) => Math.max(top, item.z), 0) + 1;
}

export function createItemId(): string {
  return crypto.randomUUID();
}

/* -------------------------------- 写 -------------------------------------- */

function apply(
  mutate: (doc: WhiteboardDoc) => WhiteboardDoc | null,
  options: CommitOptions = {},
): void {
  const state = useCanvasStore.getState();
  const next = mutate(state.whiteboard);
  if (!next || next === state.whiteboard) return;
  state.setWhiteboard(next, options);
}

/** 新建对象。传进来的 `z` 为 0 时自动排到最上面。 */
export function addItems(
  items: readonly Item[],
  options: CommitOptions = {},
): string[] {
  if (items.length === 0) return [];
  let top = nextZ();
  const placed = items.map((item) => ({
    ...item,
    z: item.z || top++,
  }));
  apply((doc) => ({ ...doc, items: [...doc.items, ...placed] }), {
    label: "whiteboard.add",
    ...options,
  });
  return placed.map((item) => item.id);
}

export interface ItemPatch {
  id: string;
  patch: Partial<Item>;
}

/** 一次改一条。样式面板与文字编辑走这条。 */
export function updateItem(
  id: string,
  patch: Partial<Item>,
  options: CommitOptions = {},
): void {
  updateItems([{ id, patch }], options);
}

/**
 * 一次改多条（样式面板改整个选区）。
 *
 * `kind` 与 `id` 永远不接受覆盖：换类型等于换一条对象，那是删加建，
 * 不是改。
 */
export function updateItems(
  patches: readonly ItemPatch[],
  options: CommitOptions = {},
): void {
  if (patches.length === 0) return;
  const byId = new Map(patches.map(({ id, patch }) => [fromItemId(id), patch]));
  apply(
    (doc) => {
      let changed = false;
      const items = doc.items.map((item) => {
        const patch = byId.get(item.id);
        if (!patch) return item;
        changed = true;
        return { ...item, ...patch, id: item.id, kind: item.kind } as Item;
      });
      return changed ? { ...doc, items } : null;
    },
    { label: "whiteboard.update", ...options },
  );
}

/** 拖动落位（B1 的 `tidy-flow` 也调这个）。 */
export function moveItems(
  moves: readonly { id: string; position: Position }[],
  options: CommitOptions = {},
): void {
  if (moves.length === 0) return;
  const byId = new Map(
    moves.map(({ id, position }) => [fromItemId(id), position]),
  );
  apply(
    (doc) => {
      let changed = false;
      const items = doc.items.map((item) => {
        const position = byId.get(item.id);
        if (!position || (position.x === item.x && position.y === item.y)) {
          return item;
        }
        changed = true;
        return { ...item, x: position.x, y: position.y };
      });
      return changed ? { ...doc, items } : null;
    },
    { label: "whiteboard.move", ...options },
  );
}

export interface ItemBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * resize 一条对象。
 *
 * 墨迹与直线的点集要跟着缩，否则线会留在原来的大小里；缩放比例由旧尺寸
 * 与新尺寸算，宽或高为 0 时按 1 处理（`ink.scaleInk` 自己兜底）。
 */
export function resizeItem(
  id: string,
  box: ItemBox,
  options: CommitOptions = {},
): void {
  const bare = fromItemId(id);
  apply(
    (doc) => {
      let changed = false;
      const items = doc.items.map((item) => {
        if (item.id !== bare) return item;
        changed = true;
        return resized(item, box);
      });
      return changed ? { ...doc, items } : null;
    },
    { label: "whiteboard.resize", ...options },
  );
}

function resized(item: Item, box: ItemBox): Item {
  const scaleX = item.w > 0 ? box.w / item.w : 1;
  const scaleY = item.h > 0 ? box.h / item.h : 1;
  const base = { ...item, x: box.x, y: box.y, w: box.w, h: box.h };
  if (item.kind === "ink") {
    return {
      ...base,
      kind: "ink",
      points: item.points.map(([x, y, pressure]) => [
        x * scaleX,
        y * scaleY,
        pressure,
      ]),
    } as Item;
  }
  if (item.kind === "line") {
    return {
      ...base,
      kind: "line",
      points: item.points.map(([x, y]) => [x * scaleX, y * scaleY]),
    } as Item;
  }
  return base as Item;
}

/**
 * 删除对象，并把指向它们的引用一起删掉。
 *
 * 引用指向一条不存在的对象时投影不出边来（`sync/project.ts` 会跳过），
 * 但那条记录会一直留在 `whiteboard_json` 里，撤销时又会连着复活出来，
 * 所以在这里一次清干净。
 */
export function removeItems(
  ids: readonly string[],
  options: CommitOptions = {},
): void {
  if (ids.length === 0) return;
  const doomed = new Set(ids.map(fromItemId));
  apply(
    (doc) => {
      const items = doc.items.filter((item) => !doomed.has(item.id));
      const references = doc.references.filter(
        (reference) => !doomed.has(fromItemId(reference.itemId)),
      );
      if (
        items.length === doc.items.length &&
        references.length === doc.references.length
      ) {
        return null;
      }
      return { ...doc, items, references };
    },
    { label: "whiteboard.remove", ...options },
  );
  const state = useCanvasStore.getState();
  const remaining = state.selectedItemIds.filter(
    (id) => !doomed.has(fromItemId(id)),
  );
  if (remaining.length !== state.selectedItemIds.length) {
    state.setSelection({ items: remaining });
  }
}

/** 置顶 / 置底（`z` 就是 React Flow 的 `zIndex`）。 */
export function reorder(
  ids: readonly string[],
  to: "front" | "back",
  options: CommitOptions = {},
): void {
  if (ids.length === 0) return;
  const moved = new Set(ids.map(fromItemId));
  apply(
    (doc) => {
      const others = doc.items.filter((item) => !moved.has(item.id));
      if (others.length === doc.items.length) return null;
      const top = others.reduce((max, item) => Math.max(max, item.z), 0);
      const bottom = others.reduce((min, item) => Math.min(min, item.z), 0);
      let index = 0;
      const items = doc.items.map((item) =>
        moved.has(item.id)
          ? {
              ...item,
              z: to === "front" ? top + 1 + index++ : bottom - 1 - index++,
            }
          : item,
      );
      return { ...doc, items };
    },
    { label: "whiteboard.reorder", ...options },
  );
}

/** 只选中这些白板对象（节点与连线的选区一并清空）。 */
export function select(ids: readonly string[]): void {
  useCanvasStore.getState().setSelection({
    nodes: [],
    edges: [],
    items: ids.map(toItemId),
  });
}

/* -------------------------------- 引用 ------------------------------------ */

/** 内容引用（B5 调用）。同一对同一节点只留一条。 */
export function addReference(
  reference: Reference,
  options: CommitOptions = {},
): void {
  apply(
    (doc) => {
      const itemId = fromItemId(reference.itemId);
      const exists = doc.references.some(
        (existing) =>
          fromItemId(existing.itemId) === itemId &&
          existing.nodeId === reference.nodeId,
      );
      if (exists) return null;
      return {
        ...doc,
        references: [...doc.references, { ...reference, itemId }],
      };
    },
    { label: "whiteboard.reference", ...options },
  );
}

export function removeReferences(
  ids: readonly string[],
  options: CommitOptions = {},
): void {
  if (ids.length === 0) return;
  const doomed = new Set(ids);
  apply(
    (doc) => {
      const references = doc.references.filter(
        (reference) => !doomed.has(reference.id),
      );
      return references.length === doc.references.length
        ? null
        : { ...doc, references };
    },
    { label: "whiteboard.reference", ...options },
  );
}

/** 引用总数（`referenceCountForNode ≥ 64` 的上限判定，B5 用）。 */
export function referenceCountForNode(nodeId: string): number {
  return whiteboardDoc().references.filter(
    (reference) => reference.nodeId === nodeId,
  ).length;
}

/* -------------------------------- 整份文档 --------------------------------- */

export function setWhiteboard(
  doc: WhiteboardDoc,
  options: CommitOptions = {},
): void {
  useCanvasStore.getState().setWhiteboard(doc, options);
}

/* -------------------------------- 手势 ------------------------------------ */

/**
 * 一次手势 = 一条历史。
 *
 * 拖动与 resize 每帧都要写文档（白板对象没有 `flow/drafts.ts` 那条草稿
 * 通道），所以进入手势时开一个合并会话，松手时关掉，整段只入栈一条。
 */
export function beginGesture(label: string): void {
  beginCoalesce(label);
}

export function endGesture(): void {
  endCoalesce();
}

/* -------------------------------- 样式 ------------------------------------ */

/** 选区里第一条对象的样式；样式面板用它显示当前值。 */
export function styleOfSelection(): ItemStyle | null {
  return selectedItems()[0]?.style ?? null;
}
