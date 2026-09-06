import * as React from "react";
import type {
  Connection,
  EdgeChange,
  FinalConnectionState,
  IsValidConnection,
  NodeChange,
  OnSelectionChangeParams,
} from "@xyflow/react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { t } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { MAX_LINKS } from "../content-links";
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
  onSelectionChange: (params: OnSelectionChangeParams) => void;
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
  const document = useCanvasStore((state) => state.document);
  const whiteboard = useCanvasStore((state) => state.whiteboard);
  const drafts = useDrafts();
  const selection = useCanvasStore(
    useShallow((state) => ({
      nodes: state.selectedNodeIds,
      edges: state.selectedEdgeIds,
      items: state.selectedItemIds,
    })),
  );

  const selected = React.useMemo(
    () => ({
      nodes: new Set(selection.nodes),
      edges: new Set(selection.edges),
      items: new Set(selection.items),
    }),
    [selection],
  );

  const nodes = React.useMemo(
    () => projectNodes(document, whiteboard, drafts, selected),
    [document, whiteboard, drafts, selected],
  );
  const edges = React.useMemo(
    () => projectEdges(document, whiteboard, selected),
    [document, whiteboard, selected],
  );

  /**
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
   * 一次写三项选区（§2.8）。`selectedNodeIds` 仍然只装节点，白板对象与边
   * 各有一格，删除时按 id 前缀分流（`tools.splitSelectionForDelete`）。
   */
  const onSelectionChange = React.useCallback(
    (params: OnSelectionChangeParams) => {
      const nodeIds: string[] = [];
      const itemIds: string[] = [];
      for (const node of params.nodes) {
        if (isItemId(node.id)) itemIds.push(node.id);
        else nodeIds.push(node.id);
      }
      useCanvasStore.getState().setSelection({
        nodes: nodeIds,
        items: itemIds,
        edges: params.edges.map((edge) => edge.id),
      });
    },
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

  const onConnect = React.useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    useCanvasStore.getState().addEdge(connection.source, connection.target);
  }, []);

  /**
   * 松手：只在**落到了某个节点上却被拒绝**时提示一次。
   *
   * 拖到空白处松手是「取消」，不是错误（把手是用来连东西的，空放什么都不
   * 发生）；落在合法目标上时 `onConnect` 已经建好了边，也没什么可说的。
   */
  const onConnectEnd = React.useCallback(
    (
      _event: MouseEvent | TouchEvent,
      connectionState: FinalConnectionState,
    ) => {
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
    onSelectionChange,
    onConnect,
    onConnectEnd,
    isValidConnection,
  };
}

export { EMPTY_SELECTION };
