import type { CanvasNode } from "@armadra/shared";
import { toast } from "sonner";

import { t } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { suggestTitle } from "./conversations";

/**
 * 节点标注的事件总线（计划书 §17「头部补齐」）。
 *
 * 刻意做成一个**没有任何 UI 依赖**的叶子模块：打开标注面板的入口散在头部
 * 图标钮、终端的「更多」下拉和右键菜单三处，而右键菜单的注册表
 * （`canvas/menus/node-menu`）与节点注册表之间已经是一个循环，
 * 把界面组件拉进那条链会让模块求值顺序变得脆弱。
 */

export type NodeAnnotationKind = "note" | "labels";

export const NODE_ANNOTATION_EVENT = "armadra:node-annotation";

export interface NodeAnnotationDetail {
  nodeId: string;
  kind: NodeAnnotationKind;
}

/** 打开某个节点的标注面板；三个入口都走它。 */
export function openNodeAnnotation(
  nodeId: string,
  kind: NodeAnnotationKind,
): void {
  window.dispatchEvent(
    new CustomEvent<NodeAnnotationDetail>(NODE_ANNOTATION_EVENT, {
      detail: { nodeId, kind },
    }),
  );
}

/** 订阅某个节点的打开请求。 */
export function onNodeAnnotation(
  nodeId: string,
  handler: (kind: NodeAnnotationKind) => void,
): () => void {
  function listener(event: Event) {
    const detail = (event as CustomEvent<NodeAnnotationDetail>).detail;
    if (detail?.nodeId !== nodeId) return;
    handler(detail.kind);
  }
  window.addEventListener(NODE_ANNOTATION_EVENT, listener);
  return () => window.removeEventListener(NODE_ANNOTATION_EVENT, listener);
}

/** 带 agent 的终端才有转录可取，也才有 ✦ AI 命名。 */
export function canSuggestTitle(node: CanvasNode): boolean {
  return node.data.kind === "terminal" && Boolean(node.data.agent);
}

/** ✦ AI 命名：Runtime 取转录首条用户消息生成标题，失败只弹一条 toast。 */
export async function suggestNodeTitle(nodeId: string): Promise<void> {
  try {
    const title = (await suggestTitle(nodeId)).trim();
    if (title) useCanvasStore.getState().updateNode(nodeId, { title });
  } catch {
    toast.error(t("meta.suggestTitleFailed"));
  }
}
