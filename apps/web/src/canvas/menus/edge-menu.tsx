import { Trash2 } from "lucide-react";

import { ContextMenuItem } from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 连线的右键菜单（React Flow 计划 F18 的第四种）。
 *
 * 一条边上只有一件事可做：删掉它。方向、标签、箭头都由两端节点的类型
 * 决定（`sync/project.edgeArrowheads` / `edgeLabelKey`），没有可改的项，
 * 所以这里不摆一个只有一项的子菜单去凑数。
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
