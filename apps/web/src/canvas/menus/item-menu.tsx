import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  StickyNote,
  Trash2,
} from "lucide-react";

import { ContextMenuItem, ContextMenuSeparator } from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import type { Item } from "../whiteboard/model";
import {
  addItems,
  createItemId,
  itemsByIds,
  removeItems,
  reorder,
  select,
} from "../whiteboard/store";
import { ReferenceMenuItems } from "./ReferenceMenuItems";

/**
 * 白板对象的右键菜单（React Flow 计划 F18；原 `shape-menu.tsx`）。
 *
 * 层级（置顶 / 置底）走 `whiteboard.reorder`，复制与删除走
 * `whiteboard.addItems / removeItems`，「转成便签」把白板上的文字变成一张
 * `sticky` 节点——同一段话从「画上的批注」升级成「文档里的一条记录」，
 * 它此后能连线、能被 Agent 读、能自动保存进 `nodes` 表。
 *
 * 颜色、粗细、填充不在这里：它们归样式面板（`whiteboard/StylePanel.tsx`），
 * 一份样式两个入口只会互相打架。
 *
 * 「引用到 Agent」子菜单在 `ReferenceMenuItems.tsx`（B5 填）。
 */

/** 复制出来的对象相对原件的偏移（画布单位），和粘贴的手感一致。 */
const DUPLICATE_OFFSET = 16;

export interface ItemMenuContentProps {
  /** 右键命中的白板对象 id（`wb:<uuid>`）。 */
  itemId: string;
}

/** 命中的对象在选区里就作用于整个选区，否则只作用于它自己（与节点菜单同规则）。 */
export function itemMenuTargets(
  itemId: string,
  selectedItemIds: readonly string[],
): string[] {
  return selectedItemIds.includes(itemId) ? [...selectedItemIds] : [itemId];
}

/** 能转成便签的对象：有文字的那些（文字对象，或带标签的几何形）。 */
export function stickyTextOf(items: readonly Item[]): string {
  return items
    .map((item) =>
      item.kind === "text"
        ? item.text
        : item.kind === "shape"
          ? (item.label ?? "")
          : "",
    )
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export function ItemMenuContent({ itemId }: ItemMenuContentProps) {
  const t = useT();
  const selectedItemIds = useCanvasStore((state) => state.selectedItemIds);
  const targetIds = itemMenuTargets(itemId, selectedItemIds);
  // 菜单打开的这一帧读一次文档就够：Radix 的菜单是模态的，展开期间
  // 白板不会在背后变。
  const targets = itemsByIds(targetIds);
  const stickyText = stickyTextOf(targets);

  const duplicate = () => {
    const copies = targets.map((item) => ({
      ...item,
      id: createItemId(),
      // 复制出来的一律落在页面级：组员的坐标相对 Frame，带着 `parentId`
      // 复制会让偏移量落在另一个坐标系里。
      parentId: null,
      x: item.x + DUPLICATE_OFFSET,
      y: item.y + DUPLICATE_OFFSET,
      z: 0,
    }));
    if (copies.length === 0) return;
    select(addItems(copies, { label: "whiteboard.duplicate" }));
  };

  const toSticky = () => {
    const first = targets[0];
    if (!first || stickyText.length === 0) return;
    useCanvasStore.getState().addNode("sticky", {
      position: { x: first.x, y: first.y },
      data: { kind: "sticky", content: stickyText },
    });
    removeItems(targetIds);
  };

  return (
    <>
      <ContextMenuItem onSelect={() => reorder(targetIds, "front")}>
        <ArrowUpToLine />
        {t("shape.bringToFront")}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => reorder(targetIds, "back")}>
        <ArrowDownToLine />
        {t("shape.sendToBack")}
      </ContextMenuItem>

      <ContextMenuItem onSelect={duplicate}>
        <Copy />
        {t("shape.duplicate")}
      </ContextMenuItem>

      {stickyText.length > 0 ? (
        <ContextMenuItem onSelect={toSticky}>
          <StickyNote />
          {t("shape.toSticky")}
        </ContextMenuItem>
      ) : null}

      <ReferenceMenuItems itemIds={targetIds} />

      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => removeItems(targetIds)}
      >
        <Trash2 />
        {t("shape.delete")}
      </ContextMenuItem>
    </>
  );
}
