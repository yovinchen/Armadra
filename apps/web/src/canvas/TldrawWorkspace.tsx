import * as React from "react";
import {
  Tldraw,
  defaultShapeUtils,
  type Editor,
  type TLCameraOptions,
  type TLComponents,
  type TLUiOverrides,
} from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { Lock, LockOpen } from "lucide-react";
import type { TLShape, TLShapeId } from "tldraw";
import type { BoardDocument, CanvasNode } from "@ai-coding-canvas/shared";
import "tldraw/tldraw.css";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { IconButton } from "@/ui/icon-button";
import { useEnabledAgents } from "@/app/use-agents";
import { useT } from "@/app/preferences-store";
import { useBoardAutosave } from "@/save/autosave";
import { useCanvasStore } from "@/store/canvas-store";
import { runtimeApi } from "@/api/client";
import { createAssetStore } from "./assets";
import { isCanvasLocked, setCanvasLocked, useCanvasLocked } from "./canvas-lock";
import { registerCanvasCommands, type CanvasCommandId } from "./commands";
import { registerEscapeToSelect } from "./escape-to-select";
import { CENTER_NODE_EVENT, setEditor } from "./editor-context";
import { usePublishContextLinks } from "./context-links";
import { registerExternalContent } from "./dnd/external-content";
import { useOsDrop, usePasteToCanvas } from "./dnd/os-drop";
import { boundingBox, nearestInDirection, nodeBox, type Box } from "./geometry";
import { AddMenuContent } from "./menus/AddMenuContent";
import { NodeMenuContent } from "./menus/node-menu";
import { ShapeMenuContent } from "./menus/shape-menu";
import { CanvasOverlays } from "./overlays/CanvasOverlays";
import { StatusMinimap } from "./overlays/StatusMinimap";
import { CanvasStylePanel } from "./StylePanel";
import { AiccShapeUtil } from "./shapes/AiccShapeUtil";
import { registerLinkArrow } from "./shapes/LinkArrow";
import { LinkBindingUtil } from "./shapes/LinkBindingUtil";
import { LinkShapeUtil } from "./shapes/LinkShapeUtil";
import {
  RETIRED_SHAPE_TYPES,
  activeShapeUtils,
  registerRetiredShapes,
} from "./shapes/retired-shapes";
import { isDocumentShapeId, toNodeId, toShapeId } from "./shapes/aicc-shape";
import { edgeIdOfShape } from "./sync/derive";
import {
  CANVAS_TOOLS,
  isToolDisabledWhenLocked,
  splitSelectionForDelete,
  type SelectedShapeInfo,
} from "./tools";
import { useStoreSync } from "./sync/use-store-sync";
import { initialViewportFor, isDefaultViewport } from "./viewport";
import { MAX_ZOOM, MIN_ZOOM } from "./zoom";

/**
 * 画布本体（tldraw 计划 §7）。
 *
 * 与 React Flow 时代最大的差别：**tldraw 的 store 才是内存真相**。这个组件
 * 只负责装配——挂 `<Tldraw>`、把 editor 交给 `editor-context`、把命令表、
 * 右键菜单、自动保存、拖放、视口恢复接回来；文档 ⇄ shape 的双向同步全在
 * `sync/use-store-sync.ts` 里。
 */

/** 字体与图标全部自托管（Phase 0 结论 5；WKWebView 离线可用）。 */
const assetUrls = getAssetUrlsByImport();

/**
 * 白板资产仓库（§6.2）。工作区 id 现取现用：`<Tldraw>` 只在挂载时读一次
 * `assets`，换工作区时不会拿新实例重建 store，所以不能把 id 捕获成常量。
 */
const assets = createAssetStore(
  () => useCanvasStore.getState().workspace?.id ?? null,
);

/** 最大化时四周留出的边距（屏幕像素）。 */
export const MAXIMIZE_MARGIN = 24;

/** 相机持久化的节流间隔：连续平移时每 300ms 记一次。 */
const CAMERA_THROTTLE_MS = 300;

/**
 * §5「tldraw UI 槽位」：Dock / 右键菜单 / 命令面板承担的槽位全部置空，
 * 只留 StylePanel 与 NavigationPanel（Minimap 的宿主，置空缩略图就没了）。
 */
const components: TLComponents = {
  Toolbar: null,
  MenuPanel: null,
  PageMenu: null,
  HelpMenu: null,
  DebugPanel: null,
  DebugMenu: null,
  KeyboardShortcutsDialog: null,
  ContextMenu: null,
  QuickActions: null,
  ActionsMenu: null,
  HelperButtons: null,
  ZoomMenu: null,
  MainMenu: null,
  SharePanel: null,
  TopPanel: null,
  OnTheCanvas: CanvasOverlays,
  // 缩略图按 Agent 状态描边（§3.2）：`MinimapManager` 只认 4 个全局颜色变量，
  // 所以整块自己画。宿主仍是 `NavigationPanel`，别把它置空。
  Minimap: StatusMinimap,
  // 样式面板复用 tldraw 的实现，只加一层显隐（§12 第 2 条）。
  StylePanel: CanvasStylePanel,
};

/** §5：tldraw 自己的快捷键全部摘掉，全应用只留 `keybindings.ts` 一个监听器。 */
const overrides: TLUiOverrides = {
  actions(_editor, actions) {
    for (const action of Object.values(actions)) delete action.kbd;
    return actions;
  },
  tools(_editor, tools) {
    // 停用的四种 shape 连工具项都不留（§4.5）。
    for (const type of RETIRED_SHAPE_TYPES) delete tools[type];
    for (const tool of Object.values(tools)) delete tool.kbd;
    return tools;
  },
};

/**
 * 显式的 shape 清单：tldraw 默认集合去掉 `note` / `bookmark` / `embed` /
 * `video`（§4.5），加上我们自己的两种。
 *
 * `<Tldraw>` 会把默认集合无条件合回来（只替换同名的），所以这份清单是**意图
 * 声明**，真正拦住创建的是 `onMount` 里的 `registerRetiredShapes`；两处一起
 * 看才完整，别只改一处。
 */
const shapeUtils = [
  ...activeShapeUtils(defaultShapeUtils),
  AiccShapeUtil,
  LinkShapeUtil,
];
/** 上下文链接的两端绑定（§4.3，Phase 3 link-shape）。 */
const bindingUtils = [LinkBindingUtil];

/** §5 手势分工：滚轮平移、⌘/Ctrl+滚轮与捏合缩放 0.1–3。 */
const camera: TLCameraOptions = {
  isLocked: false,
  wheelBehavior: "pan",
  panSpeed: 1,
  zoomSpeed: 1,
  zoomSteps: [MIN_ZOOM, 0.25, 0.5, 1, 1.5, 2, MAX_ZOOM],
};

/** 删除节点前结束它的终端会话：否则 tmux 里会留下没人看的孤儿进程（§15.6）。 */
function endSessionsOf(nodeIds: readonly string[]): void {
  const document = useCanvasStore.getState().document;
  if (!document) return;
  for (const node of document.nodes) {
    if (!nodeIds.includes(node.id) || node.data.kind !== "terminal") continue;
    const sessionId = node.data.sessionId;
    if (!sessionId) continue;
    void runtimeApi.terminateTerminal(sessionId, "session").catch(() => {
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

export function TldrawWorkspace() {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const agents = useEnabledAgents();
  const [editor, setLocalEditor] = React.useState<Editor | null>(null);
  // 锁定状态住在 `canvas-lock.ts`：Dock 的工具组在这棵树之外，要一起读。
  const locked = useCanvasLocked();
  const [menuNode, setMenuNode] = React.useState<CanvasNode | null>(null);
  const [menuShape, setMenuShape] = React.useState<TLShape | null>(null);
  const [menuPosition, setMenuPosition] = React.useState({ x: 0, y: 0 });
  const [pendingDelete, setPendingDelete] =
    React.useState<PendingDelete | null>(null);

  useBoardAutosave();
  usePasteToCanvas();
  usePublishContextLinks();
  const { onDragOver, onDrop } = useOsDrop();

  const onMount = React.useCallback((instance: Editor) => {
    setEditor(instance);
    setLocalEditor(instance);
    // 「箭头即上下文链接」的身份 / 合法性 / 样式（§4.3）。
    const offLinkArrow = registerLinkArrow(instance);
    // `Esc` 回选择（§5）：tldraw 自己那条在文字编辑之后会失效，见模块注释。
    const offEscape = registerEscapeToSelect(instance);
    // 图片 / 文本 / OS 文件的分流（§4.5，Phase 3 content）。
    const offExternalContent = registerExternalContent(instance);
    // 停用的四种原生 shape（§4.5）：创建即撤销。
    const offRetired = registerRetiredShapes(instance);
    return () => {
      offEscape();
      offLinkArrow();
      offExternalContent();
      offRetired();
      setEditor(null);
      setLocalEditor(null);
    };
  }, []);

  /* ------------------------------ 视口 ----------------------------------- */

  /**
   * 100% 打开（§20）：把视口移到内容包围盒左上角，缩放固定 1。
   * 整理之后也复用它——`zoomToFit` 会为了塞下所有节点而缩小画布。
   */
  const applyInitialViewport = React.useCallback(() => {
    const nodes = useCanvasStore.getState().document?.nodes ?? [];
    const viewport = initialViewportFor(
      nodes.map((node) => ({
        x: node.position.x,
        y: node.position.y,
        parentId: node.parentId ?? null,
      })),
    );
    useCanvasStore.getState().setViewport(viewport);
  }, []);

  /**
   * 首次打开一个看板：从没存过视口（或还是默认的 `{0,0,1}`）就按 100%
   * 对齐左上角；存过的视口原样恢复，用户上次停在哪就还在哪。
   */
  const onBoardLoaded = React.useCallback(
    (document: BoardDocument) => {
      const persisted = document.board.viewport;
      if (!isDefaultViewport(persisted)) {
        useCanvasStore.getState().setViewport(persisted);
        return;
      }
      applyInitialViewport();
    },
    [applyInitialViewport],
  );

  /**
   * 相机 → 文档（原 `onMoveEnd` 的等价物）。
   *
   * 节流而不是防抖：连续平移时每 300ms 记一次，松手后最后一次也会落下。
   * 平移不置 dirty，`save/autosave.ts` 有单独的视口通道。
   */
  const cameraTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCamera = React.useRef<{ x: number; y: number; z: number } | null>(
    null,
  );
  const onCameraChange = React.useCallback(
    (next: { x: number; y: number; z: number }) => {
      pendingCamera.current = next;
      if (cameraTimer.current) return;
      cameraTimer.current = setTimeout(() => {
        cameraTimer.current = null;
        const latest = pendingCamera.current;
        if (!latest) return;
        // tldraw 的相机是「页面坐标的平移量」，文档里存的是屏幕像素。
        useCanvasStore.getState().setViewport({
          x: latest.x * latest.z,
          y: latest.y * latest.z,
          zoom: latest.z,
        });
      }, CAMERA_THROTTLE_MS);
    },
    [],
  );

  React.useEffect(
    () => () => {
      if (cameraTimer.current) clearTimeout(cameraTimer.current);
    },
    [],
  );

  useStoreSync(editor, { onCameraChange, onBoardLoaded });

  /* ------------------------------ 锁定 ----------------------------------- */

  /**
   * 「锁定视图」锁的是相机，不是编辑（文案就是 `canvas.lock` = Lock camera）。
   * 不用 `updateInstanceState({ isReadonly })`：5.4 的 `isReadonly` 是从
   * 编辑器的 `mode` 派生出来的，从外面写它会被下一次派生覆盖。
   */
  React.useEffect(() => {
    if (!editor) return;
    editor.setCameraOptions({ isLocked: locked });
    // 白板工具跟着一起停（Phase 3 第 6 条）：Dock 上置灰，正在用的那个
    // 也要退回选择，否则锁上之后还能继续画。
    if (locked && isToolDisabledWhenLocked(editor.getCurrentToolId())) {
      editor.setCurrentTool("select");
    }
  }, [editor, locked]);

  // 画布卸载时把锁一起解开，换看板不会带着上一块的锁定状态。
  React.useEffect(() => () => setCanvasLocked(false), []);

  /* ------------------------------ 删除 ----------------------------------- */

  const requestDelete = React.useCallback((nodes: string[], edges: string[]) => {
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
  }, []);

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

  /** 会话侧栏点一行 → 把画布居中到那个节点。 */
  const centerOnNode = React.useCallback(
    (nodeId: string) => {
      if (!editor) return;
      const bounds = editor.getShapePageBounds(toShapeId(nodeId));
      if (!bounds) return;
      // 太小的时候顺手放大到 60%，否则「定位到那个节点」等于定位到一个点。
      const zoom = Math.max(editor.getZoomLevel(), 0.6);
      if (zoom !== editor.getZoomLevel()) {
        const point = editor.getCamera();
        editor.setCamera({ x: point.x, y: point.y, z: zoom }, { immediate: true });
      }
      editor.centerOnPoint(bounds.center, { animation: { duration: 200 } });
    },
    [editor],
  );

  React.useEffect(() => {
    if (!editor) return;
    const store = () => useCanvasStore.getState();
    const firstSelected = () => store().selectedNodeIds[0] ?? null;

    /** 视口内减去 24px 边距的画布矩形，最大化用。 */
    const maximizeRect = () => {
      const bounds = editor.getViewportPageBounds();
      const margin = MAXIMIZE_MARGIN / (editor.getZoomLevel() || 1);
      return {
        x: bounds.x + margin,
        y: bounds.y + margin,
        width: Math.max(bounds.width - margin * 2, 200),
        height: Math.max(bounds.height - margin * 2, 160),
      };
    };

    const boxes = (): { id: string; box: Box }[] => {
      const nodes = store().document?.nodes ?? [];
      return nodes.map((node) => ({ id: node.id, box: nodeBox(nodes, node) }));
    };

    /**
     * 适应视图：**只缩小不放大**（§20）。
     *
     * `targetZoom: 1` 是 `zoomToBounds` 的「够放得下就用 100%」，
     * 但它没写进 `zoomToFit` 的 TS 签名，所以自己算包围盒再调。
     * Dock 的「适应」用的是同一套算法，两处行为必须一致。
     */
    const fitView = () => {
      const rect = boundingBox(
        [...editor.getCurrentPageShapeIds()]
          .map((id) => editor.getShapePageBounds(id))
          .filter((box) => box !== undefined)
          .map((box) => ({
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          })),
      );
      if (!rect) return;
      // tldraw 的 `BoxLike` 用 `w/h`，我们的 `Box` 用 `width/height`。
      editor.zoomToBounds(
        { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        { targetZoom: 1, animation: { duration: 200 } },
      );
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
     * 白板工具（§5）。一份表驱动 Dock、快捷键、命令面板；id 就是 tldraw
     * 自己的工具 id，所以这里没有映射表。锁定时除选择外一概不响应。
     */
    const toolCommands: Partial<Record<CanvasCommandId, () => void>> = {};
    for (const tool of CANVAS_TOOLS) {
      toolCommands[tool.command] = () => {
        if (isCanvasLocked() && isToolDisabledWhenLocked(tool.id)) return;
        editor.setCurrentTool(tool.id);
      };
    }
    return registerCanvasCommands({
      "canvas.undo": () => store().undo(),
      "canvas.redo": () => store().redo(),
      "canvas.tidy": () => {
        // 目标区域按当前视口的宽高比裹（§23），排出来的矩形才贴合屏幕。
        const bounds = editor.getViewportScreenBounds();
        const aspect =
          bounds.width > 0 && bounds.height > 0
            ? bounds.width / bounds.height
            : undefined;
        store().arrangeNodes({ aspect });
        // 整理完 fitView：既然已经裹成一屏的形状，就让它真的落在一屏里。
        window.requestAnimationFrame(fitView);
      },
      "canvas.fitView": fitView,
      "canvas.zoomIn": () => editor.zoomIn(undefined, { animation: { duration: 120 } }),
      "canvas.zoomOut": () =>
        editor.zoomOut(undefined, { animation: { duration: 120 } }),
      "canvas.zoom100": () =>
        editor.resetZoom(undefined, { animation: { duration: 120 } }),
      // 白板 shape 也要进选区（Phase 2 待办 3），所以全选归 tldraw；
      // `selectNodes` 那一侧会把节点部分投影回 `selectedNodeIds`。
      "canvas.selectAll": () => editor.selectAll(),
      "canvas.delete": () => {
        const known = new Set(
          (store().document?.nodes ?? []).map((node) => node.id),
        );
        const edgeIds = new Set(
          (store().document?.edges ?? []).map((edge) => edge.id),
        );
        const split = splitSelectionForDelete(
          editor.getSelectedShapes().map(
            (shape): SelectedShapeInfo => ({
              id: shape.id,
              type: shape.type,
              // 「什么算边」只在 derive.ts 定义一次：link shape 与旧 arrow 都认。
              edgeId: edgeIdOfShape(shape),
              nodeId:
                edgeIdOfShape(shape) === null && isDocumentShapeId(shape.id)
                  ? toNodeId(shape.id)
                  : null,
            }),
          ),
          known,
          edgeIds,
        );
        // 纯白板 shape 直接删（Phase 2 待办 1）：它们不在 `nodes` / `edges`
        // 里，没有会话要结束，也没有确认框要弹。
        if (split.shapes.length > 0) {
          editor.deleteShapes(split.shapes as TLShapeId[]);
        }
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
      // 便签的 Markdown 预览开关由便签自己接管（nodes agent），
      // 这里占位免得快捷键落空报错。
      "canvas.toggleMarkdown": () => undefined,
      ...toolCommands,
    });
  }, [centerOnNode, editor, requestDelete]);

  React.useEffect(() => {
    const onCenter = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      if (nodeId) centerOnNode(nodeId);
    };
    window.addEventListener(CENTER_NODE_EVENT, onCenter);
    return () => window.removeEventListener(CENTER_NODE_EVENT, onCenter);
  }, [centerOnNode]);

  /* ------------------------------ 右键菜单 -------------------------------- */

  /**
   * tldraw 的 `ContextMenu` 槽已置空，所以右键由容器上的 Radix Trigger 接。
   * 命中哪个节点用 `getShapeAtPoint` 自己问一遍——React Flow 时代的
   * `onNodeContextMenu` 没有对应物。
   */
  const onContextMenu = React.useCallback(
    (event: React.MouseEvent) => {
      if (!editor) return;
      const page = editor.screenToPage({ x: event.clientX, y: event.clientY });
      setMenuPosition({ x: page.x, y: page.y });
      const hit = editor.getShapeAtPoint(page, {
        hitInside: true,
        hitFrameInside: true,
      });
      const nodes = useCanvasStore.getState().document?.nodes ?? [];
      const node =
        hit && hit.type !== "arrow" && isDocumentShapeId(hit.id)
          ? nodes.find((item) => item.id === toNodeId(hit.id))
          : undefined;
      setMenuNode(node ?? null);
      // 命中的不是节点但确实命中了东西 = 白板 shape（含边箭头），走 shape 菜单。
      setMenuShape(node || !hit ? null : hit);
    },
    [editor],
  );

  const addMenuContext = React.useMemo(
    () =>
      workspace
        ? {
            addNode: useCanvasStore.getState().addNode,
            position: menuPosition,
            workspace,
            agents,
          }
        : null,
    [agents, menuPosition, workspace],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          // 壳给的容器是 `relative flex-1` 但不是 flex 容器，所以这里必须
          // 自己撑满（只写 flex-1 会塌成 0 高，画布整块看不见）。
          className="canvas-stage relative h-full w-full min-h-0 min-w-0 flex-1"
          style={{ background: "var(--canvas-bg)" }}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onContextMenu={onContextMenu}
          aria-label={t("canvas.label")}
        >
          <Tldraw
            assetUrls={assetUrls}
            assets={assets}
            components={components}
            overrides={overrides}
            shapeUtils={shapeUtils}
            bindingUtils={bindingUtils}
            options={{ camera }}
            onMount={onMount}
          />
          <IconButton
            label={locked ? t("canvas.unlock") : t("canvas.lock")}
            aria-pressed={locked}
            className="absolute bottom-3 left-3 z-[var(--z-dock)] border border-border bg-[var(--panel)]/90 backdrop-blur-[12px]"
            onClick={() => setCanvasLocked(!locked)}
          >
            {locked ? <Lock /> : <LockOpen />}
          </IconButton>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-44">
        {menuNode ? (
          <NodeMenuContent node={menuNode} />
        ) : menuShape ? (
          <ShapeMenuContent shape={menuShape} />
        ) : addMenuContext ? (
          <AddMenuContent ctx={addMenuContext} kind="context" />
        ) : null}
      </ContextMenuContent>

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
