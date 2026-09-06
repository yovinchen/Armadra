import * as React from "react";
import { MiniMap, Panel, useReactFlow } from "@xyflow/react";
import type { MiniMapNodeProps } from "@xyflow/react";
import { ChevronDown, Map } from "lucide-react";

import {
  agentHeaderState,
  useAgentStatusStore,
  type AgentGlow,
} from "@/agent/status-store";
import { useMinimapPreferences } from "@/app/minimap-preferences";
import { useT } from "@/app/preferences-store";
import { IconButton } from "@/ui/icon-button";
import { isItemId } from "../whiteboard/model";
import type { CanvasFlowNode } from "../sync/project";

/**
 * 状态缩略图（React Flow 计划 F20 / §1.2，归属 B1）。
 *
 * 旧引擎的缩略图是自绘的一整块 canvas（`overlays/StatusMinimap.tsx`，约
 * 250 行）：它把整页对象合成两条 `Path2D` 再各刷一次颜色，没有「按对象
 * 上色」的入口，所以「按 Agent 状态描边」只能自己画。React Flow 的
 * `<MiniMap>` 反过来——`nodeColor` 与 `nodeStrokeColor` 都是**按节点求值的
 * 函数**，正好就是我们要的那个入口（粗细是个常数，所以另配一个 20 行的
 * `nodeComponent`）。于是整块自绘换成三个纯函数，几何、命中测试、指针换算、
 * DPR、主题重读全部由库负责。
 *
 * 保留的行为：三种状态描边、点一下定位到那个节点、可收起（收起状态在
 * `app/minimap-preferences.ts`，用量球跟着同一个 CSS 变量走）、位置右下并
 * 为「React Flow」归属链接让出 24px（`styles/canvas.css`）。
 *
 * 放弃的行为：视口框的自定义描边（`maskColor` 只有一个颜色）与「拖着走」时
 * 的 200ms 动画（`pannable` 是即时跟随，比动画跟手）。
 */

/* -------------------------------- 颜色 ------------------------------------ */

/** 状态 → 描边色用的 CSS 变量（`styles/tokens.css`）。 */
export const MINIMAP_COLORS = {
  /** working：陶土色。 */
  working: "var(--agent-working)",
  /** needs-you。 */
  attention: "var(--danger)",
  /** 未读。 */
  unread: "var(--brand)",
  /** 无状态的节点、白板对象与分组：一块低对比的底。 */
  plain: "var(--muted-foreground)",
} as const;

export interface MinimapItem {
  /** 白板对象（`wb:` 前缀）与分组一律低对比，不参与状态描边。 */
  plain?: boolean;
  glow?: AgentGlow;
  selected?: boolean;
}

/**
 * 状态 → 描边色（旧画布契约 §3.2）。
 *
 * 三种状态的优先级由 `agentHeaderState()` 定好了（一个节点同一时刻只会有
 * 一种光晕），这里只做映射；没有状态的节点用中性描边。
 */
export function minimapStroke(item: MinimapItem): string {
  if (item.plain) return MINIMAP_COLORS.plain;
  switch (item.glow) {
    case "working":
      return MINIMAP_COLORS.working;
    case "attention":
      return MINIMAP_COLORS.attention;
    case "unread":
      return MINIMAP_COLORS.unread;
    default:
      return MINIMAP_COLORS.plain;
  }
}

/** 三种状态描边色的集合，`minimapStrokeWidth` 靠它认出「有状态」。 */
const STATUS_STROKES: ReadonlySet<string> = new Set([
  MINIMAP_COLORS.working,
  MINIMAP_COLORS.attention,
  MINIMAP_COLORS.unread,
]);

/**
 * 有状态的节点画粗一点：缩略图上 1px 的色差不够，粗细才看得见。
 *
 * 入参是**描边色**而不是节点：`<MiniMap nodeStrokeWidth>` 只收一个常数
 * （不像 `nodeColor` / `nodeStrokeColor` 可以是函数），所以逐节点的粗细要靠
 * 自定义的 `nodeComponent`，而它拿到的只有算好的颜色。
 */
export function minimapStrokeWidth(stroke: string): number {
  return STATUS_STROKES.has(stroke) ? 4 : 2;
}

/** 矩形填充：选中的节点实一点，白板对象与无状态节点淡一点。 */
export function minimapFill(item: MinimapItem): string {
  const alpha = item.plain ? 0.35 : item.selected ? 0.55 : 0.28;
  return `color-mix(in srgb, var(--muted-foreground) ${Math.round(
    alpha * 100,
  )}%, transparent)`;
}

/** RF 的节点 → 上色要看的那三个位（分组和白板对象都算 `plain`）。 */
export function minimapItemOf(
  node: Pick<CanvasFlowNode, "id" | "type" | "selected">,
  glowOf: (nodeId: string) => AgentGlow | undefined,
): MinimapItem {
  const plain = node.type !== "armadra" || isItemId(node.id);
  const glow = plain ? undefined : glowOf(node.id);
  return {
    plain,
    selected: node.selected === true,
    ...(glow ? { glow } : {}),
  };
}

/* -------------------------------- 组件 ------------------------------------ */

/**
 * 缩略图里的一个矩形。
 *
 * 用自定义的 `nodeComponent` 而不是 RF 自带的那个，只为了一件事：逐节点的
 * 描边粗细。其余（圆角、命中、`shapeRendering`）与自带的一模一样。
 */
export function MinimapNode({
  id,
  x,
  y,
  width,
  height,
  borderRadius,
  className,
  color,
  strokeColor,
  shapeRendering,
  selected,
  onClick,
}: MiniMapNodeProps) {
  return (
    <rect
      className={`react-flow__minimap-node${selected ? " selected" : ""} ${className}`}
      x={x}
      y={y}
      rx={borderRadius}
      ry={borderRadius}
      width={width}
      height={height}
      style={{
        fill: color,
        stroke: strokeColor,
        strokeWidth: minimapStrokeWidth(strokeColor ?? MINIMAP_COLORS.plain),
      }}
      shapeRendering={shapeRendering}
      onClick={onClick ? (event) => onClick(event, id) : undefined}
    />
  );
}

/** 点一下缩略图里的节点：把它居中，缩放不变（旧引擎同款）。 */
const CENTER_DURATION = 200;

export function Minimap() {
  const t = useT();
  const flow = useReactFlow();
  const { collapsed, setCollapsed } = useMinimapPreferences();
  // 状态每变一次都要重刷描边色，所以订阅整张表而不是某一个节点。
  const statuses = useAgentStatusStore((state) => state.statuses);

  const glowOf = React.useCallback(
    (nodeId: string) => agentHeaderState(statuses[nodeId]).glow,
    [statuses],
  );

  const nodeStrokeColor = React.useCallback(
    (node: CanvasFlowNode) => minimapStroke(minimapItemOf(node, glowOf)),
    [glowOf],
  );
  const nodeColor = React.useCallback(
    (node: CanvasFlowNode) => minimapFill(minimapItemOf(node, glowOf)),
    [glowOf],
  );
  const onNodeClick = React.useCallback(
    (_event: React.MouseEvent, node: CanvasFlowNode) => {
      const width = node.measured?.width ?? node.width ?? 0;
      const height = node.measured?.height ?? node.height ?? 0;
      void flow.setCenter(
        node.position.x + width / 2,
        node.position.y + height / 2,
        { zoom: flow.getZoom(), duration: CENTER_DURATION },
      );
    },
    [flow],
  );

  const toggleLabel = t(
    collapsed ? "canvas.expandMinimap" : "canvas.collapseMinimap",
  );

  return (
    <>
      {collapsed ? null : (
        <MiniMap<CanvasFlowNode>
          pannable
          zoomable
          ariaLabel={t("canvas.minimap")}
          data-testid="minimap.canvas"
          nodeColor={nodeColor}
          nodeStrokeColor={nodeStrokeColor}
          nodeComponent={MinimapNode}
          nodeBorderRadius={3}
          onNodeClick={onNodeClick}
        />
      )}
      {/*
       * 收起按钮不进 `<MiniMap>`（它只渲染一张 SVG，没有插槽），所以贴着
       * 缩略图右上角单独摆一个。
       *
       * 用 `<Panel>` 包一层不是为了它的默认角落，而是为了那 15px 的
       * `margin`——`<MiniMap>` 自己就是一个 Panel，`styles/canvas.css` 里
       * 的 `right: 14px` 实际落在 29px 上。同一个盒模型才对得齐。
       *
       * 收起时 `--minimap-w/h` 变成 36px（`App` 在 `.workspace-surface` 上写
       * `data-minimap-collapsed`），按钮自然落到缩略图原来的位置，用量球也
       * 跟着挪。
       */}
      <Panel
        position="bottom-right"
        style={
          collapsed
            ? { right: 14, bottom: "var(--navigation-bottom)" }
            : {
                right: 18,
                bottom:
                  "calc(var(--navigation-bottom) + var(--minimap-h) - 32px)",
              }
        }
      >
        <IconButton
          size="cluster"
          data-slot="minimap-toggle"
          className="minimap-toggle border border-border bg-[var(--panel)]/90 backdrop-blur-[12px]"
          label={toggleLabel}
          title={toggleLabel}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <Map /> : <ChevronDown />}
        </IconButton>
      </Panel>
    </>
  );
}

export default Minimap;
