import type { BoardDocument, CanvasNode } from "@armadra/shared";

import { centerOf, containsPoint, nodeBox, type Box } from "./geometry";
import { type Item, type WhiteboardDoc } from "./whiteboard/model";

/**
 * Frame 作为内容引用的来源（React Flow 计划 §2.5 / F29 的收尾项）。
 *
 * 引用一个 Frame ≠ 引用一张图，而是**引用它圈住的那一片东西**：里面的白板
 * 对象与节点合成一条链接，`content.text` 是一份清单，`pngPath` 是那些白板
 * 对象一起栅格化出来的图。上限（64）与去重（同一对 Frame/节点只有一行）
 * 与白板对象那条路完全一样，判定仍在 `create-content-reference.ts`。
 *
 * **成员按几何算，不按 `parentId`。** 节点确实有 `parentId`（拖进 Frame 时
 * `use-flow-nodes.commitDrag` 会写），白板对象却从来没有人给它写过——画笔、
 * 形状、文字、剪贴板落成的对象一律 `parentId: null`（`whiteboard/tools/draft.ts`）。
 * 所以这里两类成员用同一条判据：**中心落在 Frame 的矩形里**，与
 * `geometry.hitTestGroup` 给节点换父时用的是同一条。`parentId` 已经指向这个
 * Frame 的节点无条件算成员，哪怕它此刻被拖到框外。
 */

/** 清单里最多列几项；超出的折成一行「还有 N 项」。 */
export const FRAME_SUMMARY_LIMIT = 40;

export interface FrameSource {
  frame: CanvasNode;
  /** 框住的白板对象，按 `z` 升序（栅格化时的绘制顺序）。 */
  items: Item[];
  /** 框住的节点，不含 Frame 自己，也不含别的 Frame。 */
  nodes: CanvasNode[];
}

function boxOfItem(item: Item): Box {
  return { x: item.x, y: item.y, width: item.w, height: item.h };
}

/** 这个 id 是画布上的一个 Frame 吗？ */
export function frameById(
  document: BoardDocument | null,
  id: string,
): CanvasNode | null {
  return (
    document?.nodes.find((node) => node.id === id && node.type === "group") ??
    null
  );
}

/**
 * 一个 Frame 的可引用成员。
 *
 * 找不到 Frame 时返回 null——调用方据此把这条引用当成「来源没了」跳过，
 * 和指向已删白板对象的引用是同一种处理。
 */
export function frameSource(
  document: BoardDocument | null,
  whiteboard: WhiteboardDoc,
  frameId: string,
): FrameSource | null {
  const frame = frameById(document, frameId);
  if (!frame) return null;
  const nodes = document?.nodes ?? [];
  const box = nodeBox(nodes, frame);

  const members = nodes.filter((node) => {
    if (node.id === frame.id || node.type === "group") return false;
    if (node.parentId === frame.id) return true;
    // 别的 Frame 的组员不算：它的坐标是相对那个 Frame 的，位置比不了。
    if (node.parentId) return false;
    return containsPoint(box, centerOf(nodeBox(nodes, node)));
  });

  const items = whiteboard.items
    .filter((item) => {
      if (item.parentId) return item.parentId === frame.id;
      return containsPoint(box, centerOf(boxOfItem(item)));
    })
    .sort((a, b) => a.z - b.z);

  return { frame, items, nodes: members };
}

/**
 * 成员清单的一行。
 *
 * `label` 是 i18n 取词函数；类型名与白板对象那条路共用
 * `content-links.CONTENT_TYPE_KEYS`，所以这里只收算好的名字。
 */
export interface FrameSummaryLine {
  /** 类型名（「文字」/「图形」/「终端」…）。 */
  kind: string;
  /** 这一项自己的文字：文字对象的正文、形状的标签、节点的标题。 */
  text: string;
}

export function frameSummaryLines(
  source: FrameSource,
  typeName: (kind: string) => string,
): FrameSummaryLine[] {
  const lines: FrameSummaryLine[] = [];
  for (const item of source.items) {
    const text =
      item.kind === "text"
        ? item.text.trim()
        : item.kind === "shape"
          ? (item.label ?? "").trim()
          : "";
    lines.push({ kind: typeName(item.kind), text });
  }
  for (const node of source.nodes) {
    lines.push({ kind: typeName(node.type), text: node.title.trim() });
  }
  return lines;
}

export interface FrameSummaryLabels {
  /** 一项都没有时的整段文字。 */
  empty: string;
  /** 清单的抬头。 */
  header: string;
  /** 一行：`kind` 是类型名，`text` 可能是空串。文案与分隔符都归 i18n。 */
  line: (line: FrameSummaryLine) => string;
  /** 超出上限时最后那一行。 */
  more: (rest: number) => string;
}

/**
 * 清单正文。空 Frame 也给一句话——「这个 Frame 是空的」是一个真答案，
 * 交出去比什么都不说更有用。
 */
export function frameSummaryText(
  source: FrameSource,
  typeName: (kind: string) => string,
  labels: FrameSummaryLabels,
): string {
  const lines = frameSummaryLines(source, typeName);
  if (lines.length === 0) return labels.empty;
  const shown = lines.slice(0, FRAME_SUMMARY_LIMIT);
  const body = shown.map(labels.line);
  if (lines.length > shown.length) {
    body.push(labels.more(lines.length - shown.length));
  }
  return [labels.header, ...body].join("\n");
}

/**
 * 「这个 Frame 还是不是上次导出的那个样子」。
 *
 * 与白板对象的 `itemSignature` 同一个用途，但**不去掉 `x` / `y`**：成员的
 * 相对位置就是这张聚合图的内容，挪一个成员画出来就不一样了。Frame 自己的
 * 坐标不进签名（整体搬家不改内容），标题进——它是清单的抬头。
 */
export function frameSignature(source: FrameSource): string {
  return JSON.stringify({
    title: source.frame.title,
    width: source.frame.size?.width ?? 0,
    height: source.frame.size?.height ?? 0,
    items: source.items,
    nodes: source.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
    })),
  });
}
