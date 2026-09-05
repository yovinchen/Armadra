import type {
  Editor,
  TLRecord,
  TLShape,
  TLShapeId,
  TLStoreSnapshot,
} from "tldraw";

import { isDocumentShapeId } from "../shapes/armadra-shape";
import { LINK_SHAPE_TYPE } from "../shapes/link-shape";

/**
 * 白板快照的过滤与合并（tldraw 计划 §6.1，归属 canvas）。纯函数。
 *
 * 快照里只留白板原生记录：`armadra`、作为节点的 `frame`、`link` 及其绑定
 * 由 `nodes` / `edges` 承载。节点 frame 内的原生子孙仍保存在白板快照；
 * 加载时先灌快照，再把文档投影成 shape 合并进去。
 *
 * 判据是「绑到谁」而不是「id 长什么样」：用户手画的箭头也可能两端都落在
 * 节点上（Phase 2 起就是一条边），按 id 猜会把它漏进白板快照，于是同一条
 * 线被两条通道各存一份，下次打开就出现幽灵箭头。
 *
 * **只有一端绑到节点的箭头要留下**（Phase 4 · §6.3 的内容链接）：它不是一条
 * `edges` 行，白板快照是它唯一的存身之处。代价是快照里会有一条指向节点 shape
 * 的 binding，而节点 shape 是加载之后才投影上去的——`splitPendingBindings`
 * 把这类 binding 拆出来，`use-store-sync.load()` 在投影完节点之后再补进 store。
 */

interface ShapeRecord {
  id: string;
  typeName: "shape";
  type: string;
}

interface BindingRecord {
  id: string;
  typeName: "binding";
  type: string;
  fromId: string;
  toId: string;
}

function isShape(record: unknown): record is ShapeRecord {
  return (record as ShapeRecord | null)?.typeName === "shape";
}

function isBinding(record: unknown): record is BindingRecord {
  return (record as BindingRecord | null)?.typeName === "binding";
}

/** 由 `nodes` 表承载的 shape：`armadra` 与作为分组的 `frame`。 */
function isNodeShape(record: ShapeRecord): boolean {
  if (record.type === "armadra") return true;
  return record.type === "frame" && isDocumentShapeId(record.id);
}

export function stripDocumentRecords(
  snapshot: TLStoreSnapshot,
): TLStoreSnapshot {
  const store = snapshot.store as Record<string, TLRecord>;
  const nodeShapes = new Set<string>();
  // 上下文链接（`link` shape）与它的两条 binding 由 `edges` 表承载。
  const linkShapes = new Set<string>();
  for (const record of Object.values(store)) {
    if (!isShape(record)) continue;
    if (isNodeShape(record)) nodeShapes.add(record.id);
    else if (record.type === LINK_SHAPE_TYPE) linkShapes.add(record.id);
  }

  // 两端都绑在节点上的箭头 = 一条 edges 行，连同它的 binding 一起剔掉。
  // 只绑一端的箭头留着：那是内容链接，`edges` 表里没有它。
  const endsOf = new Map<string, Set<string>>();
  for (const record of Object.values(store)) {
    if (!isBinding(record) || record.type !== "arrow") continue;
    if (!nodeShapes.has(record.toId)) continue;
    const ends = endsOf.get(record.fromId) ?? new Set<string>();
    ends.add(record.toId);
    endsOf.set(record.fromId, ends);
  }
  const edgeArrows = new Set(
    [...endsOf.entries()]
      .filter(([, ends]) => ends.size >= 2)
      .map(([arrowId]) => arrowId),
  );

  // Native descendants remain whiteboard data even when their frame is a
  // document node. Defer those records until the frame has been projected on
  // load; deleting them here permanently loses drawings/text on every save.
  const dropped = new Set<string>([
    ...nodeShapes,
    ...linkShapes,
    ...edgeArrows,
  ]);

  const kept: Record<string, TLRecord> = {};
  for (const [id, record] of Object.entries(store)) {
    if (isShape(record) && dropped.has(record.id)) continue;
    if (isBinding(record)) {
      if (record.type === LINK_SHAPE_TYPE) continue;
      if (dropped.has(record.fromId)) continue;
      // 指向节点的那一端留着（内容链接）；指向被剔掉的白板 shape 就是悬空的。
      if (dropped.has(record.toId) && !nodeShapes.has(record.toId)) continue;
    }
    kept[id] = record;
  }

  return { store: kept, schema: snapshot.schema } as TLStoreSnapshot;
}

/**
 * 把「指向快照里不存在的 shape」的 binding 拆出来。
 *
 * 内容链接的箭头绑在节点 shape 上，而节点 shape 不在白板快照里（`nodes` 表才是
 * 它的真相）。`loadSnapshot` 会重置整个 store，这时节点还没投影上去，binding
 * 指向的对象不存在 —— 所以先灌 `base`，投影完节点再把 `pending` 补进去。
 *
 * `fromId` 也不在快照里的 binding 直接丢掉：那条箭头本身已经没了。
 */
export function splitPendingBindings(snapshot: TLStoreSnapshot): {
  base: TLStoreSnapshot;
  pending: TLRecord[];
} {
  const store = snapshot.store as Record<string, TLRecord>;
  const present = new Set<string>();
  for (const record of Object.values(store)) {
    if (isShape(record)) present.add(record.id);
  }

  const deferred = new Set<string>();
  for (;;) {
    let changed = false;
    for (const record of Object.values(store)) {
      if (!isShape(record) || deferred.has(record.id)) continue;
      const parent = (record as unknown as { parentId?: string }).parentId;
      if (
        parent?.startsWith("shape:") &&
        (!present.has(parent) || deferred.has(parent))
      ) {
        deferred.add(record.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const base: Record<string, TLRecord> = {};
  const pending: TLRecord[] = [];
  for (const [id, record] of Object.entries(store)) {
    if (isShape(record) && deferred.has(id)) {
      pending.push(record);
      continue;
    }
    if (isBinding(record)) {
      if (!present.has(record.fromId)) continue;
      if (
        !present.has(record.toId) ||
        deferred.has(record.fromId) ||
        deferred.has(record.toId)
      ) {
        pending.push(record);
        continue;
      }
    }
    base[id] = record;
  }

  return {
    base: { store: base, schema: snapshot.schema } as TLStoreSnapshot,
    pending,
  };
}

export function serializeWhiteboard(snapshot: TLStoreSnapshot): string {
  return JSON.stringify(stripDocumentRecords(snapshot));
}

/** 解析失败一律返回 null：一份坏快照不该让整个看板打不开。 */
export function parseWhiteboard(json: string): TLStoreSnapshot | null {
  if (!json.trim()) return null;
  try {
    const parsed = JSON.parse(json) as Partial<TLStoreSnapshot>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.store || !parsed.schema) return null;
    return parsed as TLStoreSnapshot;
  } catch {
    return null;
  }
}

/** Restore records deferred because their document-owned parents/endpoints
 * were absent from the native snapshot. Caller runs this as remote changes. */
export function restorePendingRecords(
  editor: Pick<Editor, "getShape" | "store">,
  pending: readonly TLRecord[],
): void {
  let shapes = pending.filter((record) => record.typeName === "shape");
  while (shapes.length > 0) {
    const ready = shapes.filter((record) => {
      const parent = (record as TLShape).parentId;
      return !parent.startsWith("shape:") || Boolean(editor.getShape(parent));
    });
    if (ready.length === 0) break;
    editor.store.put(ready);
    const restored = new Set(ready.map((record) => record.id));
    shapes = shapes.filter((record) => !restored.has(record.id));
  }
  const bindings = pending.filter((record) => {
    if (record.typeName !== "binding") return false;
    const binding = record as unknown as { fromId: TLShapeId; toId: TLShapeId };
    return Boolean(
      editor.getShape(binding.fromId) && editor.getShape(binding.toId),
    );
  });
  if (bindings.length > 0) editor.store.put(bindings);
}
