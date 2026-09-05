import type { CanvasNode } from "@armadra/shared";

/**
 * 节点元数据的纯数据层：标签与批注（计划书 §17 头部补齐）。
 *
 * `node.labels` / `node.note` 由 Runtime 侧的 schema 补齐，shared 的类型
 * 可能比 Runtime 落后一步，所以读都经这两个访问器，别处不写断言。
 */

export function nodeLabels(node: CanvasNode | undefined): string[] {
  return node?.labels ?? [];
}

export function nodeNote(node: CanvasNode | undefined): string {
  return node?.note ?? "";
}

/** 每个节点最多 8 个标签。 */
export const MAX_LABELS = 8;

/** 标签去重、去空白、限长。 */
export function normaliseLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw.trim().slice(0, 24);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}
