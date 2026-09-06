import * as React from "react";
import { useReactFlow, type Node, type NodeProps } from "@xyflow/react";

import { arrowHead, lineBounds } from "../geometry";
import { colorHex, dashArray, strokeWidth } from "../palette";
import { useCanvasScheme } from "../scheme";
import { beginGesture, endGesture, updateItem } from "../store";
import type { LineItem, LinePoint } from "../model";
import { ItemFrame } from "./ItemFrame";

/**
 * 直线与箭头（React Flow 计划 F25，归属 whiteboard）。
 *
 * 不绑定任何对象（§1.3 的差异）：它就是两个点，拖端点改的是点，不是
 * 「重新吸附到哪个形状」。所以这里不用 `NodeResizer`——拖框会把一条斜线
 * 变成另一条斜线，用户想要的是「把这一头挪到那儿」。
 *
 * 端点把手自绘：14px 的圆点，只在选中时出现，`nodrag` 让它不被当成
 * 「拖整条线」。
 */

export type LineFlowNode = Node<LineItem, "wb.line">;

const HANDLE_RADIUS = 5;

export function LineNode({
  id,
  data,
  selected = false,
}: NodeProps<LineFlowNode>) {
  const scheme = useCanvasScheme();
  const flow = useReactFlow();
  const color = colorHex(data.style.color, scheme);
  const width = strokeWidth(data.style.size);
  const head = width * 3 + 4;
  const points = data.points;

  /**
   * 拖一个端点。
   *
   * 改点集之后包围盒也变了，所以 `x/y/w/h` 要一起重算——否则这条线会跑
   * 出自己的节点框，React Flow 的命中区和它画出来的样子就对不上了。
   */
  const dragEndpoint = React.useCallback(
    (index: number) => (event: React.PointerEvent<SVGCircleElement>) => {
      event.stopPropagation();
      event.preventDefault();
      beginGesture("whiteboard.line");
      // 起手时把所有点换算成页面坐标并**固定**下来：每一帧都从这一份算，
      // 而不是从上一帧的结果算——对象的原点每帧都在动，链式相减会漂。
      const anchored: LinePoint[] = points.map(([x, y]) => [
        x + data.x,
        y + data.y,
      ]);

      const move = (moveEvent: PointerEvent) => {
        const page = flow.screenToFlowPosition({
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        });
        const next: LinePoint[] = anchored.map((point, at) =>
          at === index ? [page.x, page.y] : point,
        );
        const box = lineBounds(next);
        updateItem(id, {
          x: box.x,
          y: box.y,
          w: Math.max(box.w, 1),
          h: Math.max(box.h, 1),
          points: next.map(([x, y]) => [x - box.x, y - box.y] as LinePoint),
        } as never);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        endGesture();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [data.x, data.y, flow, id, points],
  );

  const path = points.map(([x, y]) => `${x} ${y}`).join(" L ");

  return (
    <ItemFrame item={data} selected={selected} resizable={false}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${Math.max(data.w, 1)} ${Math.max(data.h, 1)}`}
        preserveAspectRatio="none"
        style={{ display: "block", overflow: "visible" }}
      >
        <path
          d={`M ${path}`}
          fill="none"
          stroke={color}
          strokeWidth={width}
          strokeDasharray={dashArray(data.style.dash, width)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {data.arrowEnd && points.length >= 2 ? (
          <path
            d={arrowHead(
              points[points.length - 1]!,
              points[points.length - 2]!,
              head,
            )}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {data.arrowStart && points.length >= 2 ? (
          <path
            d={arrowHead(points[0]!, points[1]!, head)}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {selected
          ? points.map((point, index) => (
              <circle
                key={index}
                className="nodrag"
                cx={point[0]}
                cy={point[1]}
                r={HANDLE_RADIUS}
                fill="var(--panel)"
                stroke="var(--brand)"
                strokeWidth={1.5}
                style={{ cursor: "grab", pointerEvents: "all" }}
                onPointerDown={dragEndpoint(index)}
              />
            ))
          : null}
      </svg>
    </ItemFrame>
  );
}

export default React.memo(LineNode);
