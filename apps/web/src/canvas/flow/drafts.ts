import * as React from "react";
import type { Position, Size } from "@armadra/shared";

/**
 * 手势进行中的临时几何（React Flow 计划 §2.1 规则 2，归属 canvas）。
 *
 * 拖动与 resize 每帧都会产生新的坐标。把它们写进文档意味着一次拖拽产生
 * 几十条历史、几十次 `saveState: "dirty"`，还会让每个终端节点重渲一遍。
 * 所以进行中的几何只住在这里：投影时覆盖到 React Flow 节点上，
 * `onNodeDragStop` / `onResizeEnd` 才调 `moveNodes` / `resizeNode`，
 * 一次手势一条历史。
 *
 * 模块级 Map + `useSyncExternalStore`，不进 zustand：它是 UI 的瞬时状态，
 * 不该跟着画布文档存盘，也不该让 45 个 store 消费方跟着重渲。
 */

export interface Draft {
  position?: Position;
  size?: Size;
}

export type DraftMap = ReadonlyMap<string, Draft>;

const EMPTY: DraftMap = new Map();

let drafts: DraftMap = EMPTY;
const listeners = new Set<() => void>();

function publish(next: DraftMap): void {
  drafts = next;
  for (const listener of listeners) listener();
}

export function getDrafts(): DraftMap {
  return drafts;
}

/** 合并写：只给位置时保留上一次的尺寸，反之亦然。 */
export function setDraft(id: string, draft: Draft): void {
  const previous = drafts.get(id);
  const merged: Draft = { ...previous, ...draft };
  if (
    previous &&
    previous.position?.x === merged.position?.x &&
    previous.position?.y === merged.position?.y &&
    previous.size?.width === merged.size?.width &&
    previous.size?.height === merged.size?.height
  ) {
    return;
  }
  const next = new Map(drafts);
  next.set(id, merged);
  publish(next);
}

export function clearDrafts(ids: readonly string[]): void {
  if (drafts.size === 0) return;
  const next = new Map(drafts);
  let changed = false;
  for (const id of ids) changed = next.delete(id) || changed;
  if (!changed) return;
  publish(next.size === 0 ? EMPTY : next);
}

/** 仅测试与画布卸载用：把整张表清空。 */
export function clearAllDrafts(): void {
  if (drafts.size === 0) return;
  publish(EMPTY);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDrafts(): DraftMap {
  return React.useSyncExternalStore(subscribe, getDrafts, () => EMPTY);
}
