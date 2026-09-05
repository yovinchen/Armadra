import * as React from "react";
import type { CanvasNode } from "@armadra/shared";

import { agentColorVar } from "@/agent/launch";
import { useLaunchedAfter } from "@/agent/pending-launch";
import {
  subagentNodeId,
  useAllSubagentCards,
  type SubagentCardModel,
} from "@/agent/subagent-store";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 派生边（§3.3 / §4.4）。每帧从状态算出来，**不入库、不进撤销、不可选中**。
 *
 * 两种：
 *
 *  - **rope**：`open-agent --after A,B` 造出来的等待关系（A → 新节点）。
 *    等待中虚线流动 + `⏳`，启动之后变实线。启动之后 `pendingLaunch` 就被
 *    清掉了，所以「谁开出了谁」由 `pending-launch` 的会话内记忆提供——
 *    刷新页面后绳子消失是可以接受的：它描述的是这次运行里的因果，不是数据。
 *  - **subagent**：父 Agent → 它的临时子代理卡片。
 *
 * 它们不是 tldraw 的 shape：`overlays/CanvasOverlays.tsx` 在
 * `components.OnTheCanvas` 里画一层 SVG，位置直接用页面坐标。
 */

export type RopeVariant = "rope" | "subagent";

export interface DerivedEdge {
  id: string;
  /** 节点 id（rope）或父节点 id（subagent）。 */
  source: string;
  /** 节点 id，或 `subagentNodeId(card.id)`。 */
  target: string;
  variant: RopeVariant;
  /** 还没启动 / 子代理还在跑：虚线 + 流动 + `⏳`。 */
  waiting: boolean;
  /** 描边颜色，一律是 CSS 变量（两套主题都要跟着走，§4.3）。 */
  color: string;
}

export interface DeriveEdgesInput {
  nodes: readonly CanvasNode[];
  /** 本次运行里已经由 `--after` 启动过的节点 → 它当时的依赖。 */
  launchedAfter: Readonly<Record<string, readonly string[]>>;
  /** 父节点 id → 子代理卡片。 */
  cards: Readonly<Record<string, readonly SubagentCardModel[]>>;
}

/** 依赖节点的品牌色；依赖不是 Agent 终端时退回强调色。 */
export function ropeColor(dependency: CanvasNode | undefined): string {
  const agentId =
    dependency?.data.kind === "terminal"
      ? dependency.data.agent?.id
      : undefined;
  return agentId ? agentColorVar(agentId) : "var(--brand)";
}

function ropeEdge(
  source: string,
  target: string,
  waiting: boolean,
  color: string,
  variant: RopeVariant,
): DerivedEdge {
  return {
    id: `${variant}:${source}->${target}`,
    source,
    target,
    variant,
    waiting,
    color,
  };
}

export function deriveEdges(input: DeriveEdgesInput): DerivedEdge[] {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const edges: DerivedEdge[] = [];
  const seen = new Set<string>();

  const push = (edge: DerivedEdge) => {
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    edges.push(edge);
  };

  for (const node of input.nodes) {
    const pending =
      node.data.kind === "terminal"
        ? node.data.agent?.pendingLaunch
        : undefined;
    // 等待中的依赖来自节点数据；已启动的来自会话内记忆。两者不会同时存在。
    const dependencies = pending?.after ?? input.launchedAfter[node.id] ?? [];
    for (const dependencyId of dependencies) {
      // 依赖被删掉了就不画：一条指向空气的绳子比没有绳子更难懂。
      const dependency = byId.get(dependencyId);
      if (!dependency || dependencyId === node.id) continue;
      push(
        ropeEdge(
          dependencyId,
          node.id,
          Boolean(pending),
          ropeColor(dependency),
          "rope",
        ),
      );
    }

    for (const card of input.cards[node.id] ?? []) {
      push(
        ropeEdge(
          node.id,
          subagentNodeId(card.id),
          card.state === "working",
          "var(--agent-working)",
          "subagent",
        ),
      );
    }
  }

  return edges;
}

/**
 * 等待标签（§4.4 / v3 `RopeEdge` 的规则原样搬过来）。
 *
 * **只有 rope 会挂 `⏳`**：它表示「这个节点的启动行还压着，等上游跑完」，
 * 是画布上唯一看不出来的等待。子代理卡片自己有 RUNNING 胶囊和计时，
 * 绳子上再挂一个沙漏是重复信息，所以 `subagent` 一律不挂。
 *
 * 启动之后 `pendingLaunch` 被清掉、`waiting` 变 false，标签随之消失、
 * 虚线变实线——三件事同一个开关。
 */
export const ROPE_WAITING_LABEL = "\u23f3";

export function ropeLabel(
  edge: Pick<DerivedEdge, "variant" | "waiting">,
): string | null {
  return edge.variant === "rope" && edge.waiting ? ROPE_WAITING_LABEL : null;
}

/** 覆盖层每次渲染取一次。 */
export function useDerivedEdges(): DerivedEdge[] {
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const launchedAfter = useLaunchedAfter();
  const cards = useAllSubagentCards();

  return React.useMemo(
    () => deriveEdges({ nodes: nodes ?? [], launchedAfter, cards }),
    [cards, launchedAfter, nodes],
  );
}
