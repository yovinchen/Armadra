import type { CanvasNode } from "@armadra/shared";
import { toast } from "sonner";

import { t, usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import {
  attemptKey,
  canAutoTitle,
  claimAttempt,
  releaseAttempt,
  rememberAutoTitle,
} from "./auto-title";
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
    if (!title) return;
    useCanvasStore.getState().updateNode(nodeId, { title });
    // 手动触发的命名也记进账本：接下来的 OSC 标题不该把它冲掉。
    rememberAutoTitle(nodeId, title);
  } catch {
    toast.error(t("meta.suggestTitleFailed"));
  }
}

/**
 * 自动命名一个仍是占位标题的节点（Agent 自动化设计 §8）。
 *
 * 调用点在终端节点上：Hook 报出本会话的第一个回合之后触发一次。这里把设计
 * 里的每一条硬规则都收在一处，调用方不需要自己判断：
 *
 *   * 只在 `autoTitle` 打开时应用——设置项是开关，不是建议；
 *   * 只在标题仍是占位（或上一次自动命名写的）时应用，人工改过名就锁定；
 *   * 每个 (节点, 会话, 代次) 只调用一次，失败才归还名额；
 *   * **拿到结果后再判一次**：请求飞在路上的时候用户完全可能改了名，设计说
 *     「生成过程中用户改名，结果只作为建议，不覆盖」，所以那种情况直接丢弃。
 *
 * 静默失败：这是后台行为，不是用户点的按钮，弹 toast 只会打扰人。
 */
export async function autoNameNode(
  nodeId: string,
  binding: { sessionId: string | null; generation: number | null },
): Promise<void> {
  if (!usePreferencesStore.getState().autoTitle) return;
  const before = useCanvasStore
    .getState()
    .document?.nodes.find((node) => node.id === nodeId);
  if (!before || !canSuggestTitle(before) || !canAutoTitle(before)) return;
  const key = attemptKey(nodeId, binding.sessionId, binding.generation);
  if (!claimAttempt(key)) return;
  let title: string;
  try {
    title = (await suggestTitle(nodeId)).trim();
  } catch {
    releaseAttempt(key);
    return;
  }
  if (!title) return;
  const after = useCanvasStore
    .getState()
    .document?.nodes.find((node) => node.id === nodeId);
  // 节点没了，或者请求期间被改了名 / 被删了：结果作废。
  if (!after || !canAutoTitle(after) || after.title.trim() === title) return;
  rememberAutoTitle(nodeId, title);
  useCanvasStore.getState().updateNode(nodeId, { title });
}
