// B4 重建（并改名 `item-menu.tsx`）：白板对象的右键菜单（F18）。
//
// 层级（置顶 / 置底）走 `whiteboard.reorder`，复制走 `whiteboard/clipboard.ts`，
// 删除走 `whiteboard.removeItems`，「转成便签」把一段白板文字变成 `sticky`
// 节点，「引用到 Agent」子菜单归 B5（B4 先建文件并留插槽）。
//
// 颜色、粗细、填充不在这里：它们归样式面板，一份样式两个入口只会互相打架。
import { Trash2 } from "lucide-react";

import { ContextMenuItem } from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";

export interface ShapeMenuContentProps {
  /** 命中的白板对象 id（`wb:<uuid>`）。 */
  itemId: string;
}

export function ShapeMenuContent({ itemId }: ShapeMenuContentProps) {
  const t = useT();
  return (
    <ContextMenuItem
      variant="destructive"
      data-item-id={itemId}
      disabled
      onSelect={() => {
        // B2/B4: whiteboard.removeItems([itemId])
      }}
    >
      <Trash2 />
      {t("shape.delete")}
    </ContextMenuItem>
  );
}
