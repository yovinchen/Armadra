/**
 * 主从关系在画布上的读法。
 *
 * 一条 `role: "supervises"` 的边说的是「`source` 盯着 `target`」。这个模块把
 * 那些边读成每个节点的两句话：**我盯着几个**，以及**谁在盯着我**。
 *
 * 纯函数，没有 store、没有 React：节点头的徽标、连线上的那句提示、以及以后
 * 任何要回答「谁是谁的主」的地方都走这一个答案，不各自把边再读一遍。
 *
 * 主被删掉之后从节点**不静默降级**：边还在（它指向一个已经不在的 id），所以
 * 这里答的是「主已离开」而不是「没有主」。那两件事不一样——一个是从来没有
 * 上级，一个是上级刚刚消失，而后者是人要知道的。
 */
import type { CanvasEdge, CanvasNode } from "@armadra/shared";

export interface Supervision {
  /** 这个节点盯着的那些节点 id。 */
  readonly subordinates: readonly string[];
  /** 盯着这个节点的那个节点 id；没有上级时缺席。 */
  readonly supervisorId?: string;
  /** 上级的名字（handle）或标题；上级已经不在画布上时缺席。 */
  readonly supervisorName?: string;
}

const EMPTY: Supervision = { subordinates: [] };

/** 节点显示用的称呼：名字优先，其次标题，最后 id。 */
export function displayNameOf(
  node: Pick<CanvasNode, "id" | "title" | "data"> | undefined,
  fallback: string,
): string {
  if (node === undefined) return fallback;
  const handle = (node.data as { handle?: unknown } | undefined)?.handle;
  if (typeof handle === "string" && handle !== "") return handle;
  return node.title || fallback;
}

export function supervisionFor(
  nodeId: string,
  edges: readonly CanvasEdge[],
  nodes: readonly CanvasNode[],
): Supervision {
  let supervisorId: string | undefined;
  const subordinates: string[] = [];
  for (const edge of edges) {
    if (edge.role !== "supervises") continue;
    if (edge.source === nodeId) subordinates.push(edge.target);
    // 第一条赢：一个节点有两个上级是 core 不该写出来的形状，页面也不替它挑。
    if (edge.target === nodeId && supervisorId === undefined) {
      supervisorId = edge.source;
    }
  }
  if (supervisorId === undefined) {
    return subordinates.length === 0 ? EMPTY : { subordinates };
  }
  const supervisor = nodes.find((node) => node.id === supervisorId);
  return {
    subordinates,
    supervisorId,
    ...(supervisor === undefined
      ? {}
      : { supervisorName: displayNameOf(supervisor, supervisorId) }),
  };
}

export type SupervisionBadgeModel =
  | { readonly kind: "supervisor"; readonly count: number }
  | { readonly kind: "subordinate"; readonly name: string }
  | { readonly kind: "orphan" };

/**
 * 节点头上那一枚徽标。`undefined` 表示不画。
 *
 * 一个节点可以同时是主和从（一条链的中间一环）。那时画的是**它的上级**：
 * 「谁在盯着我」是这个节点自己的处境，而「我盯着几个」在下级的头上已经说过
 * 一遍了。
 */
export function supervisionBadge(
  supervision: Supervision,
): SupervisionBadgeModel | undefined {
  if (supervision.supervisorId !== undefined) {
    return supervision.supervisorName === undefined
      ? { kind: "orphan" }
      : { kind: "subordinate", name: supervision.supervisorName };
  }
  if (supervision.subordinates.length > 0) {
    return { kind: "supervisor", count: supervision.subordinates.length };
  }
  return undefined;
}
