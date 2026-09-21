import { ArrowLeft, ArrowLeftRight, ArrowRight, Trash2 } from "lucide-react";

import { ContextMenuItem, ContextMenuSeparator } from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { isReferenceEdgeId, ReferenceEdgeMenuItems } from "./reference-menu";

/**
 * 连线的右键菜单（React Flow 计划 F18 的第四种）。
 *
 * 画布上有两种边，这个菜单按 id 分流：
 *
 *  - **上下文连线**（`document.edges` 的一行）：改角色，或者删掉它。标签与
 *    对等边的箭头仍由两端节点的类型决定（`sync/project.edgeArrowheads` /
 *    `edgeLabelKey`），那些不用人管；要人管的只有**这条线是对等还是主从**
 *    ——它决定对面能不能往这个终端里打字（设计 §2.6），而连线时的那个命名
 *    对话框是可以跳过的，跳过之后这里是唯一能改回来的地方。
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
  // 这条边现在是什么角色：缺席与 `peer` 同义（老画布不补字段）。
  const role = useCanvasStore(
    (state) => state.document?.edges.find((edge) => edge.id === edgeId)?.role,
  );

  if (isReference) return <ReferenceEdgeMenuItems referenceId={edgeId} />;

  const targetIds = edgeMenuTargets(edgeId, selectedEdgeIds);
  // 角色只认**右键命中的那一条**，不跟着选区展开：主从是有方向的，而选区里
  // 每条边的两端各是各的，一次把十条都设成「source 是主」多半不是人想说的话。
  const supervises = role === "supervises";
  return (
    <>
      <ContextMenuItem
        disabled={!supervises}
        onSelect={() => useCanvasStore.getState().setEdgeRole(edgeId, "peer")}
      >
        <ArrowLeftRight />
        {t("edge.role.setPeer")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={supervises}
        onSelect={() =>
          useCanvasStore.getState().setEdgeRole(edgeId, "supervises")
        }
      >
        <ArrowRight />
        {t("edge.role.setSupervises")}
      </ContextMenuItem>
      {/*
        反向：主从边的方向写在两端上，所以「让 target 当主」就是把这条边掉头
        再设主从。一次提交，撤销一步（`store/canvas/edges.reverseEdge`）。
        它永远可点——边已经是主从时它就是「拖反了，换个方向」。
      */}
      <ContextMenuItem
        onSelect={() =>
          useCanvasStore.getState().reverseEdge(edgeId, "supervises")
        }
      >
        <ArrowLeft />
        {t("edge.role.setSupervisesReverse")}
      </ContextMenuItem>

      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => useCanvasStore.getState().removeEdges(targetIds)}
      >
        <Trash2 />
        {t("edge.remove")}
      </ContextMenuItem>
    </>
  );
}
