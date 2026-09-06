import type { BoardDocument } from "@armadra/shared";

import { MAX_LINKS } from "../../content-links";
import { referenceCountForNode } from "../../create-content-reference";
import { isValidLink } from "../../connection";
import { isItemId } from "../../whiteboard/model";
import type { WhiteboardDoc } from "../../whiteboard/model";

/**
 * 拖一条线出来时的判定（React Flow 计划 §2.3 的判定表，归属 B1）。
 *
 * 旧引擎里这套逻辑埋在 `shapes/LinkArrow.ts` 的 side effect 里：箭头工具
 * 每一帧都可能换 binding，所以判定必须推迟到交互结束，还得自己维护
 * 「从把手起笔」的一次性标记。React Flow 把这两件事都拿走了——把手拖拽是
 * 它的原生手势，`isValidConnection` 在拖动中被反复问、`onConnect` 只在松手
 * 且合法时调一次。剩下的就只有一张纯函数的判定表，全部放在这里。
 *
 * 表里四行（§2.3）：
 *
 * | source → target      | 结果                                              |
 * | -------------------- | ------------------------------------------------- |
 * | 节点 → 节点          | `connection.isValidLink`（自连、重复拒绝）→ 一条边 |
 * | 节点 → `wb.*` 或反向 | 引用；节点已满 64 个对端时拒绝                     |
 * | `wb.*` → `wb.*`      | 拒绝（白板对象之间用直线 / 箭头工具画）            |
 * | 任一端是 group       | 只允许作为 `link` 的一端                          |
 *
 * 判定与提示分开：`isValidConnection` 在拖动中每帧都要跑，不能弹 toast；
 * `connectionRejection` 把「为什么不行」翻译成一个 i18n 键，由
 * `use-flow-nodes.onConnectEnd` 在松手那一刻提示一次。
 */

export interface ConnectionEnds {
  source?: string | null;
  target?: string | null;
}

export interface ConnectionContext {
  document: BoardDocument | null;
  whiteboard: WhiteboardDoc;
}

/** 拒绝的理由。`none` 表示「拖到空白处」——那是取消，不是错误。 */
export type ConnectionReject =
  | "none"
  | "self"
  | "duplicate"
  | "itemToItem"
  | "referenceLimit"
  | "unknown";

export type ConnectionVerdict =
  | { kind: "link"; source: string; target: string }
  /** 内容引用（F29）。B5 才真的建它；B1 只负责把这一行认出来。 */
  | { kind: "reference"; itemId: string; nodeId: string }
  | { kind: "reject"; reason: ConnectionReject };

/** 拒绝理由 → 提示文案的键；`none` 与 `unknown` 不提示。 */
const REJECT_MESSAGES: Partial<Record<ConnectionReject, string>> = {
  self: "edge.selfLink",
  duplicate: "edge.duplicate",
  referenceLimit: "shape.referenceLimit",
};

export function connectionRejection(verdict: ConnectionVerdict): string | null {
  if (verdict.kind !== "reject") return null;
  return REJECT_MESSAGES[verdict.reason] ?? null;
}

/**
 * 判定表本体。
 *
 * 两端都必须在画布上：拖到空白处松手时 React Flow 也会问一遍，那一次
 * `target` 是 null，回 `reject: "none"`（取消，不提示）。
 */
export function classifyConnection(
  connection: ConnectionEnds,
  { document, whiteboard }: ConnectionContext,
): ConnectionVerdict {
  const source = connection.source ?? null;
  const target = connection.target ?? null;
  if (!source || !target) return { kind: "reject", reason: "none" };

  const sourceIsItem = isItemId(source);
  const targetIsItem = isItemId(target);

  // 白板对象之间不连线：那是直线 / 箭头工具的活（§2.3 第三行）。
  if (sourceIsItem && targetIsItem) {
    return { kind: "reject", reason: "itemToItem" };
  }

  if (sourceIsItem || targetIsItem) {
    const itemId = sourceIsItem ? source : target;
    const nodeId = sourceIsItem ? target : source;
    return referenceVerdict(itemId, nodeId, document, whiteboard);
  }

  // 两端都是节点：自连与重复由 `connection.ts` 的同一条规则拒绝，
  // 分组作为其中一端是允许的（现状，§2.3 第四行）。
  const nodes = document?.nodes ?? [];
  const edges = document?.edges ?? [];
  if (source === target) return { kind: "reject", reason: "self" };
  const known = new Set(nodes.map((node) => node.id));
  if (!known.has(source) || !known.has(target)) {
    return { kind: "reject", reason: "unknown" };
  }
  if (!isValidLink({ source, target }, nodes, edges)) {
    return { kind: "reject", reason: "duplicate" };
  }
  return { kind: "link", source, target };
}

function referenceVerdict(
  itemId: string,
  nodeId: string,
  document: BoardDocument | null,
  whiteboard: WhiteboardDoc,
): ConnectionVerdict {
  const nodes = document?.nodes ?? [];
  if (!nodes.some((node) => node.id === nodeId)) {
    return { kind: "reject", reason: "unknown" };
  }
  const items = whiteboard.items;
  if (!items.some((item) => `wb:${item.id}` === itemId)) {
    return { kind: "reject", reason: "unknown" };
  }
  // 已经引用过同一个对象时不算超限：重复由 B5 的「去重定位」处理。
  const existing = whiteboard.references.some(
    (reference) =>
      reference.nodeId === nodeId && `wb:${reference.itemId}` === itemId,
  );
  if (
    !existing &&
    referenceCountForNode(document, whiteboard, nodeId) >= MAX_LINKS
  ) {
    return { kind: "reject", reason: "referenceLimit" };
  }
  return { kind: "reference", itemId, nodeId };
}

/**
 * `<ReactFlow isValidConnection>` 用的布尔判定。
 *
 * B1 只放行 `link`；B5 把 `"reference"` 也放行了——引用边的建立、PNG 导出
 * 与发布状态机都已落地（`create-content-reference.ts`、`content-links.ts`），
 * `use-flow-nodes.onConnect` 按 `verdict.kind` 分流。
 */
export function isValidCanvasConnection(
  connection: ConnectionEnds,
  context: ConnectionContext,
): boolean {
  const kind = classifyConnection(connection, context).kind;
  return kind === "link" || kind === "reference";
}
