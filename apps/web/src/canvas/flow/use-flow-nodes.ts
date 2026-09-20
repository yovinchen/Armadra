import * as React from "react";
import type {
  Connection,
  EdgeChange,
  FinalConnectionState,
  IsValidConnection,
  NodeChange,
} from "@xyflow/react";
import { toast } from "sonner";

import { t } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { MAX_LINKS } from "../content-links";
import { createContentReference } from "../create-content-reference";
import {
  classifyConnection,
  connectionRejection,
  isValidCanvasConnection,
} from "./edges/connect";
import { centerOf, hitTestGroup, nodeBox, type Box } from "../geometry";
import {
  EMPTY_SELECTION,
  isDocumentNodeId,
  isItemId,
  projectEdges,
  projectNodes,
  type CanvasFlowEdge,
  type CanvasFlowNode,
} from "../sync/project";
import { clearDrafts, setDraft, useDrafts } from "./drafts";
import { applyWebviewPool } from "@/nodes/browser/pool";
import { requestNodeNames } from "@/nodes/node-names";

/**
 * 投影 + 回调翻译（React Flow 计划 §2.1，归属 canvas）。
 *
 * React Flow 的回调**只做翻译**，不持有状态：手势结束时调 `canvas-store`
 * 的动作，store 改完文档，下一次投影把结果画出来。`applyNodeChanges` 一次
 * 都没用到——那会让 React Flow 变成第二份真相。
 */

export interface FlowBindings {
  nodes: CanvasFlowNode[];
  edges: CanvasFlowEdge[];
  onNodesChange: (changes: NodeChange<CanvasFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasFlowEdge>[]) => void;
  onNodeDrag: (event: unknown, node: CanvasFlowNode) => void;
  onNodeDragStop: (
    event: unknown,
    node: CanvasFlowNode,
    nodes: CanvasFlowNode[],
  ) => void;
  onConnect: (connection: Connection) => void;
  onConnectEnd: (
    event: MouseEvent | TouchEvent,
    state: FinalConnectionState,
  ) => void;
  isValidConnection: IsValidConnection<CanvasFlowEdge>;
}

/** 拖动中的位置只进草稿；一次手势结束才提交一条历史（§2.1 规则 2）。 */
function draftMoves(nodes: readonly CanvasFlowNode[]): void {
  for (const node of nodes) {
    setDraft(node.id, { position: { x: node.position.x, y: node.position.y } });
  }
}

/**
 * 拖动结束：先落位置，再判断有没有换父。
 *
 * 换父的判据与旧引擎一致（`geometry.hitTestGroup`）：节点中心落进
 * 哪个分组就归哪个分组，套在一起时取面积最小的那个；没落进任何分组就离组。
 * 分组自己不参与（组不能进组，沿用 store 的规则）。
 */
function commitDrag(dragged: readonly CanvasFlowNode[]): void {
  const store = useCanvasStore.getState();
  const document = store.document;
  if (!document) return;
  const ids = dragged.map((node) => node.id);
  clearDrafts(ids);

  const moves = dragged
    .filter((node) => isDocumentNodeId(node.id))
    .map((node) => ({
      id: node.id,
      position: { x: node.position.x, y: node.position.y },
    }));
  if (moves.length > 0) store.moveNodes(moves);

  const after = useCanvasStore.getState().document;
  if (!after) return;
  const groups = after.nodes
    .filter((node) => node.type === "group")
    .map((node) => ({ id: node.id, box: nodeBox(after.nodes, node) }));
  const dragging = new Set(ids);
  for (const node of after.nodes) {
    if (!dragging.has(node.id) || node.type === "group") continue;
    const centre = centerOf(nodeBox(after.nodes, node) as Box);
    const parent = hitTestGroup(groups, centre, [node.id]);
    if ((node.parentId ?? null) === parent) continue;
    useCanvasStore.getState().setParent([node.id], parent);
  }
}

export function useFlowNodes(): FlowBindings {
  /**
   * **不订阅整份 `document`。**
   *
   * `document` 的对象身份在每一次 `updateNodeData` 和**每一次平移**时都会换
   * （`store/canvas/view.ts` 的 `setViewport` 也重建 document）。订阅整份等于
   * 把「相机动了」翻译成「重投影全部节点 + React Flow 重建一次节点表」：实测
   * 十秒手形平移触发 72 次 `projectNodes`、2,232 次节点投影，而这期间
   * `commit()` 一次都没跑（`docs/status/canvas-performance-baseline.md`）。
   *
   * 投影真正要的只有两张表，所以就订这两个数组引用；`board.viewport` 变了它们
   * 不动，一次平移的投影代价归零。
   */
  const documentNodes = useCanvasStore((state) => state.document?.nodes);
  const documentEdges = useCanvasStore((state) => state.document?.edges);
  const whiteboard = useCanvasStore((state) => state.whiteboard);
  const drafts = useDrafts();
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const selectedEdgeIds = useCanvasStore((state) => state.selectedEdgeIds);
  const selectedItemIds = useCanvasStore((state) => state.selectedItemIds);

  /**
   * 选区拆成两份，**节点那份不许被边的选区碰到**。
   *
   * `projectNodes` 只读 `nodes` / `items`，`projectEdges` 只读 `edges`，可是
   * 以前两个投影共用同一个 `selected` 对象：选中一条边也会换掉 `nodes` 数组
   * 的身份，于是 React Flow 的 `StoreUpdater` 跟着调一次 `setNodes`。
   *
   * 那一次多余的 `setNodes` 会踩进一个真实的死循环：`StoreUpdater` 在同一个
   * effect 里先 `setNodes` 再 `setEdges`，而 React Flow 的选区监听器是在
   * `setNodes` 里**同步**发出的——那一刻边还是上一帧的。`onSelectionChange`
   * 于是把「节点新 + 边旧」这个半成品写回 store，下一帧投影又把它翻回来，
   * 两个值来回弹，React 报 `Maximum update depth exceeded`，整页白屏。
   * 复现：框选一个连着边的节点（便签 → 终端）。
   *
   * 拆开之后只改边的选区不再换 `nodes` 的身份，`setNodes` 不跑，半成品读不
   * 到，循环一次就收敛。
   */
  const nodeSelection = React.useMemo(
    () => ({
      nodes: new Set(selectedNodeIds),
      edges: EMPTY_SELECTION.edges,
      items: new Set(selectedItemIds),
    }),
    [selectedNodeIds, selectedItemIds],
  );
  const edgeSelection = React.useMemo(
    () => ({
      nodes: EMPTY_SELECTION.nodes,
      edges: new Set(selectedEdgeIds),
      items: EMPTY_SELECTION.items,
    }),
    [selectedEdgeIds],
  );

  /** 投影的全部输入就这两张表；身份只在表本身变了的时候换。 */
  const tables = React.useMemo(
    () =>
      documentNodes
        ? { nodes: documentNodes, edges: documentEdges ?? [] }
        : null,
    [documentNodes, documentEdges],
  );

  /**
   * 投影之后加一条顺序规则：**webview 宿主节点的相对顺序永不变化**（W3.2）。
   *
   * 探针实测：让 React 对
   * 一个已挂载的 `<webview>` 宿主元素调 `insertBefore`，guest 进程当场被杀、
   * 整页重载、`webContentsId` 换号。插入与删除是安全的，**只有移动不是**。
   * 上游的投影按「分组 → 节点 → 白板对象」排，一次换父或一次删除都可能改变
   * 浏览器节点之间的先后，所以在这里把它们摘进一个只追加的尾部区段
   * （`nodes/browser/pool.ts`）。规则归浏览器节点所有：画布这一侧只有这一行。
   *
   * 非 Electron 壳里 `applyWebviewPool` 原样返回，投影一个字节都不变。
   */
  const nodes = React.useMemo(
    () =>
      applyWebviewPool(projectNodes(tables, whiteboard, drafts, nodeSelection)),
    [tables, whiteboard, drafts, nodeSelection],
  );
  const edges = React.useMemo(
    () => projectEdges(tables, whiteboard, edgeSelection),
    [tables, whiteboard, edgeSelection],
  );

  /**
   * 变更流里我们只认「选中」这一种，而且选区**只从这两条变更流写回**。
   *
   * `onSelectionChange` 已经拆掉了：它不是变更流，而是一面**慢一帧的镜子**。
   * React Flow 的 `SelectionListener` 在渲染时取快照、在 effect 里回调，而
   * `StoreUpdater`（同一棵树里排在它前面）的 effect 已经先把这一帧的
   * `nodes` / `edges` 灌进 React Flow 的 store 了。于是它报的是上一帧的选区，
   * 照着它写回 store 就成了自激：框选一个连着边的节点（便签 → 终端）时，边
   * 在「选中 / 没选中」之间来回弹，React 报 `Maximum update depth exceeded`，
   * 整页白屏。
   *
   * 两条变更流没有这个问题——它们是用户手势当场产生的，包括点空白处取消选中
   * （React Flow 的 `unselectNodesAndEdges` 也走 `triggerNodeChanges` /
   * `triggerEdgeChanges`），信息并不比那面镜子少。
   *
   * 变更流里我们只认「选中」这一种。
   *
   * 位置与尺寸走 `onNodeDrag*` / `NodeResizer` 的回调（那里能分清手势的
   * 开始与结束），删除走 `canvas.delete`（要先结束会话并弹确认框），
   * 尺寸测量本来就由投影给死。剩下的一律忽略。
   */
  const onNodesChange = React.useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      const picks = changes.filter((change) => change.type === "select");
      if (picks.length === 0) return;
      const state = useCanvasStore.getState();
      const nodeIds = new Set(state.selectedNodeIds);
      const itemIds = new Set(state.selectedItemIds);
      for (const change of picks) {
        const bucket = isItemId(change.id) ? itemIds : nodeIds;
        if (change.selected) bucket.add(change.id);
        else bucket.delete(change.id);
      }
      state.setSelection({ nodes: [...nodeIds], items: [...itemIds] });
    },
    [],
  );

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange<CanvasFlowEdge>[]) => {
      const picks = changes.filter((change) => change.type === "select");
      if (picks.length === 0) return;
      const state = useCanvasStore.getState();
      const ids = new Set(state.selectedEdgeIds);
      for (const change of picks) {
        if (change.selected) ids.add(change.id);
        else ids.delete(change.id);
      }
      state.setSelection({ edges: [...ids] });
    },
    [],
  );

  const onNodeDrag = React.useCallback(
    (_event: unknown, node: CanvasFlowNode) => draftMoves([node]),
    [],
  );

  const onNodeDragStop = React.useCallback(
    (_event: unknown, node: CanvasFlowNode, dragged: CanvasFlowNode[]) =>
      commitDrag(dragged.length > 0 ? dragged : [node]),
    [],
  );

  /**
   * 连线合法性（§2.3 的判定表）。判定表本体是纯函数，住在
   * `flow/edges/connect.ts`（B1）；这里只把 store 的当前状态喂进去。
   *
   * 拖动中每一帧都会问一次，所以这里**不能**弹提示——「为什么不行」由
   * `onConnectEnd` 在松手那一刻说一次。
   */
  const isValidConnection = React.useCallback<
    IsValidConnection<CanvasFlowEdge>
  >((connection) => {
    const state = useCanvasStore.getState();
    return isValidCanvasConnection(connection, {
      document: state.document,
      whiteboard: state.whiteboard,
    });
  }, []);

  /**
   * 松手且合法：按判定表分流。节点 ↔ 节点是 `edges` 表的一行；有一端是
   * 白板对象时是 `whiteboard.references` 的一行（§2.3 / F29，B5）。
   *
   * 提示交给 `onConnectEnd`，所以这里 `notify: false`——`createContentReference`
   * 默认会为「已经引用过了」弹一句，拖线时那句由 React Flow 的落点高亮
   * 代劳，不必再响一次。
   */
  const onConnect = React.useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const state = useCanvasStore.getState();
    const verdict = classifyConnection(
      { source: connection.source, target: connection.target },
      { document: state.document, whiteboard: state.whiteboard },
    );
    if (verdict.kind === "reference") {
      createContentReference(verdict.itemId, verdict.nodeId, {
        notify: false,
      });
      return;
    }
    if (verdict.kind !== "link") return;
    if (state.addEdge(verdict.source, verdict.target) === null) return;
    // 一条边建立的那一刻，两端才第一次需要互相称呼（设计 §2.2）。两端各自
    // 缺名字的才会被问，可以跳过——跳过之后连线照样成立。
    requestNodeNames([verdict.source, verdict.target]);
  }, []);

  /**
   * 松手：只在**落到了某个节点上却被拒绝**时提示一次。
   *
   * 拖到空白处松手是「取消」，不是错误（把手是用来连东西的，空放什么都不
   * 发生）。合法的那一次也不提示，而且必须先看 `isValid`：React Flow 在
   * `onConnect` **之后**才调这里，那时边已经建好了，再判定一次得到的是
   * 「这两个节点已经连过了」——刚连上就说重复。
   */
  const onConnectEnd = React.useCallback(
    (
      _event: MouseEvent | TouchEvent,
      connectionState: FinalConnectionState,
    ) => {
      if (connectionState.isValid) return;
      const from = connectionState.fromNode?.id ?? null;
      const to = connectionState.toNode?.id ?? null;
      if (!from || !to) return;
      const state = useCanvasStore.getState();
      const verdict = classifyConnection(
        { source: from, target: to },
        { document: state.document, whiteboard: state.whiteboard },
      );
      const message = connectionRejection(verdict);
      if (message) toast.error(t(message, { limit: MAX_LINKS }));
    },
    [],
  );

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onNodeDrag,
    onNodeDragStop,
    onConnect,
    onConnectEnd,
    isValidConnection,
  };
}

export { EMPTY_SELECTION };
