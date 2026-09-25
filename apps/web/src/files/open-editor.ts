/**
 * 打开一个文件的编辑器节点（E01/M4）。
 *
 * 快速打开与项目搜索共用这一条路径：同一路径默认复用已有编辑器（编辑器
 * 设计 §1），只把它选中并居中；没有才新建一个。带行号时顺手请求滚动，
 * 新建的节点挂载后自己去取（见 `nodes/editor-reveal`）。
 */
import { requestCenterOnNode } from "@/canvas/flow/flow-context";
import { revealInEditor } from "@/nodes/editor-reveal";
import { nodeDropPosition } from "@/canvas/placement";
import { useCanvasStore } from "@/store/canvas-store";

import { basename } from "./file-operations";

export interface OpenFileOptions {
  /** 1 起的行号；给了就滚过去。 */
  line?: number;
  /** 1 起的列号；只在给了行号时有意义。 */
  column?: number;
  readonly?: boolean;
}

/** 返回被打开（或复用）的节点 id；没有工作区时返回 `null`。 */
export function openFileInEditor(
  path: string,
  { line, column, readonly }: OpenFileOptions = {},
): string | null {
  const store = useCanvasStore.getState();
  if (!store.workspace) return null;
  const existing = (store.document?.nodes ?? []).find(
    (node) => node.data.kind === "editor" && node.data.path === path,
  );
  const id =
    existing?.id ??
    store.addNode("editor", {
      title: basename(path),
      position: nodeDropPosition("editor"),
      data: { kind: "editor", path, ...(readonly ? { readonly } : {}) },
    });
  if (existing) {
    store.selectNodes([existing.id]);
    requestCenterOnNode(existing.id);
  }
  if (line !== undefined) revealInEditor(path, line, column);
  return id;
}
