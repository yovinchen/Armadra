import { Trash2 } from "lucide-react";

import { ContextMenuItem } from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { isReferenceEdgeId, ReferenceEdgeMenuItems } from "./reference-menu";

/**
 * 连线的右键菜单（React Flow 计划 F18 的第四种）。
 *
 * 画布上有两种边，这个菜单按 id 分流：
 *
 *  - **上下文连线**（`document.edges` 的一行）：只有一件事可做，删掉它。
 *    方向、标签、箭头都由两端节点的类型决定（`sync/project.edgeArrowheads`
 *    / `edgeLabelKey`），没有可改的项，所以不摆一个只有一项的子菜单去凑数。
 *  - **内容引用**（`whiteboard.references` 的一行，F29）：重新同步与移除，
 *    两项都在 `reference-menu.tsx`。引用不能走 `removeEdges`——它根本不在
 *    `document.edges` 里，那样删只会静静地什么都不发生。
 *
 * 命中区宽度是 `flow/edges/link-visual.INTERACTION_WIDTH`（24px）：细线
 * 上右键点不中的话，这个菜单等于不存在。
 */
export interface EdgeMenuContentProps {
  /** 右键命中的边 id。 */
  edgeId: string;
}

/** 命中的边在选区里就删整个选区的边，否则只删它自己。 */
export function edgeMenuTargets(
  edgeId: string,
  selectedEdgeIds: readonly string[],
): string[] {
  return selectedEdgeIds.includes(edgeId) ? [...selectedEdgeIds] : [edgeId];
}

export function EdgeMenuContent({ edgeId }: EdgeMenuContentProps) {
  const t = useT();
  const selectedEdgeIds = useCanvasStore((state) => state.selectedEdgeIds);
  // 选择器只回一个布尔量：引用数组本身会随导出状态机反复换身份，订阅它会
  // 让菜单在打开期间白重渲一遍。
  const isReference = useCanvasStore((state) =>
    isReferenceEdgeId(state.whiteboard, edgeId),
  );

  if (isReference) return <ReferenceEdgeMenuItems referenceId={edgeId} />;

  const targetIds = edgeMenuTargets(edgeId, selectedEdgeIds);
  return (
    <ContextMenuItem
      variant="destructive"
      onSelect={() => useCanvasStore.getState().removeEdges(targetIds)}
    >
      <Trash2 />
      {t("edge.remove")}
    </ContextMenuItem>
  );
}
