import * as React from "react";
import type { BoardDocument, CanvasNode } from "@armadra/shared";
import {
  react,
  type Editor,
  type TLFrameShape,
  type TLRecord,
  type TLShape,
  type TLShapeId,
} from "tldraw";

import { useCanvasStore } from "@/store/canvas-store";
import type { ArmadraShape } from "../shapes/armadra-shape";
import {
  isDocumentShapeId,
  toNodeId,
  toShapeId,
} from "../shapes/armadra-shape";
import type { LinkShape } from "../shapes/link-shape";
import { isLinkShape } from "../shapes/link-shape";
import { deriveEdges, deriveNodes } from "./derive";
import { edgeToLink, nodeToShape } from "./project";
import { isPushed, markPushed } from "./pushed";
import {
  parseWhiteboard,
  restorePendingRecords,
  serializeWhiteboard,
  splitPendingBindings,
} from "./snapshot";

/**
 * tldraw store ⇄ `canvas-store.document` 的双向同步（计划 §3 规则 1）。
 *
 * 两个方向，用**文档对象身份**分辨谁先动：
 *
 *  - **editor → 文档**：`store.listen`（document 作用域）一响就重新派生一份
 *    `nodes` / `edges` 灌回 store。内容没变就什么都不做，所以相机移动、
 *    选中变化不会把画布置脏。
 *  - **文档 → editor**：只有当 `state.document` 不是上一次由这里写出去的
 *    那个对象时（= `setDocument` 换了一整份文档），才把它投影回 editor。
 *    投影走 `mergeRemoteChanges`，不进撤销栈——Agent 开的节点不能被用户
 *    一个 ⌘Z 撤掉（§10）。
 *
 * 白板快照不在每次派生时序列化（拖一次节点要序列化几十遍太贵）：这里只
 * 记「白板记录动过了」，真正的字符串由 `save/autosave.ts` 在保存那一刻取。
 */

/** 上一次投影进 editor 的画布 id；换板要整块重灌。 */
let loadedBoardId: string | null = null;

/**
 * 那次投影灌进的是**哪个** editor 实例。
 *
 * 热重载会在组件不卸载的情况下换一个新 editor（`<Tldraw>` 内部重建，
 * `onMount` 再来一次）：新实例是空的，而 `loadedBoardId` 与「已推送」标记
 * 都还是旧的，文档效应就不会再灌一次；这时任何 store 事件都会把
 * 「零个 shape」派生成空文档并保存——2026-09-04 用户的画布就是这么被
 * 存空的。所以派生与投影都要核对 editor 身份，换了实例一律重灌。
 */
let loadedEditor: Editor | null = null;

/** 仅测试用：忘掉同步状态。 */
export function resetStoreSync(): void {
  markPushed(null);
  loadedBoardId = null;
  loadedEditor = null;
}

/* ------------------------------ 记录归属判定 ------------------------------- */

function isNodeShape(shape: TLShape): shape is ArmadraShape | TLFrameShape {
  if (shape.type === "armadra") return true;
  return shape.type === "frame" && isDocumentShapeId(shape.id);
}

/**
 * 这条记录归 `nodes` / `edges` 表管吗？
 *
 * 归它管的记录变化不算白板改动——否则拖一下终端就会把白板也标成脏，
 * 每次保存都要重新序列化一份一模一样的快照。
 */
function isDocumentRecord(record: TLRecord): boolean {
  if (record.typeName === "binding") {
    // `link` binding 跟着 `edges` 表走；`arrow` binding 是白板自己的东西
    // （内容链接就是一条 arrow + 两条 binding，§6.3），改了要重存快照。
    return (record as { type?: string }).type === "link";
  }
  if (record.typeName !== "shape") return false;
  const shape = record as TLShape;
  if (shape.type === "armadra" || shape.type === "link") return true;
  return shape.type === "frame" && isDocumentShapeId(shape.id);
}

/* ------------------------------ editor → 文档 ------------------------------ */

/** 画布上所有的上下文链接（Phase 3 起是 `link` shape，不再是 arrow）。 */
function documentLinks(editor: Editor): LinkShape[] {
  const links: LinkShape[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (isLinkShape(shape)) links.push(shape);
  }
  return links;
}

/**
 * 从 editor 重新派生一份文档。
 *
 * `dirty` 决定这次派生要不要置脏：远端合并（Agent 开节点）与初次投影不置，
 * 用户自己的改动置。
 */
function pull(
  editor: Editor,
  dirty: boolean,
  whiteboardTouched: boolean,
): void {
  const document = useCanvasStore.getState().document;
  if (!document) return;
  const boardId = document.board.id;
  /**
   * 这块板还没灌进 editor 之前，editor 里的任何变化都不许派生。
   *
   * 热重载 / 换工作空间会重建 editor：新实例一挂上，`use-tldraw-preferences`
   * 就会 `updateDocumentSettings`（`document:document` 是 document 作用域、
   * `source: "user"`），这条事件比 `load()` 先到时，这里会把「零个 shape」
   * 派生成一份空文档并置脏，自动保存随即把用户的画布存空
   * （2026-09-04 link-shape 验证时真的发生过一次）。
   */
  if (loadedBoardId !== boardId || loadedEditor !== editor) return;
  const stamp = new Date().toISOString();

  const shapes = editor.getCurrentPageShapesSorted().filter(isNodeShape) as (
    | ArmadraShape
    | TLFrameShape
  )[];
  const nodes = deriveNodes(shapes, boardId, document.nodes, stamp);
  const edges = deriveEdges(documentLinks(editor), boardId, document.edges);

  if (!nodes.changed && !edges.changed) {
    // 只有白板动了：文档里的 nodes/edges 一个字节没变，但要置脏，
    // 保存那一刻才把快照序列化出来（§6.1）。
    if (whiteboardTouched && dirty) {
      useCanvasStore.setState({ saveState: "dirty" });
    }
    return;
  }

  const next: BoardDocument = {
    ...document,
    nodes: nodes.items,
    edges: edges.items,
  };
  markPushed(next);
  useCanvasStore.setState({
    document: next,
    ...(dirty ? { saveState: "dirty" as const } : {}),
  });
}

/* ------------------------------ 文档 → editor ------------------------------ */

/** 一次投影：建缺的、改变了的、删多的。分组先建，组员才有父可挂。 */
function push(editor: Editor, document: BoardDocument): void {
  const page = editor.getCurrentPageId();
  const wanted = new Map<TLShapeId, CanvasNode>(
    document.nodes.map((node) => [toShapeId(node.id), node]),
  );

  const existing = new Map<TLShapeId, TLShape>();
  for (const shape of editor.getCurrentPageShapes()) {
    if (isNodeShape(shape)) existing.set(shape.id, shape);
  }

  const doomed = [...existing.keys()].filter((id) => !wanted.has(id));

  const ordered = [...document.nodes].sort((a, b) =>
    a.type === b.type ? 0 : a.type === "group" ? -1 : 1,
  );
  for (const node of ordered) {
    const id = toShapeId(node.id);
    const shape = existing.get(id);
    const projected = nodeToShape(node, page);
    if (!shape) {
      editor.createShape(projected);
      continue;
    }
    // 位置 / 尺寸 / props 全量覆盖：远端来的那份文档就是真相。
    editor.updateShapes([
      {
        id,
        type: projected.type,
        x: projected.x,
        y: projected.y,
        props: projected.props,
        meta: projected.meta,
      } as never,
    ]);
    if (shape.parentId !== projected.parentId) {
      editor.reparentShapes([id], projected.parentId);
    }
  }

  if (doomed.length > 0) editor.deleteShapes(doomed);

  /*
   * 边：`link` shape 的 `props.edgeId` 就是 `edges` 行的 uuid（`sync/project`
   * 的 `edgeToLink`），投影与用户现拉的线是同一种记录，往返恒等。
   *
   * 白板原生 arrow 一律不动：它不是边（两端都绑节点的 arrow 会被
   * `shapes/LinkArrow.ts` 在交互结束时换成 link shape）。
   */
  const wantedEdges = new Set(document.edges.map((edge) => edge.id));
  const links = documentLinks(editor);
  const known = new Set(links.map((link) => link.props.edgeId));

  const staleLinks = links
    .filter((link) => !wantedEdges.has(link.props.edgeId))
    .map((link) => link.id);
  if (staleLinks.length > 0) editor.deleteShapes(staleLinks);

  const created: TLShapeId[] = [];
  for (const edge of document.edges) {
    if (known.has(edge.id)) continue;
    const projection = edgeToLink(edge, document.nodes, page);
    if (!projection) continue;
    editor.createShape(projection.shape);
    for (const binding of projection.bindings) editor.createBinding(binding);
    created.push(projection.shape.id);
  }
  // 线走在节点下面（与 `shapes/LinkArrow.ts` 的换形、`store.addEdge` 一致）。
  if (created.length > 0) editor.sendToBack(created);
}

/**
 * 换画布：灌白板快照（它会重置整个 store）→ 投影节点 → 补上跨两边的 binding。
 *
 * 第三步是内容链接要的（Phase 4 · §6.3）：白板上的箭头可以一端绑在节点 shape
 * 上，而节点 shape 不在快照里（`nodes` 表才是它的真相）。`loadSnapshot` 那一刻
 * 节点还不存在，这条 binding 指向的对象是空的，所以 `splitPendingBindings`
 * 先把它拆出来，等 `push` 把节点建好了再 `put` 回去。目标节点这次没投影出来
 * （被删了）的那些直接丢掉，不留悬空 binding。
 */
function load(editor: Editor, document: BoardDocument): void {
  const snapshot = parseWhiteboard(document.board.whiteboard);
  let pending: TLRecord[] = [];
  if (snapshot) {
    try {
      const split = splitPendingBindings(snapshot);
      editor.loadSnapshot(split.base);
      pending = split.pending;
    } catch {
      // 快照版本对不上就当没有白板内容：节点与连线不能因此打不开。
      pending = [];
    }
  } else {
    const all = editor.getCurrentPageShapes().map((shape) => shape.id);
    if (all.length > 0) {
      editor.run(() => editor.deleteShapes(all), { history: "ignore" });
    }
  }
  editor.store.mergeRemoteChanges(() => push(editor, document));

  if (pending.length > 0) {
    editor.store.mergeRemoteChanges(() => {
      restorePendingRecords(editor, pending);
    });
  }

  // 打开画布不该是「可以撤销的一步」。
  editor.clearHistory();
}

/* --------------------------------- 白板快照 -------------------------------- */

/**
 * 当前白板快照（已剔掉节点记录）。保存那一刻调一次；画布没挂载时返回 null，
 * 调用方保留文档里已有的那份。
 */
export function captureWhiteboard(editor: Editor | null): string | null {
  if (!editor) return null;
  return serializeWhiteboard(editor.getSnapshot().document);
}

/* ---------------------------------- hook ---------------------------------- */

export interface StoreSyncOptions {
  /** 相机变化时回调（画布负责节流写回 `setViewport`）。 */
  onCameraChange?: (camera: { x: number; y: number; z: number }) => void;
  /** 画布首次投影完成（画布据此应用初始视口）。 */
  onBoardLoaded?: (document: BoardDocument) => void;
}

export function useStoreSync(
  editor: Editor | null,
  options: StoreSyncOptions = {},
): void {
  const { onCameraChange, onBoardLoaded } = options;
  const callbacks = React.useRef({ onCameraChange, onBoardLoaded });
  callbacks.current = { onCameraChange, onBoardLoaded };

  React.useEffect(() => {
    if (!editor) return;
    // 新 editor 实例（首次挂载或热重载重建）：忘掉旧的投影记录，
    // 让下面的文档效应把这块板整块重灌进去。
    if (loadedEditor !== editor) {
      loadedBoardId = null;
      loadedEditor = null;
      markPushed(null);
    }

    let queued = false;
    let sawUserChange = false;
    let sawWhiteboard = false;

    const offStore = editor.store.listen(
      (entry) => {
        if (entry.source === "user") sawUserChange = true;
        const { added, updated, removed } = entry.changes;
        const touched = [
          ...Object.values(added),
          ...Object.values(updated).map(([, next]) => next),
          ...Object.values(removed),
        ];
        if (touched.some((record) => !isDocumentRecord(record))) {
          sawWhiteboard = true;
        }
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          const dirty = sawUserChange;
          const whiteboard = sawWhiteboard;
          sawUserChange = false;
          sawWhiteboard = false;
          pull(editor, dirty, whiteboard);
        });
      },
      { scope: "document" },
    );

    // 选中态：editor → store。反向由 `canvas-store.selectNodes` 负责。
    const offSelection = react("armadra selection", () => {
      const ids = editor
        .getSelectedShapeIds()
        .filter((id) => isDocumentShapeId(id))
        .map((id) => toNodeId(id));
      useCanvasStore.getState().selectNodes(ids);
    });

    const offCamera = react("armadra camera", () => {
      const camera = editor.getCamera();
      callbacks.current.onCameraChange?.({
        x: camera.x,
        y: camera.y,
        z: camera.z,
      });
    });

    return () => {
      offStore();
      offSelection();
      offCamera();
    };
  }, [editor]);

  // 文档 → editor。只在文档换了一整份（`setDocument`）时才走。
  const document = useCanvasStore((state) => state.document);
  React.useEffect(() => {
    if (!editor || !document) return;
    if (isPushed(document)) return;
    markPushed(document);
    if (document.board.id !== loadedBoardId || loadedEditor !== editor) {
      loadedBoardId = document.board.id;
      loadedEditor = editor;
      load(editor, document);
      callbacks.current.onBoardLoaded?.(document);
      return;
    }
    editor.store.mergeRemoteChanges(() => push(editor, document));
  }, [document, editor]);

  // 画布卸载（换工作空间、热重载）后下一次挂载要重新整块投影。
  React.useEffect(
    () => () => {
      loadedBoardId = null;
      loadedEditor = null;
      markPushed(null);
    },
    [],
  );
}
