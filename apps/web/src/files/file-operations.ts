/**
 * 文件操作与画布的对账（E01/M4）。
 *
 * Runtime 负责路径校验与真正的移动/删除；这里只做两件事：
 *
 *  1. 重命名 / 移动之后，画布上打开着旧路径的编辑器与文件管理器节点跟着走
 *     ——包括被移动目录下面的文件，它们的路径同样要改写。
 *  2. 删除之后不动节点数据：编辑器已经在监听这个文件，`file.changed` 的
 *     `removed` 分支会把它转成 create-only 草稿，草稿不能因为一次删除消失。
 *
 * 纯函数放在最前面，组件与测试都用它，不必起画布。
 */
import type { CanvasNode } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";

/**
 * `current` 在 `from` 被改名成 `to` 之后的新路径；不受影响时返回 `null`。
 *
 * 目录改名要连带下面的每个文件，所以既比较相等，也比较 `from/` 前缀。
 * 前缀必须带斜杠：`src` 改名不该动到 `srcery/a.ts`。
 */
export function rewritePath(
  current: string,
  from: string,
  to: string,
): string | null {
  if (current === from) return to;
  return current.startsWith(`${from}/`)
    ? `${to}${current.slice(from.length)}`
    : null;
}

/** 路径末段，用作节点标题。 */
export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** 一个节点在这次重命名里要改成什么；不受影响时返回 `null`。 */
export function renamedNode(
  node: CanvasNode,
  from: string,
  to: string,
): { path: string; title: string } | null {
  if (node.data.kind !== "editor" && node.data.kind !== "files") return null;
  const path = rewritePath(node.data.path, from, to);
  if (path === null) return null;
  return { path, title: basename(path) };
}

/**
 * 让画布跟上一次重命名 / 移动，返回改了几个节点。
 *
 * 标题跟着路径末段走，但只在标题原本就是旧末段时才改：用户自己改过的
 * 节点标题不该被一次文件移动覆盖掉。
 */
export function followRename(from: string, to: string): number {
  const store = useCanvasStore.getState();
  const nodes = store.document?.nodes ?? [];
  let changed = 0;
  for (const node of nodes) {
    const next = renamedNode(node, from, to);
    if (!next) continue;
    changed += 1;
    const previous =
      node.data.kind === "editor" || node.data.kind === "files"
        ? node.data.path
        : "";
    store.updateNodeData(node.id, { path: next.path });
    if (node.title === basename(previous))
      store.updateNode(node.id, { title: next.title });
  }
  return changed;
}
