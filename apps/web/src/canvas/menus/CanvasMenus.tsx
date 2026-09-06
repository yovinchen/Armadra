import * as React from "react";
import type { Edge, Node } from "@xyflow/react";
import type { AgentInfo, Position, Workspace } from "@armadra/shared";

import { ContextMenuContent } from "@/ui/context-menu";
import { useEnabledAgents } from "@/app/use-agents";
import { useCanvasStore } from "@/store/canvas-store";
import { getFlow } from "../flow/flow-context";
import { isItemId } from "../whiteboard/model";
import { AddMenuContent } from "./AddMenuContent";
import { EdgeMenuContent } from "./edge-menu";
import { ItemMenuContent } from "./item-menu";
import { NodeMenuContent } from "./node-menu";

/**
 * 画布右键菜单（React Flow 计划 F18）：一个 `<ContextMenuTrigger>` 下的
 * 四种内容，按右键落在什么东西上分流。
 *
 * 分流由 React Flow 的四个回调做，不由我们自己命中测试：
 * `onPaneContextMenu`（空白）→ 新建菜单、`onNodeContextMenu`（节点或白板
 * 对象，两者都是 RF 节点）→ 节点菜单 / 对象菜单、`onEdgeContextMenu` → 边
 * 菜单、`onSelectionContextMenu`（多选框）→ 按选区里第一样东西定。
 *
 * Radix 的 `<ContextMenu>` 在同一次 `contextmenu` 事件里既收到 RF 的回调、
 * 又自己开菜单，而 React 的事件是批处理的：RF 的回调先跑（它挂在里层
 * DOM），`setTarget` 与 Radix 的开菜单在同一批里落地，所以菜单展开时读到的
 * 已经是新目标，不会闪一帧上一次的内容。
 *
 * `FlowWorkspace` 只接这一处（§5.3 的 `<CanvasMenus />` 插槽）：
 * `useCanvasMenus()` 吐出的 `handlers` 摊给 `<ReactFlow>`，`menus` 摆在
 * `<ContextMenuTrigger>` 后面。
 */

export type CanvasMenuTarget =
  | { kind: "pane" }
  | { kind: "node"; nodeId: string }
  | { kind: "item"; itemId: string }
  | { kind: "edge"; edgeId: string };

export interface CanvasMenuHandlers {
  onPaneContextMenu: (event: React.MouseEvent | MouseEvent) => void;
  onNodeContextMenu: (event: React.MouseEvent, node: Node) => void;
  onEdgeContextMenu: (event: React.MouseEvent, edge: Edge) => void;
  onSelectionContextMenu: (event: React.MouseEvent, nodes: Node[]) => void;
}

export interface CanvasMenus {
  handlers: CanvasMenuHandlers;
  menus: React.ReactNode;
}

/** RF 节点 id → 菜单目标：`wb:` 前缀是白板对象，其余是文档节点。 */
export function targetForNodeId(id: string): CanvasMenuTarget {
  return isItemId(id)
    ? { kind: "item", itemId: id }
    : { kind: "node", nodeId: id };
}

/**
 * 多选框上的右键：选区里既有节点又有白板对象时以**节点**为准。
 *
 * 节点菜单里的分组 / 最大化 / 删除本来就作用于整个选区（`targetIds`），
 * 而对象菜单只认白板那一半；混合选区下给节点菜单，用户才能一次删完。
 */
export function targetForSelection(ids: readonly string[]): CanvasMenuTarget {
  const node = ids.find((id) => !isItemId(id));
  if (node) return { kind: "node", nodeId: node };
  const item = ids[0];
  return item ? { kind: "item", itemId: item } : { kind: "pane" };
}

export function useCanvasMenus(): CanvasMenus {
  const workspace = useCanvasStore((state) => state.workspace);
  const agents = useEnabledAgents();
  const [target, setTarget] = React.useState<CanvasMenuTarget>({
    kind: "pane",
  });
  // 新建菜单的落点：右键那一下的画布坐标（新节点落在指针下，不是视口中心）。
  const [position, setPosition] = React.useState<Position>({ x: 0, y: 0 });

  const rememberPoint = React.useCallback(
    (event: { clientX: number; clientY: number }) => {
      const flow = getFlow();
      if (!flow) return;
      setPosition(
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [],
  );

  const handlers = React.useMemo<CanvasMenuHandlers>(
    () => ({
      onPaneContextMenu: (event) => {
        rememberPoint(event);
        setTarget({ kind: "pane" });
      },
      onNodeContextMenu: (event, node) => {
        rememberPoint(event);
        setTarget(targetForNodeId(node.id));
      },
      onEdgeContextMenu: (event, edge) => {
        rememberPoint(event);
        setTarget({ kind: "edge", edgeId: edge.id });
      },
      onSelectionContextMenu: (event, nodes) => {
        rememberPoint(event);
        setTarget(targetForSelection(nodes.map((node) => node.id)));
      },
    }),
    [rememberPoint],
  );

  const menus = (
    <ContextMenuContent className="min-w-44">
      <CanvasMenuBody
        target={target}
        position={position}
        workspace={workspace}
        agents={agents}
      />
    </ContextMenuContent>
  );

  return { handlers, menus };
}

/* -------------------------------------------------------------------------- */

function CanvasMenuBody({
  target,
  position,
  workspace,
  agents,
}: {
  target: CanvasMenuTarget;
  position: Position;
  workspace: Workspace | null;
  agents: AgentInfo[];
}) {
  const node = useCanvasStore((state) =>
    target.kind === "node"
      ? (state.document?.nodes.find((item) => item.id === target.nodeId) ??
        null)
      : null,
  );

  if (target.kind === "edge") return <EdgeMenuContent edgeId={target.edgeId} />;
  if (target.kind === "item") return <ItemMenuContent itemId={target.itemId} />;
  // 节点在菜单展开的这一帧被远端删掉时退回新建菜单，而不是空菜单。
  if (node) return <NodeMenuContent node={node} />;
  if (!workspace) return null;
  return (
    <AddMenuContent
      kind="context"
      ctx={{
        addNode: useCanvasStore.getState().addNode,
        position,
        workspace,
        agents,
      }}
    />
  );
}
