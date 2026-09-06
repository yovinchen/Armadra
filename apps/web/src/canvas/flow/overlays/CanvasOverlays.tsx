import * as React from "react";

import { SubagentCard } from "@/nodes/SubagentCard";
import { useCanvasStore } from "@/store/canvas-store";
import {
  ropeLabel,
  useDerivedEdges,
  type DerivedEdge,
} from "../../derived-edges";
import { bezierPath, edgeGeometry, nodeBox, type Box } from "../../geometry";
import {
  CARD_HEIGHT,
  useSubagentPlacements,
  type SubagentPlacement,
} from "../../SubagentLayer";

/**
 * 派生层（旧画布契约 §4.4）：rope 等待关系 + 子代理卡片。
 *
 * 挂在 `<ViewportPortal>` 里，也就是 `.react-flow__viewport` 内部——那一层
 * 已经被相机变换过了，所以这里的坐标**就是画布坐标**，不必自己乘缩放。
 *
 * 这一层不入库、不可选中、不进撤销，所以整块 `pointer-events: none`，
 * 只有子代理卡片自己把指针事件收回去（它有展开按钮）。
 *
 * 绑定徽章与 GitHub 徽标不再在这里：Frame 现在是一个真的 DOM 节点，
 * 两个徽章直接由 `flow/nodes/GroupNode.tsx` 渲染（F08），页面坐标换算
 * 整段消失。
 */

/** 虚线流动的周期长度；`stroke-dasharray` 是 `6 4`，一轮正好 10。 */
export const ROPE_DASH = "6 4";

/** `⏳` 的字号与底衬半径（画布单位；跟着相机缩放，和节点上的文字同一档）。 */
const LABEL_FONT_SIZE = 12;
const LABEL_RADIUS = 9;

/** SVG 用画布坐标，而画布坐标可以是负的，所以往四周各铺这么远。 */
const CANVAS_SPAN = 100_000;

export function CanvasOverlays() {
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const edges = useDerivedEdges();
  const placements = useSubagentPlacements();

  const boxes = React.useMemo(() => {
    const map = new Map<string, Box>();
    const list = nodes ?? [];
    for (const node of list) map.set(node.id, nodeBox(list, node));
    for (const placement of placements) {
      map.set(placement.id, {
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: CARD_HEIGHT,
      });
    }
    return map;
  }, [nodes, placements]);

  return (
    <>
      {edges.length > 0 ? (
        <svg
          aria-hidden
          className="pointer-events-none absolute overflow-visible"
          style={{
            left: -CANVAS_SPAN,
            top: -CANVAS_SPAN,
            width: CANVAS_SPAN * 2,
            height: CANVAS_SPAN * 2,
          }}
        >
          <g transform={`translate(${CANVAS_SPAN} ${CANVAS_SPAN})`}>
            {edges.map((edge) => (
              <RopeLine key={edge.id} edge={edge} boxes={boxes} />
            ))}
          </g>
        </svg>
      ) : null}
      {placements.map((placement) => (
        <SubagentSlot key={placement.id} placement={placement} />
      ))}
    </>
  );
}

function SubagentSlot({ placement }: { placement: SubagentPlacement }) {
  return (
    <div
      className="absolute"
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.width,
        pointerEvents: "all",
      }}
    >
      <SubagentCard card={placement.card} />
    </div>
  );
}

interface RopeLineProps {
  edge: DerivedEdge;
  boxes: ReadonlyMap<string, Box>;
}

/**
 * 派生边的画法（§3.3）：1.5px，颜色取上游 Agent 的品牌色。
 * 等待中虚线流动，已启动 / 已结束变实线。
 */
function RopeLine({ edge, boxes }: RopeLineProps) {
  const source = boxes.get(edge.source);
  const target = boxes.get(edge.target);
  if (!source || !target) return null;
  const { d, labelX, labelY } = bezierPath(
    // 子代理卡片就挂在父节点正下方，走上下两边比左右好看得多。
    edgeGeometry(
      source,
      target,
      edge.variant === "subagent" ? "free" : "horizontal",
    ),
  );
  const label = ropeLabel(edge);
  return (
    <g className="pointer-events-none">
      <path
        d={d}
        fill="none"
        stroke={edge.color}
        strokeWidth={1.5}
        strokeLinecap="round"
        {...(edge.waiting ? { strokeDasharray: ROPE_DASH } : {})}
        className={edge.waiting ? "anim-rope-flow" : undefined}
      />
      {label ? (
        <>
          {/* 沙漏压在绳子上，底下垫一个卡片色的圆点，免得线穿过图形中间 */}
          <circle
            cx={labelX}
            cy={labelY}
            r={LABEL_RADIUS}
            fill="var(--card)"
            stroke={edge.color}
            strokeWidth={1}
          />
          <text
            x={labelX}
            y={labelY}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={LABEL_FONT_SIZE}
          >
            {label}
          </text>
        </>
      ) : null}
    </g>
  );
}

export default CanvasOverlays;
