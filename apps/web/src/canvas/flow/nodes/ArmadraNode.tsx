import * as React from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@armadra/shared";

import {
  COLLAPSED_HEIGHT,
  NODE_BODY,
  NODE_META,
  NODE_SHELL_SELF,
  type NodeBodyProps,
} from "@/nodes/registry";
import { NodeShell } from "@/nodes/NodeShell";
import { useCanvasStore } from "@/store/canvas-store";
import { clearDrafts, setDraft } from "../drafts";
import type { ArmadraFlowNode } from "../../sync/project";

/**
 * 节点承载（React Flow 计划 F01–F04，归属 canvas）。
 *
 * 一种自定义节点类型装下七种节点体：`data` 就是 `CanvasNode`，内容还是现有的
 * `NodeShell` + `NODE_BODY[nodeType]`，节点体代码一行没动。分组不走这里
 * （`GroupNode.tsx`）。
 *
 * 与旧引擎相比有三处不同的地方：
 *
 *  1. **拖拽只从头部起。** `dragHandle: ".drag-handle"` 在投影时给的
 *     （`sync/project.ts`），所以节点体不必再拦指针事件——点终端就是点终端，
 *     顺带把节点选中（§1.3 有意为之）。
 *  2. **不做视口裁剪。** `onlyRenderVisibleElements` 关着：终端一旦卸载，
 *     xterm 的 `fit()` 会量到 0×0，回到视口时行列数就错了。
 *  3. **resize 把手是真的 DOM 元素**（`NodeResizer`），不再是画在叠加层上的
 *     几何，所以 `pointsAtOverlay` 那一套命中猜测整个删掉了。
 */

/** 手势进行中不写文档：草稿在 `flow/drafts.ts`，松手才提交（§2.1 规则 2）。 */
function onResize(
  id: string,
  params: { x: number; y: number; width: number; height: number },
): void {
  setDraft(id, {
    position: { x: params.x, y: params.y },
    size: { width: params.width, height: params.height },
  });
}

function onResizeEnd(
  node: CanvasNode,
  params: { x: number; y: number; width: number; height: number },
): void {
  clearDrafts([node.id]);
  const min = NODE_META[node.type].minSize;
  const size = {
    width: Math.max(min.width, Math.round(params.width)),
    height: node.collapsed
      ? COLLAPSED_HEIGHT
      : Math.max(min.height, Math.round(params.height)),
  };
  const position = { x: Math.round(params.x), y: Math.round(params.y) };
  useCanvasStore.getState().resizeNode(node.id, size, position);
}

export function ArmadraNode({
  id,
  data,
  selected = false,
}: NodeProps<ArmadraFlowNode>) {
  const node = data;
  const meta = NODE_META[node.type];
  const collapsed = node.collapsed === true;
  const focused = useCanvasStore((state) => state.focusNodeId === id);

  const bodyProps: NodeBodyProps = {
    id,
    node,
    selected,
    collapsed,
    focused,
  };
  const Body = NODE_BODY[node.type];

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={meta.minSize.width}
        // 折叠时高度钉死在 40px：纵向把手拖不动，免得把折叠起来的节点
        // 拉成一条长条（旧引擎 `onResize` 里的同一条规则）。
        minHeight={collapsed ? COLLAPSED_HEIGHT : meta.minSize.height}
        maxHeight={collapsed ? COLLAPSED_HEIGHT : undefined}
        onResize={(_event, params) => onResize(id, params)}
        onResizeEnd={(_event, params) => onResizeEnd(node, params)}
      />
      {/* 头部插槽住在节点体里的类型（终端、编辑器、变更、文件、浏览器、
          两张自动化卡）自己渲染 `NodeShell`；其余（便签）走通用包壳。 */}
      {NODE_SHELL_SELF.has(node.type) ? (
        <Body {...bodyProps} />
      ) : (
        <NodeShell node={node} selected={selected}>
          <Body {...bodyProps} />
        </NodeShell>
      )}
    </>
  );
}

export default React.memo(ArmadraNode);
