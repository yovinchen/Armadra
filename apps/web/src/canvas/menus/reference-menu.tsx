import * as React from "react";
import { Link2, Link2Off, RefreshCw } from "lucide-react";

import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { refreshContentReferences } from "../content-links";
import {
  createContentReference,
  findReference,
  referenceTargets,
  removeContentReference,
} from "../create-content-reference";
import { fromItemId, type WhiteboardDoc } from "../whiteboard/model";

/**
 * 「引用到 Agent」子菜单与引用边的菜单项（React Flow 计划 §2.5 / F29，
 * 归属 B5）。
 *
 * 这个文件只导出**菜单项**，不导出整份菜单：白板对象的右键菜单
 * （`menus/item-menu.tsx`）归 B4，引用只是它的一个子菜单。B4 把
 * `<ReferenceSubmenu itemId={…} />` 放进它留的插槽即可，不需要知道引用
 * 是怎么建的。
 *
 * 已经引用过的 Agent 仍然列出来，只是变成「定位」——点它选中那条边而不是
 * 再画一条（§5.2 B5 的「去重定位」）。判定与上限都在
 * `create-content-reference.ts`，与拖线那条路共用一份。
 */

export interface ReferenceSubmenuProps {
  /** 命中的白板对象 id（`wb:<uuid>` 或裸 uuid 都收）。 */
  itemId: string;
}

/**
 * 白板对象右键菜单里的「引用到 Agent」子菜单。
 *
 * 选择器只取 store 里**已经存在的数组**，派生放进 `useMemo`：选择器里
 * `map` 出新对象会让 `useSyncExternalStore` 每次比对都判成变了，React 直接
 * 报 "getSnapshot should be cached" 然后死循环（这一条是真机上撞出来的）。
 */
export function ReferenceSubmenu({ itemId }: ReferenceSubmenuProps) {
  const t = useT();
  const document = useCanvasStore((state) => state.document);
  const rows = useCanvasStore((state) => state.whiteboard.references);
  const targets = React.useMemo(
    () =>
      referenceTargets(document).map((node) => ({
        id: node.id,
        title: node.title,
      })),
    [document],
  );
  const linked = React.useMemo(() => {
    const bare = fromItemId(itemId);
    return new Set(
      rows
        .filter((reference) => reference.itemId === bare)
        .map((reference) => reference.nodeId),
    );
  }, [itemId, rows]);

  if (targets.length === 0) {
    return (
      <ContextMenuItem disabled>
        <Link2 />
        {t("shape.noAgents")}
      </ContextMenuItem>
    );
  }

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Link2 />
        {t("shape.referenceAgent")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {targets.map((node) => (
          <ContextMenuItem
            key={node.id}
            onSelect={() => createContentReference(itemId, node.id)}
          >
            {linked.has(node.id) ? <Link2Off /> : <Link2 />}
            {node.title}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

export interface ReferenceEdgeMenuItemsProps {
  /** 引用行的 id，也是 React Flow 上那条边的 id。 */
  referenceId: string;
}

/**
 * 引用边右键菜单里的两项：删除这条引用、重新同步全部引用。
 *
 * B4 的 `menus/edge-menu.tsx` 在命中的边是 `reference` 类型时渲染它们。
 * 「删除」只删引用行，白板对象本身不动。
 */
export function ReferenceEdgeMenuItems({
  referenceId,
}: ReferenceEdgeMenuItemsProps) {
  const t = useT();
  return (
    <>
      <ContextMenuItem onSelect={() => refreshContentReferences()}>
        <RefreshCw />
        {t("shape.refreshReference")}
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        onSelect={() => removeContentReference(referenceId)}
      >
        <Link2Off />
        {t("shape.removeReference")}
      </ContextMenuItem>
    </>
  );
}

/**
 * 这条边是不是一条内容引用（`edge-menu.tsx` 用它分流）。
 *
 * 纯函数，白板文档从外面喂进来：`edge-menu` 把它塞进 zustand 的选择器，
 * 得到的是一个布尔量，菜单不会因为引用数组换了身份（导出状态机每两秒推
 * 一次）而白重渲一遍。
 */
export function isReferenceEdgeId(
  whiteboard: WhiteboardDoc,
  edgeId: string,
): boolean {
  return whiteboard.references.some((reference) => reference.id === edgeId);
}

export { findReference };
