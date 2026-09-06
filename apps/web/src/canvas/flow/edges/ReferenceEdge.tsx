import * as React from "react";
import { BaseEdge, EdgeLabelRenderer, useInternalNode } from "@xyflow/react";
import type { EdgeProps, InternalNode, Node } from "@xyflow/react";
import { X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { removeContentReference } from "../../create-content-reference";
import { edgeGeometry, type Box } from "../../geometry";
import type { ReferenceFlowEdge } from "../../sync/project";
import { arrowHead, INTERACTION_WIDTH, STROKE_WIDTH } from "./link-visual";

/**
 * 内容引用边（React Flow 计划 §2.3 / F29，归属 B5）。
 *
 * 与 `LinkEdge` 的三点不同，都是为了让它一眼就不像一条上下文连线：
 *
 *  - **直线**，不是贝塞尔。引用是「这块内容归那个 Agent 读」的记账，不是
 *    两个节点之间的关系，画得越轻越好。
 *  - **单箭头指向节点**（`source` 永远是 `wb:*`，`target` 永远是节点，
 *    `sync/project.projectReference` 定的），方向就是资料流向。
 *  - **静音配色** `--muted-foreground`，且没有中点标签。
 *
 * 端点用两端矩形相对边上的锚点（`geometry.edgeGeometry` 的 `free` 模式，
 * 上下左右四条边都可以出线），不是把手坐标：白板对象上根本没有左右把手，
 * 而一条从下方墨迹指上来的引用应该从墨迹的上边出发。
 *
 * 选中时在中点浮一个删除按钮。引用边的 id 不在 `document.edges` 里，
 * `tools.splitSelectionForDelete`（B0）因此认不出它，Delete 键当前删不掉
 * 一条引用——按钮是这一版里唯一不依赖右键菜单的出口（见交接记录）。
 */

/** 一端的矩形；React Flow 还没量到尺寸时退回投影给的宽高。 */
function boxOf(node: InternalNode<Node> | undefined): Box | null {
  if (!node) return null;
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  if (width <= 0 || height <= 0) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
}

export function ReferenceEdge({
  id,
  source,
  target,
  selected = false,
  style,
}: EdgeProps<ReferenceFlowEdge>) {
  const t = useT();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  const sourceBox = boxOf(sourceNode);
  const targetBox = boxOf(targetNode);
  if (!sourceBox || !targetBox) return null;

  const geometry = edgeGeometry(sourceBox, targetBox, "free");
  const from = { x: geometry.sourceX, y: geometry.sourceY };
  const to = { x: geometry.targetX, y: geometry.targetY };
  const width = selected ? STROKE_WIDTH : STROKE_WIDTH - 0.5;
  const color = selected ? "var(--brand)" : "var(--muted-foreground)";

  return (
    <g style={{ color }} data-slot="reference-edge">
      <BaseEdge
        path={`M ${from.x},${from.y} L ${to.x},${to.y}`}
        interactionWidth={INTERACTION_WIDTH}
        style={{
          ...style,
          stroke: "currentColor",
          strokeWidth: width,
          strokeLinecap: "round",
          // 虚线：与实线的上下文连线一眼分得开，深浅色下都成立。
          strokeDasharray: "6 5",
          opacity: selected ? 1 : 0.75,
        }}
      />
      <path
        d={arrowHead(to, from)}
        fill="none"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={selected ? 1 : 0.75}
      />
      {selected ? (
        <EdgeLabelRenderer>
          <Button
            variant="secondary"
            size="icon-xs"
            aria-label={t("shape.removeReference")}
            title={t("shape.removeReference")}
            data-slot="reference-remove"
            className="nodrag nopan pointer-events-auto absolute shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${
                (from.x + to.x) / 2
              }px, ${(from.y + to.y) / 2}px)`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              removeContentReference(id);
            }}
          >
            <X />
          </Button>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}

export default React.memo(ReferenceEdge);
