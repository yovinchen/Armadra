import * as React from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ViewportPortal,
  useReactFlow,
} from "@xyflow/react";
import type { BoardDocument, CanvasNode } from "@armadra/shared";
import "@xyflow/react/dist/style.css";
import "../styles/canvas.css";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { ContextMenu, ContextMenuTrigger } from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { usePreferencesStore, useResolvedTheme } from "@/app/preferences-store";
import { canvasColorScheme } from "@/app/use-canvas-preferences";
import { canEditCanvas, useCanvasOwnership } from "@/canvas-ownership";
import { useBoardAutosave } from "@/save/autosave";
import { sessionGateway } from "@/session";
import { useCanvasStore } from "@/store/canvas-store";
import {
  isCanvasLocked,
  setCanvasLocked,
  useCanvasLocked,
} from "./canvas-lock";
import { registerCanvasCommands, type CanvasCommandId } from "./commands";
import { registerEscapeToSelect } from "./escape-to-select";
import { usePublishContextLinks } from "./context-links";
import { useOsDrop, usePasteToCanvas } from "./dnd/os-drop";
import { flowOptions } from "./flow/flow-options";
import {
  CENTER_NODE_EVENT,
  setFlow,
  setFlowContainer,
} from "./flow/flow-context";
import { clearAllDrafts } from "./flow/drafts";
import ConnectionLine from "./flow/edges/ConnectionLine";
import { edgeTypes } from "./flow/edges/edge-types";
import { nodeTypes } from "./flow/nodes/node-types";
import { useFlowNodes } from "./flow/use-flow-nodes";
import {
  applyBoardViewport,
  centerOnNode,
  fitView,
  useViewportSync,
  zoomByStep,
  zoomToLevel,
} from "./flow/use-flow-viewport";
import { boundingBox, nearestInDirection, nodeBox, type Box } from "./geometry";
import { setTool, useTool } from "./interaction/tool-store";
import {
  CONNECTION_RADIUS,
  DELETE_KEY_CODE,
  NODE_DRAG_THRESHOLD,
  SELECTION_KEY_CODE,
} from "./interaction/keyboard";
import { useCanvasMenus } from "./menus/CanvasMenus";
import { Minimap } from "./flow/Minimap";
import { CanvasOverlays } from "./flow/overlays/CanvasOverlays";
import { CanvasStylePanel } from "./StylePanel";
import { removeItems, removeReferences } from "./whiteboard/store";
import { ToolLayer } from "./whiteboard/tools/ToolLayer";
import { resetProjectionCache } from "./sync/project";
import {
  CANVAS_TOOLS,
  isToolDisabledWhenLocked,
  splitSelectionForDelete,
} from "./tools";
import { MAX_ZOOM, MIN_ZOOM } from "./zoom";

/**
 * 画布本体（React Flow 计划 §2.1）。
 *
 * `canvas-store` 是唯一内存真相；React Flow 是受控视图。这个组件只负责
 * 装配——把投影与回调接上（`flow/use-flow-nodes.ts`）、把实例交给
 * `flow/flow-context`、把命令表、右键菜单、自动保存、拖放、视口恢复接回来。
 *
 * §5.3 的四个挂载点在这里：`nodeTypes` / `edgeTypes` 两个常量文件、
 * `<ToolLayer />` 与 `<CanvasMenus />` 两个插槽、`onBoardOpened(document)`
 * 钩子。后面几批只碰那四处，不改这个文件。
 */

/** 最大化时四周留出的边距（屏幕像素）。 */
export const MAXIMIZE_MARGIN = 24;

/** 删除节点前结束它的终端会话：否则 tmux 里会留下没人看的孤儿进程。 */
function endSessionsOf(nodeIds: readonly string[]): void {
  const document = useCanvasStore.getState().document;
  if (!document) return;
  for (const node of document.nodes) {
    if (!nodeIds.includes(node.id) || node.data.kind !== "terminal") continue;
    const sessionId = node.data.sessionId;
    if (!sessionId) continue;
    void sessionGateway
      .terminate(
        useCanvasStore.getState().workspace?.id ?? "",
        sessionId,
        "session",
      )
      .catch(() => {
        /* 会话可能早已结束；Runtime 的巡检会兜底 */
      });
  }
}

/** 选中项里有活着的会话吗？有就要先弹确认框。 */
function hasLiveSession(ids: readonly string[]): boolean {
  const nodes = useCanvasStore.getState().document?.nodes ?? [];
  return ids.some((id) => {
    const node = nodes.find((item) => item.id === id);
    return node?.data.kind === "terminal" && Boolean(node.data.sessionId);
  });
}

interface PendingDelete {
  nodes: string[];
  edges: string[];
}

/**
 * 打开一块画布时跑一次的钩子（§5.3 的挂载点）。
 *
 * B1–B5 需要在开板时初始化什么（缩略图、内容引用的缓存…）就往这里加，
 * 不必改 `FlowWorkspace` 的其它部分。B0 只做视口恢复。
 */
function onBoardOpened(document: BoardDocument): void {
  applyBoardViewport(document);
}

const ATTRIBUTION = { hideAttribution: true } as const;

/**
 * **画布自己订阅，不跟着应用壳重渲。**
 *
 * `AppShell` 里挂着一排查询与事件订阅：一次会话结束会让 `sessions` /
 * `git-status` / `board` 几个查询接连失效，实测一次会话状态跳动里 `AppShell`
 * 为根的重渲有四次、每次约 1,045 个组件，而画布这一整棵子树就在里面
 * （`docs/status/canvas-performance-baseline.md`）。
 *
 * 它一个 prop 都不收，所以 `memo` 是一道干净的墙：壳自己重渲多少次都到此为
 * 止，画布只在它订阅的 store 真的变了的时候重画。
 */
export const FlowWorkspace = React.memo(FlowWorkspaceInner);

function FlowWorkspaceInner() {
  const t = useT();
  const flow = useReactFlow();
  const theme = useResolvedTheme();
  const preferences = usePreferencesStore((state) => state.whiteboard);
  const ownership = useCanvasOwnership((state) => state.status);
  const editable = canEditCanvas(ownership);
  // 锁定状态住在 `canvas-lock.ts`：Dock 的工具组在这棵树之外，要一起读。
  const locked = useCanvasLocked();
  const [pendingDelete, setPendingDelete] =
    React.useState<PendingDelete | null>(null);
  const container = React.useRef<HTMLDivElement>(null);

  const bindings = useFlowNodes();
  // 右键菜单插槽（§5.3）：`handlers` 摊给 `<ReactFlow>`，`menus` 摆在
  // 触发器后面。四种菜单的分流与目标状态都在 `menus/CanvasMenus.tsx`。
  const { handlers: menuHandlers, menus } = useCanvasMenus();
  useViewportSync();
  useBoardAutosave();
  usePasteToCanvas();
  usePublishContextLinks();
  const { onDragOver, onDrop } = useOsDrop();

  /* ------------------------------ 生命周期 -------------------------------- */

  React.useEffect(() => {
    setFlow(flow);
    setFlowContainer(container.current);
    const offEscape = container.current
      ? registerEscapeToSelect({ container: container.current })
      : () => {};
    return () => {
      offEscape();
      setFlow(null);
      setFlowContainer(null);
      clearAllDrafts();
      resetProjectionCache();
      // 画布卸载时把锁一起解开，换画布不会带着上一块的锁定状态。
      setCanvasLocked(false);
    };
  }, [flow]);

  /** 开板一次：视口恢复（`board.id` 变了才算换了一块板）。 */
  const boardId = useCanvasStore((state) => state.document?.board.id);
  const document = useCanvasStore((state) => state.document);
  const opened = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!document || !boardId || opened.current === boardId) return;
    opened.current = boardId;
    onBoardOpened(document);
  }, [boardId, document]);

  /** 锁上之后正在用的白板工具也要退回选择，否则还能继续画。 */
  React.useEffect(() => {
    if (locked) setTool("select");
  }, [locked]);

  /* ------------------------------ 删除 ----------------------------------- */

  const requestDelete = React.useCallback(
    (nodes: string[], edges: string[]) => {
      if (nodes.length === 0 && edges.length === 0) return;
      if (!hasLiveSession(nodes)) {
        const store = useCanvasStore.getState();
        if (edges.length > 0) store.removeEdges(edges);
        if (nodes.length > 0) {
          endSessionsOf(nodes);
          store.removeNodes(nodes);
        }
        return;
      }
      setPendingDelete({ nodes, edges });
    },
    [],
  );

  const confirmDelete = React.useCallback(() => {
    if (!pendingDelete) return;
    const store = useCanvasStore.getState();
    if (pendingDelete.edges.length > 0) store.removeEdges(pendingDelete.edges);
    if (pendingDelete.nodes.length > 0) {
      endSessionsOf(pendingDelete.nodes);
      store.removeNodes(pendingDelete.nodes);
    }
    setPendingDelete(null);
  }, [pendingDelete]);

  /* ------------------------------ 命令 ----------------------------------- */

  React.useEffect(() => {
    const store = () => useCanvasStore.getState();
    const firstSelected = () => store().selectedNodeIds[0] ?? null;

    /** 视口内减去 24px 边距的画布矩形，最大化用。 */
    const maximizeRect = () => {
      const viewport = flow.getViewport();
      const rect = container.current?.getBoundingClientRect();
      const zoom = viewport.zoom || 1;
      const margin = MAXIMIZE_MARGIN / zoom;
      return {
        x: -viewport.x / zoom + margin,
        y: -viewport.y / zoom + margin,
        width: Math.max((rect?.width ?? 0) / zoom - margin * 2, 200),
        height: Math.max((rect?.height ?? 0) / zoom - margin * 2, 160),
      };
    };

    const boxes = (): { id: string; box: Box }[] => {
      const nodes = store().document?.nodes ?? [];
      return nodes.map((node) => ({ id: node.id, box: nodeBox(nodes, node) }));
    };

    const focus = (direction: "left" | "right" | "up" | "down") => () => {
      const from = firstSelected();
      if (!from) return;
      const next = nearestInDirection(boxes(), from, direction);
      if (!next) return;
      store().selectNodes([next]);
      centerOnNode(next);
    };

    /**
     * 白板工具（F21）。一份表驱动 Dock、快捷键、命令面板；锁定时除选择外
     * 一概不响应。B2 之前只有选择与手真的有效果。
     */
    const toolCommands: Partial<Record<CanvasCommandId, () => void>> = {};
    for (const tool of CANVAS_TOOLS) {
      toolCommands[tool.command] = () => {
        if (isCanvasLocked() && isToolDisabledWhenLocked(tool.id)) return;
        setTool(tool.id);
      };
    }

    return registerCanvasCommands({
      "canvas.undo": () => store().undo(),
      "canvas.redo": () => store().redo(),
      "canvas.tidy": () => {
        // 目标区域按当前视口的宽高比裹，排出来的矩形才贴合屏幕。
        const rect = container.current?.getBoundingClientRect();
        const aspect =
          rect && rect.width > 0 && rect.height > 0
            ? rect.width / rect.height
            : undefined;
        store().arrangeNodes({ aspect });
        // 整理完 fitView：既然已经裹成一屏的形状，就让它真的落在一屏里。
        window.requestAnimationFrame(fitView);
      },
      "canvas.fitView": fitView,
      "canvas.zoomIn": () => zoomByStep(1),
      "canvas.zoomOut": () => zoomByStep(-1),
      "canvas.zoom100": () => zoomToLevel(1),
      "canvas.selectAll": () => {
        const state = store();
        state.setSelection({
          nodes: (state.document?.nodes ?? []).map((node) => node.id),
          items: state.whiteboard.items.map((item) => `wb:${item.id}`),
          edges: [
            ...(state.document?.edges ?? []).map((edge) => edge.id),
            // 引用边与连线在选区里共用一格，全选自然也该把它们框进来。
            ...state.whiteboard.references.map((reference) => reference.id),
          ],
        });
      },
      "canvas.delete": () => {
        const state = store();
        const split = splitSelectionForDelete(
          [
            ...state.selectedNodeIds,
            ...state.selectedEdgeIds,
            ...state.selectedItemIds,
          ],
          new Set((state.document?.nodes ?? []).map((node) => node.id)),
          new Set((state.document?.edges ?? []).map((edge) => edge.id)),
          new Set(state.whiteboard.references.map((reference) => reference.id)),
        );
        // 白板对象与引用直接删：没有会话要结束，也没有确认框要弹。
        if (split.items.length > 0) removeItems(split.items);
        if (split.references.length > 0) removeReferences(split.references);
        requestDelete(split.nodes, split.edges);
      },
      "canvas.duplicate": () => store().duplicateNodes(store().selectedNodeIds),
      "canvas.group": () => {
        const state = store();
        const nodes = state.document?.nodes ?? [];
        const members = state.selectedNodeIds.filter((id) => {
          const node = nodes.find((item) => item.id === id);
          return node && node.type !== "group";
        });
        if (members.length === 0) return;
        const rect = boundingBox(
          members
            .map((id) => nodes.find((node) => node.id === id))
            .filter((node): node is CanvasNode => Boolean(node))
            .map((node) => nodeBox(nodes, node)),
        );
        if (!rect) return;
        const padding = 32;
        const groupId = state.addNode("group", {
          position: { x: rect.x - padding, y: rect.y - padding - 12 },
          size: {
            width: rect.width + padding * 2,
            height: rect.height + padding * 2 + 12,
          },
          select: false,
        });
        if (groupId) store().setParent(members, groupId);
      },
      "canvas.maximize": () => {
        const id = firstSelected();
        if (!id) return;
        if (store().maximized[id]) store().restoreNode(id);
        else store().maximizeNode(id, maximizeRect());
      },
      "canvas.restore": () => {
        const id = firstSelected();
        if (id) store().restoreNode(id);
      },
      "canvas.closeNode": () => {
        const id = firstSelected();
        if (id) requestDelete([id], []);
      },
      "canvas.focusLeft": focus("left"),
      "canvas.focusRight": focus("right"),
      "canvas.focusUp": focus("up"),
      "canvas.focusDown": focus("down"),
      // 便签的 Markdown 预览开关由便签自己接管，这里占位免得快捷键落空报错。
      "canvas.toggleMarkdown": () => undefined,
      ...toolCommands,
    });
  }, [flow, requestDelete]);

  React.useEffect(() => {
    const onCenter = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      if (nodeId) centerOnNode(nodeId);
    };
    window.addEventListener(CENTER_NODE_EVENT, onCenter);
    return () => window.removeEventListener(CENTER_NODE_EVENT, onCenter);
  }, []);

  /* ------------------------------ 渲染 ------------------------------------ */

  // 手形工具改 `panOnDrag` / `selectionOnDrag` / `nodesDraggable` 三项
  // （`flow-options`），所以当前工具也是这张表的输入。
  const tool = useTool();
  const options = React.useMemo(
    () => flowOptions({ whiteboard: preferences, locked, editable, tool }),
    [editable, locked, preferences, tool],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={container}
          // 壳给的容器是 `relative flex-1` 但不是 flex 容器，所以这里必须
          // 自己撑满（只写 flex-1 会塌成 0 高，画布整块看不见）。
          className="canvas-stage relative h-full w-full min-h-0 min-w-0 flex-1"
          style={{ background: "var(--canvas-bg)" }}
          onDragOverCapture={onDragOver}
          onDropCapture={onDrop}
          aria-label={t("canvas.label")}
        >
          <ReactFlow
            {...bindings}
            {...options}
            // 右下角的「React Flow」链接不显示（2026-09-14 反馈）。MIT 许可
            // 不要求它；React Flow 只对商业项目提出订阅 Pro 的请求，与此无关。
            proOptions={ATTRIBUTION}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={canvasColorScheme(preferences.background, theme)}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            // 终端不能卸载：xterm 的 `fit()` 一旦量到 0×0，回到视口时
            // 行列数就错了（F01）。
            onlyRenderVisibleElements={false}
            // 全应用只有 `keybindings.ts` 一个键盘监听器（F13）。
            deleteKeyCode={DELETE_KEY_CODE}
            selectionKeyCode={SELECTION_KEY_CODE}
            nodeDragThreshold={NODE_DRAG_THRESHOLD}
            connectionRadius={CONNECTION_RADIUS}
            connectionMode={ConnectionMode.Loose}
            // 选中一个终端不该让它压过别人（§2.4）。
            elevateNodesOnSelect={false}
            // 方向键归 `canvas.focus*`，Tab 循环焦点会和节点体抢。
            disableKeyboardA11y
            {...menuHandlers}
            // 预览线与落成后的边共用同一条贝塞尔（§2.5，B1）。
            connectionLineComponent={ConnectionLine}
          >
            {preferences.grid ? (
              <Background
                variant={BackgroundVariant.Dots}
                gap={preferences.gridSize}
                color="var(--canvas-dot)"
              />
            ) : null}
            {/* 派生层（rope / 子代理卡片）：坐标是画布坐标，
                `<ViewportPortal>` 已经替我们做完相机变换（F07）。 */}
            {/* 状态缩略图（F20，B1）。它是 `<Panel>`，位置在 canvas.css 里。 */}
            <Minimap />
            <ViewportPortal>
              <CanvasOverlays />
            </ViewportPortal>
            {/* 白板工具覆盖层（`whiteboard/tools/ToolLayer.tsx`）。 */}
            <ToolLayer />
          </ReactFlow>
          <CanvasStylePanel />
        </div>
      </ContextMenuTrigger>

      {menus}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.session.title")}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("delete.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>
              {t("delete.session.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ContextMenu>
  );
}
