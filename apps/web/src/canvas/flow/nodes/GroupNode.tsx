import * as React from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@armadra/shared";

import { NODE_META } from "@/nodes/registry";
import { useCanvasStore } from "@/store/canvas-store";
import { clearDrafts, setDraft } from "../drafts";
import type { ArmadraFlowNode } from "../../sync/project";

/**
 * 分组 = Frame（React Flow 计划 F05，归属 B1 —— 这里是 B0 的最小可用版本）。
 *
 * B0 只做「看得见、拖得动、能 resize、组员跟着走」：标题、色带、
 * `NodeResizer`，其余留给 B1（worktree 绑定徽章、GitHub 关联徽标、
 * 拖放换父的高亮反馈）。组员靠 React Flow 的子流（`parentId` + 相对坐标）
 * 跟着一起动，与文档里的约定本来就一样。
 *
 * **不裁剪子级**（§1.3 的差异）：组员的 `extent` 不设 `"parent"`，
 * 拖出边界仍然可见，拖出去就自动离组（`use-flow-nodes.ts`）。
 */

function onResizeEnd(
  node: CanvasNode,
  params: { x: number; y: number; width: number; height: number },
): void {
  clearDrafts([node.id]);
  const min = NODE_META.group.minSize;
  useCanvasStore.getState().resizeNode(
    node.id,
    {
      width: Math.max(min.width, Math.round(params.width)),
      height: Math.max(min.height, Math.round(params.height)),
    },
    { x: Math.round(params.x), y: Math.round(params.y) },
  );
}

export function GroupNode({
  data,
  selected = false,
}: NodeProps<ArmadraFlowNode>) {
  const node = data;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={NODE_META.group.minSize.width}
        minHeight={NODE_META.group.minSize.height}
        onResize={(_event, params) =>
          setDraft(node.id, {
            position: { x: params.x, y: params.y },
            size: { width: params.width, height: params.height },
          })
        }
        onResizeEnd={(_event, params) => onResizeEnd(node, params)}
      />
      <div
        data-slot="group-frame"
        data-selected={selected ? "true" : undefined}
        className="canvas-group h-full w-full rounded-[var(--r-card)] border"
        style={{ borderColor: node.color }}
      >
        <div className="canvas-group-label" style={{ color: node.color }}>
          {node.title}
        </div>
      </div>
    </>
  );
}

export default React.memo(GroupNode);
