import * as React from "react";
import type { CanvasNode } from "@armadra/shared";

import { useDependencyStore } from "@/agent/dependency-store";
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
 *    等待中虚线流动 + `⏳`。等待由 core 的依赖表派生（Agent 自动化设计
 *    §6，`agent/dependency-store.ts`）；还没迁走的旧节点数据里的
 *    `pendingLaunch` 照读。启动之后绳子就不画了——页面自己敲出去的那些
 *    （命令面板那条）由 `pending-launch` 的会话内记忆提供实线。
 *  - **subagent**：父 Agent → 它的临时子代理卡片。
 *
 * 它们不是画布上的对象：`overlays/CanvasOverlays.tsx` 在
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
  /** core 依赖表里还在等的：下游节点 id → 它还等着的上游。 */
  waitingOn?: Readonly<Record<string, readonly string[]>>;
}

/** Dependency edges use the same neutral appearance for every provider. */
export function ropeColor(_dependency: CanvasNode | undefined): string {
  return "var(--muted-foreground)";
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
    // 等待中的依赖来自 core（旧数据还没迁走时来自节点数据）；已启动的来自会
    // 话内记忆。两者不会同时存在。
    const waitingFor = pending?.after ?? input.waitingOn?.[node.id];
    const dependencies = waitingFor ?? input.launchedAfter[node.id] ?? [];
    for (const dependencyId of dependencies) {
      // 依赖被删掉了就不画：一条指向空气的绳子比没有绳子更难懂。
      const dependency = byId.get(dependencyId);
      if (!dependency || dependencyId === node.id) continue;
      push(
        ropeEdge(
          dependencyId,
          node.id,
          waitingFor !== undefined,
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
          card.state === "working"
            ? "var(--status-working)"
            : "var(--muted-foreground)",
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
  const launches = useDependencyStore((state) => state.launches);
  const waitingOn = React.useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const launch of Object.values(launches)) {
      if (launch.state !== "waiting") continue;
      const upstreams = launch.dependencies
        .filter((edge) => edge.state !== "cancelled")
        .map((edge) => edge.upstreamNodeId);
      if (upstreams.length > 0) out[launch.nodeId] = upstreams;
    }
    return out;
  }, [launches]);

  return React.useMemo(
    () => deriveEdges({ nodes: nodes ?? [], launchedAfter, cards, waitingOn }),
    [cards, launchedAfter, nodes, waitingOn],
  );
}
