import * as React from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@armadra/shared";

import { NODE_META } from "@/nodes/registry";
import { GithubReferenceBadge } from "@/panels/github/GithubReferenceBadge";
import { useCanvasStore } from "@/store/canvas-store";
import { frameBindingOf } from "../../frame-binding";
import { WorktreeBindingBadge } from "../overlays/WorktreeBindingBadge";
import { clearDrafts, setDraft } from "../drafts";
import type { ArmadraFlowNode } from "../../sync/project";
import { ConnectionHandles } from "./ConnectionHandles";

/**
 * 分组 = Frame（React Flow 计划 F05 / F08，归属 B1）。
 *
 * 一个 `group` 节点承载四样东西：标题与色带、`NodeResizer`、worktree 绑定
 * 徽章（G03）、GitHub 关联徽标。后两样在旧引擎里挂在派生层上，靠
 * `nodeBox()` 自己算页面坐标定位；现在 Frame 自己就是一个 DOM 节点，
 * 徽章直接贴在它的标题行下面——坐标换算整段消失，缩放时也不会再有半像素的
 * 抖动。
 *
 * 组员靠 React Flow 的子流（`parentId` + 相对坐标）跟着一起动。
 * **不裁剪子级**（§1.3 的差异）：组员的 `extent` 不设 `"parent"`，
 * 拖出边界仍然可见，拖出去就自动离组（`use-flow-nodes.commitDrag`）。
 *
 * 连线：分组没有起笔的把手（`NODE_META.group.hasBridgeHandles` 是 false，
 * 它自己有标题与色带，左右挂两个圆点既没地方放也没意义），但它可以是一条
 * 连线的**落点**（§2.3 第四行），所以仍然渲染 `dropOnly` 的落点把手。
 */

/** 徽章相对 Frame 左上角的内缩，避开色带与标题。 */
const BADGE_INSET = 8;

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
  const bound = frameBindingOf(node) !== null;
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
        {/* GitHub 关联徽标：贴在标题行右侧，没有关联时不画任何像素。 */}
        <div
          data-slot="github-frame-references"
          className="canvas-group-badges absolute -top-[22px] right-1 flex gap-1"
        >
          <GithubReferenceBadge nodeId={node.id} />
        </div>
        {/* 绑定徽章（G03）在 Frame 内左上角：它有「重新创建 / 解绑」按钮，
            所以要自己收回指针事件，别被当成 Frame 的拖动。 */}
        {bound ? (
          <div
            className="nodrag nopan absolute"
            style={{
              left: BADGE_INSET,
              top: BADGE_INSET,
              maxWidth: `calc(100% - ${BADGE_INSET * 2}px)`,
            }}
          >
            <WorktreeBindingBadge node={node} />
          </div>
        ) : null}
      </div>
      <ConnectionHandles dropOnly />
    </>
  );
}

export default React.memo(GroupNode);
