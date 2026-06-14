import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import { projectEdge, projectNode } from "@ai-coding-canvas/shared";
import type { CanvasNodeType } from "@ai-coding-canvas/shared";
import { AnimatePresence } from "motion/react";
import { useCanvasStore } from "../store/canvas-store";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NodeCard, type CanvasFlowNode } from "./NodeCard";
import {
  SemanticEdge,
  SemanticEdgeMarkers,
  type SemanticFlowEdge,
} from "./SemanticEdge";
import { legalEdgeTypes } from "./edge-types";
import { usePreferences } from "../preferences/Preferences";
import { DropLayer } from "./dnd/DropLayer";
import { usePasteToCanvas } from "./dnd/paste";
import { NODE_META } from "../nodes";
import { createNodeData } from "../nodes/defaults";
import { CanvasToolbar } from "./CanvasToolbar";
import { EdgePicker, PICKER_HEIGHT, PICKER_WIDTH } from "./EdgePicker";
import { PenCapture, StrokeLayer, type LiveStroke } from "./StrokeLayer";
import { MAX_ZOOM, MIN_ZOOM, ZoomControls } from "./ZoomControls";
import { effectiveSize } from "./node-zoom";

const nodeTypes = {
  task: NodeCard,
  agent: NodeCard,
  terminal: NodeCard,
  diff: NodeCard,
  file: NodeCard,
  context: NodeCard,
  note: NodeCard,
  browser: NodeCard,
  image: NodeCard,
  log: NodeCard,
};

const edgeTypes = { semantic: SemanticEdge };

/** Margin used when clamping the semantics popover inside the stage. */
const PICKER_MARGIN = 12;

interface PickerState {
  connection: Connection;
  x: number;
  y: number;
}

/** The v2 canvas: tri-state nodes, semantic edges, pen strokes, toolbars. */
export function CanvasWorkspace() {
  const { resolvedTheme, t } = usePreferences();
  const stageRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);
  const deleteResolver = useRef<((allowed: boolean) => void) | null>(null);
  const connectionRef = useRef<Connection | null>(null);
  const [deleteSummary, setDeleteSummary] = useState("");
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [live, setLive] = useState<LiveStroke | null>(null);

  const document = useCanvasStore((state) => state.document);
  const workspace = useCanvasStore((state) => state.workspace);
  const tool = useCanvasStore((state) => state.tool);
  const threshold = useCanvasStore((state) => state.summaryThreshold);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const selectNode = useCanvasStore((state) => state.selectNode);
  const moveNode = useCanvasStore((state) => state.moveNode);
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const removeEdges = useCanvasStore((state) => state.removeEdges);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const addNode = useCanvasStore((state) => state.addNode);
  const setModal = useCanvasStore((state) => state.setModal);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const viewportZoom = useStore((state) => state.transform[2]);
  const { screenToFlowPosition, zoomTo } = useReactFlow();
  usePasteToCanvas();

  const summary = viewportZoom < threshold;
  const focusedNode = document?.nodes.find((node) => node.zoom === "focus");
  const documentNodes = document?.nodes;
  const documentEdges = document?.edges;

  // The projection only cares whether the canvas is below the summary
  // threshold, so the live zoom is collapsed to a stable 0/1 first: panning
  // and zooming must not rebuild every node object.
  const sizeZoom = summary ? 0 : 1;
  const projectedNodes = useMemo(
    () =>
      (documentNodes ?? []).map((node) => {
        const size = effectiveSize(node, sizeZoom, 0.5);
        return {
          ...projectNode(node),
          width: size.width,
          height: size.height,
          selected: node.id === selectedNodeId,
        } as CanvasFlowNode;
      }),
    [documentNodes, selectedNodeId, sizeZoom],
  );
  const projectedEdges = useMemo(
    () => (documentEdges ?? []).map(projectEdge) as SemanticFlowEdge[],
    [documentEdges],
  );
  const [nodes, setNodes, applyNodeChanges] = useNodesState(projectedNodes);
  const [edges, setEdges, applyEdgeChanges] = useEdgesState(projectedEdges);

  useEffect(() => {
    if (!draggingRef.current) setNodes(projectedNodes);
  }, [projectedNodes, setNodes]);

  useEffect(() => setEdges(projectedEdges), [projectedEdges, setEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      applyNodeChanges(changes);
      const removed = changes
        .filter((change) => change.type === "remove")
        .map((change) => change.id);
      if (removed.length > 0) removeNodes(removed);
      for (const change of changes) {
        if (change.type === "select" && change.selected) selectNode(change.id);
      }
    },
    [applyNodeChanges, removeNodes, selectNode],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<SemanticFlowEdge>[]) => {
      applyEdgeChanges(changes);
      const removed = changes
        .filter((change) => change.type === "remove")
        .map((change) => change.id);
      if (removed.length > 0) removeEdges(removed);
    },
    [applyEdgeChanges, removeEdges],
  );

  // onConnect knows the endpoints, onConnectEnd knows where the pointer was
  // released — the picker needs both (SPEC §4).
  const onConnect = useCallback((connection: Connection) => {
    connectionRef.current = connection;
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    const stage = stageRef.current;
    if (!connection?.source || !connection.target || !stage) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const rect = stage.getBoundingClientRect();
    const clamp = (value: number, size: number) =>
      Math.max(
        PICKER_MARGIN,
        Math.min(value, Math.max(PICKER_MARGIN, size - PICKER_MARGIN)),
      );
    setPicker({
      connection,
      x: clamp(
        (point?.clientX ?? rect.left) - rect.left,
        rect.width - PICKER_WIDTH,
      ),
      y: clamp(
        (point?.clientY ?? rect.top) - rect.top,
        rect.height - PICKER_HEIGHT,
      ),
    });
  }, []);

  const pickerNodes = useMemo(() => {
    if (!document || !picker) return null;
    const source = document.nodes.find(
      (node) => node.id === picker.connection.source,
    );
    const target = document.nodes.find(
      (node) => node.id === picker.connection.target,
    );
    if (!source || !target) return null;
    return {
      source,
      target,
      types: legalEdgeTypes(source.type, target.type),
    };
  }, [document, picker]);

  const addAt = useCallback(
    (type: CanvasNodeType) => {
      const stage = stageRef.current;
      const rect = stage?.getBoundingClientRect();
      const centre = rect
        ? screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        : undefined;
      const size = NODE_META[type].defaultSize;
      addNode(
        createNodeData(type, {
          rootPath: workspace?.rootPath ?? ".",
          label: t(NODE_META[type].labelKey),
        }),
        centre
          ? { x: centre.x - size.width / 2, y: centre.y - size.height / 2 }
          : undefined,
      );
    },
    [addNode, screenToFlowPosition, t, workspace?.rootPath],
  );

  if (!document) return null;

  return (
    <main
      id="canvas-main"
      className={`canvas-stage${tool === "pen" ? " is-pen" : ""}`}
      ref={stageRef}
      aria-label={t("canvas.label")}
    >
      <ReactFlow<CanvasFlowNode, SemanticFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onBeforeDelete={({ nodes: nodesToDelete, edges: edgesToDelete }) =>
          new Promise<boolean>((resolve) => {
            deleteResolver.current?.(false);
            deleteResolver.current = resolve;
            const parts = [];
            if (nodesToDelete.length > 0)
              parts.push(
                t("canvas.delete.nodes", { count: nodesToDelete.length }),
              );
            if (edgesToDelete.length > 0)
              parts.push(
                t("canvas.delete.edges", { count: edgesToDelete.length }),
              );
            setDeleteSummary(parts.join("和"));
          })
        }
        onNodeDragStart={() => {
          draggingRef.current = true;
        }}
        onNodeDragStop={(_, node) => {
          draggingRef.current = false;
          moveNode(node.id, node.position);
        }}
        onPaneClick={() => selectNode(null)}
        nodesDraggable={tool === "select"}
        panOnDrag={tool === "select"}
        selectionOnDrag={false}
        nodesConnectable
        elementsSelectable
        onMoveEnd={(_event, viewport: Viewport) => setViewport(viewport)}
        defaultViewport={document.board.viewport}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        deleteKeyCode={["Backspace", "Delete"]}
        colorMode={resolvedTheme}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--dot)"
        />
        <SemanticEdgeMarkers />
        <StrokeLayer live={live} />
        {tool === "pen" && <PenCapture onLive={setLive} />}
      </ReactFlow>

      {document.nodes.length === 0 && (
        <div className="canvas-empty">
          <div className="canvas-empty-card">
            <span className="canvas-empty-glyph" aria-hidden="true">
              ▦
            </span>
            <h2>{t("canvas.empty.title", { board: document.board.name })}</h2>
            <p>{t("canvas.empty.body")}</p>
            <div className="canvas-empty-actions">
              <button
                type="button"
                className="canvas-empty-primary"
                onClick={() => addAt("task")}
              >
                ☰ {t("canvas.empty.task")}
              </button>
              <button type="button" onClick={() => addAt("agent")}>
                ✦ {t("canvas.empty.agent")}
              </button>
              <button type="button" onClick={() => setModal("command")}>
                ⌘K {t("canvas.empty.command")}
              </button>
            </div>
          </div>
        </div>
      )}

      {!focusedNode && <CanvasToolbar />}
      <ZoomControls />
      {summary && (
        <div className="canvas-pill canvas-summary-hint">
          <span className="canvas-pill-glyph" aria-hidden="true">
            ◎
          </span>
          {t("canvas.summary.hint", {
            zoom: `${Math.round(viewportZoom * 100)}%`,
          })}
          <button type="button" onClick={() => void zoomTo(1)}>
            {t("canvas.summary.reset")}
          </button>
        </div>
      )}

      <DropLayer />

      <AnimatePresence>
        {picker && pickerNodes && (
          <EdgePicker
            key="edge-picker"
            fromTitle={pickerNodes.source.data.title}
            toTitle={pickerNodes.target.data.title}
            types={pickerNodes.types}
            x={picker.x}
            y={picker.y}
            onCancel={() => setPicker(null)}
            onPick={(type) => {
              addEdge(
                picker.connection.source!,
                picker.connection.target!,
                type,
              );
              setPicker(null);
            }}
          />
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={Boolean(deleteSummary)}
        title={t("canvas.delete.title")}
        description={t("canvas.delete.description", { summary: deleteSummary })}
        confirmLabel={t("canvas.delete.confirm")}
        onCancel={() => {
          deleteResolver.current?.(false);
          deleteResolver.current = null;
          setDeleteSummary("");
        }}
        onConfirm={() => {
          deleteResolver.current?.(true);
          deleteResolver.current = null;
          setDeleteSummary("");
        }}
      />
    </main>
  );
}
