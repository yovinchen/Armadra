import * as React from "react";
import type { CanvasEdge, CanvasNode } from "@armadra/shared";

import type { Item, Reference } from "../../canvas/whiteboard/model";
import { useCanvasStore } from "../canvas-store";
import type { CanvasStore } from "./types";
import { markPatch } from "./pending";

/**
 * 撤销 / 重做（React Flow 计划 §2.7，归属 store）。
 *
 * 旧引擎里撤销栈归编辑器；换成 React Flow 之后没有别人来做这件事了，
 * 所以自写一套**按实体的反向补丁**：一条记录只装这次改动碰过的节点、边、
 * 白板对象与引用，`id → 实体 | null`（null = 那一刻不存在）。
 *
 * 两条语义直接照抄旧引擎的行为：
 *
 *  1. **远端灌入不进栈。** `setDocument`、WS 事件重载、保存 409 变基都走
 *     `history: "ignore"`，所以 ⌘Z 撤不掉别的窗口或 Agent 建的节点。
 *  2. **撤销只回放 `before` 里出现的实体。** 这期间远端新增的东西不受影响；
 *     被远端删掉的实体撤销时复活为本地新建（与 `replayLocalEdits` 一致）。
 *
 * 视口、选区、面板、最大化的 `premaxRect` 一律不进历史。
 */

/** 栈深。超过就丢最旧的一条。 */
export const HISTORY_LIMIT = 200;

export type EntityPatch = {
  nodes: Map<string, CanvasNode | null>;
  edges: Map<string, CanvasEdge | null>;
  items: Map<string, Item | null>;
  references: Map<string, Reference | null>;
};

export interface HistoryEntry {
  label: string;
  before: EntityPatch;
  after: EntityPatch;
}

/** 参与历史的四张表；`commit` 前后各取一份。 */
export interface HistorySnapshot {
  nodes: readonly CanvasNode[];
  edges: readonly CanvasEdge[];
  items: readonly Item[];
  references: readonly Reference[];
}

export type HistoryMode = "record" | "ignore";

export interface CommitOptions {
  history?: HistoryMode;
  label?: string;
}

/* -------------------------------- 栈 ------------------------------------- */

let past: HistoryEntry[] = [];
let future: HistoryEntry[] = [];
const listeners = new Set<() => void>();

/** 正在回放：这期间 store 的写入不再记录，否则撤销自己会进栈。 */
let replaying = false;

interface Coalescing {
  label: string;
  before: EntityPatch;
  after: EntityPatch;
}
let coalescing: Coalescing | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function emptyPatch(): EntityPatch {
  return {
    nodes: new Map(),
    edges: new Map(),
    items: new Map(),
    references: new Map(),
  };
}

function isEmptyPatch(patch: EntityPatch): boolean {
  return (
    patch.nodes.size === 0 &&
    patch.edges.size === 0 &&
    patch.items.size === 0 &&
    patch.references.size === 0
  );
}

/* -------------------------------- 差分 ------------------------------------ */

function indexOf<T extends { id: string }>(list: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const entity of list) map.set(entity.id, entity);
  return map;
}

/**
 * 一张表的前后差异。按**对象身份**比较：store 的每个动作都用展开语法造新
 * 对象，没动过的那些仍是同一个引用，所以成本与变动条数成正比而不是与画布
 * 大小成正比。
 */
function diffTable<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  intoBefore: Map<string, T | null>,
  intoAfter: Map<string, T | null>,
): void {
  // 没动过的表连索引都不用建。`commit()` 每次都比四张表，而一次编辑通常只
  // 碰一张——白板的两张在绝大多数节点操作里是原样传进来的同一个数组，给它们
  // 各建一份 Map 是纯开销，且随画布大小线性增长。
  if (before === after) return;
  const from = indexOf(before);
  const to = indexOf(after);
  for (const [id, entity] of from) {
    const next = to.get(id);
    if (next === entity) continue;
    intoBefore.set(id, entity);
    intoAfter.set(id, next ?? null);
  }
  for (const [id, entity] of to) {
    if (from.has(id)) continue;
    intoBefore.set(id, null);
    intoAfter.set(id, entity);
  }
}

export function diffSnapshots(
  before: HistorySnapshot,
  after: HistorySnapshot,
): { before: EntityPatch; after: EntityPatch } {
  const from = emptyPatch();
  const to = emptyPatch();
  diffTable(before.nodes, after.nodes, from.nodes, to.nodes);
  diffTable(before.edges, after.edges, from.edges, to.edges);
  diffTable(before.items, after.items, from.items, to.items);
  diffTable(
    before.references,
    after.references,
    from.references,
    to.references,
  );
  return { before: from, after: to };
}

function mergePatch(base: EntityPatch, extra: EntityPatch): void {
  for (const [id, value] of extra.nodes) base.nodes.set(id, value);
  for (const [id, value] of extra.edges) base.edges.set(id, value);
  for (const [id, value] of extra.items) base.items.set(id, value);
  for (const [id, value] of extra.references) base.references.set(id, value);
}

/** 只补第一次见到的 id：合并会话里最早的那一份才是「改之前」。 */
function mergeBefore(base: EntityPatch, extra: EntityPatch): void {
  for (const [id, value] of extra.nodes)
    if (!base.nodes.has(id)) base.nodes.set(id, value);
  for (const [id, value] of extra.edges)
    if (!base.edges.has(id)) base.edges.set(id, value);
  for (const [id, value] of extra.items)
    if (!base.items.has(id)) base.items.set(id, value);
  for (const [id, value] of extra.references)
    if (!base.references.has(id)) base.references.set(id, value);
}

/* -------------------------------- 记录 ------------------------------------ */

export function isReplaying(): boolean {
  return replaying;
}

/**
 * 记一条。合并会话开着时并进当前会话，`endCoalesce()` 才真正入栈。
 * 任何一次新记录都清空重做栈（与所有编辑器一致）。
 */
export function record(entry: HistoryEntry): void {
  if (replaying) return;
  if (isEmptyPatch(entry.before) && isEmptyPatch(entry.after)) return;
  if (coalescing) {
    mergeBefore(coalescing.before, entry.before);
    mergePatch(coalescing.after, entry.after);
    return;
  }
  past.push(entry);
  if (past.length > HISTORY_LIMIT) past.shift();
  future = [];
  notify();
}

/**
 * 合并会话（§2.7）：文字编辑、便签正文这类「一个字一次 commit」的场景，
 * 进入编辑时开一个，提交时关掉，整段只形成一条历史。
 */
export function beginCoalesce(label: string): void {
  if (coalescing) endCoalesce();
  coalescing = { label, before: emptyPatch(), after: emptyPatch() };
}

export function endCoalesce(): void {
  const session = coalescing;
  coalescing = null;
  if (!session) return;
  if (isEmptyPatch(session.before) && isEmptyPatch(session.after)) return;
  past.push({
    label: session.label,
    before: session.before,
    after: session.after,
  });
  if (past.length > HISTORY_LIMIT) past.shift();
  future = [];
  notify();
}

/* -------------------------------- 回放 ------------------------------------ */

/**
 * 把一张补丁应用回列表：`null` 表示删掉，新出现的追加到末尾。
 * 顺序对节点没有语义（z 序在 `zIndex` 上），追加即可。
 */
function applyTable<T extends { id: string }>(
  list: readonly T[],
  patch: ReadonlyMap<string, T | null>,
): T[] {
  if (patch.size === 0) return list as T[];
  const next: T[] = [];
  const seen = new Set<string>();
  for (const entity of list) {
    if (!patch.has(entity.id)) {
      next.push(entity);
      continue;
    }
    seen.add(entity.id);
    const replacement = patch.get(entity.id);
    if (replacement) next.push(replacement);
  }
  for (const [id, entity] of patch) {
    if (seen.has(id) || !entity) continue;
    next.push(entity);
  }
  return next;
}

function applyPatch(patch: EntityPatch): void {
  const state = useCanvasStore.getState();
  if (!state.document) return;
  // 撤销 / 重做也是这个窗口的编辑：远端合并时这几条以本地为准（`pending.ts`）。
  markPatch(patch);
  const nodes = applyTable(state.document.nodes, patch.nodes);
  const edges = applyTable(state.document.edges, patch.edges);
  const items = applyTable(state.whiteboard.items, patch.items);
  const references = applyTable(state.whiteboard.references, patch.references);
  const known = new Set(nodes.map((node) => node.id));
  useCanvasStore.setState({
    document: { ...state.document, nodes, edges },
    whiteboard: { ...state.whiteboard, items, references },
    // 撤销掉的节点不该继续留在选区里，否则 Delete 会打在不存在的 id 上。
    selectedNodeIds: state.selectedNodeIds.filter((id) => known.has(id)),
    saveState: "dirty",
  });
}

function run(patch: EntityPatch): void {
  replaying = true;
  try {
    applyPatch(patch);
  } finally {
    replaying = false;
  }
}

export function undo(): void {
  endCoalesce();
  const entry = past.pop();
  if (!entry) return;
  run(entry.before);
  future.push(entry);
  notify();
}

export function redo(): void {
  const entry = future.pop();
  if (!entry) return;
  run(entry.after);
  past.push(entry);
  notify();
}

export function canUndo(): boolean {
  return past.length > 0 || coalescing !== null;
}

export function canRedo(): boolean {
  return future.length > 0;
}

/** 换画布 / 换工作空间时清栈：上一块板的补丁在这一块上没有意义。 */
export function resetHistory(): void {
  coalescing = null;
  if (past.length === 0 && future.length === 0) return;
  past = [];
  future = [];
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCanUndo(): boolean {
  return React.useSyncExternalStore(subscribe, canUndo, () => false);
}

export function useCanRedo(): boolean {
  return React.useSyncExternalStore(subscribe, canRedo, () => false);
}

/* ------------------------------ commit 接口 ------------------------------- */

/** `internal.commit` 用它取前后快照；白板与文档在同一次 `set` 里变。 */
export function snapshotOf(state: CanvasStore): HistorySnapshot {
  return {
    nodes: state.document?.nodes ?? [],
    edges: state.document?.edges ?? [],
    items: state.whiteboard.items,
    references: state.whiteboard.references,
  };
}
