import type { Position } from "@armadra/shared";

import { fontSize } from "../palette";
import { canvasScheme } from "../scheme";
import { getNextStyle } from "../../interaction/tool-store";
import { addItems, createItemId, select } from "../store";
import { centreLayout, layoutGraph, type LayoutOptions } from "./layout";
import { parseMermaid, type MermaidGraph } from "./parse";
import { graphToItems } from "./to-items";

/**
 * 一次导入的编排（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §3）。
 *
 * 解析 → 布局 → 生成对象三步**全在内存里做完**，只有最后一次 `addItems`
 * 才碰文档。所以「不产生半成品」是结构保证的，不是靠每一步自己小心
 * （设计 §6）。
 *
 * 图片回退不在这里：它要 `dnd/external-content` 与资产接口，由对话框那边
 * 接（`ImportMermaidDialog`），免得这个文件把整条资产链拖进来。
 */

/** 一个字符相对字号的宽度。西文平均约 0.58 em，够估框了。 */
const CHAR_WIDTH_RATIO = 0.58;
/** 行高相对字号。 */
const LINE_HEIGHT_RATIO = 1.4;

export function layoutOptions(): LayoutOptions {
  const size = getNextStyle().size;
  const font = fontSize(size);
  return {
    charWidth: font * CHAR_WIDTH_RATIO,
    lineHeight: font * LINE_HEIGHT_RATIO,
  };
}

/**
 * flowchart → 白板对象，一次落地。
 *
 * 返回建出来的对象 id；调用方不用管选中（这里顺手选上，和粘贴一致）。
 */
export function placeGraph(graph: MermaidGraph, at: Position): string[] {
  const laid = centreLayout(layoutGraph(graph, layoutOptions()), at);
  const style = getNextStyle();
  const items = graphToItems(graph, laid, {
    style: { color: style.color, size: style.size },
    scheme: canvasScheme(),
    newId: createItemId,
  });
  if (items.length === 0) return [];
  // 一次调用 = 一次 `setWhiteboard` = 一条历史：撤销一次整张图消失。
  const ids = addItems(items, { label: "whiteboard.mermaid" });
  select(ids);
  return ids;
}

export type ImportOutcome =
  | { kind: "graph"; ids: string[] }
  /** 非 flowchart：调用方走图片回退。 */
  | { kind: "image"; diagramType: string };

/**
 * 文本 → 结果。语法错时抛 `MermaidParseError`（调用方显示错误行）。
 */
export async function importMermaidText(
  text: string,
  at: Position,
): Promise<ImportOutcome> {
  const parsed = await parseMermaid(text);
  if (parsed.kind === "image") {
    return { kind: "image", diagramType: parsed.diagramType };
  }
  return { kind: "graph", ids: placeGraph(parsed.graph, at) };
}
