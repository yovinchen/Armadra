import {
  memo,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type {
  CanvasNodeData,
  CanvasNodeType,
  NodeZoom,
} from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import {
  NODE_CONTENT,
  NODE_META,
  SPINNING_STATUSES,
  STATUS_META,
} from "../nodes";
import { useNodeDropTarget } from "./dnd/useNodeDropTarget";
import { MINI_SIZE, effectiveZoom } from "./node-zoom";

export type CanvasFlowNode = Node<CanvasNodeData, CanvasNodeType>;

export { MINI_SIZE };

/** Keeps a header button from starting a node drag. */
function swallow(
  event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>,
) {
  event.stopPropagation();
}

/**
 * Node shell (plan §5): header + registry body + ports, in the tri-state zoom
 * of SPEC §3. The per-type body lives in `nodes/index.ts` (B3).
 */
export const NodeCard = memo(function NodeCard({
  id,
  data,
  selected,
}: NodeProps<CanvasFlowNode>) {
  const storedZoom = useCanvasStore(
    (state) =>
      state.document?.nodes.find((node) => node.id === id)?.zoom ?? "normal",
  );
  const threshold = useCanvasStore((state) => state.summaryThreshold);
  const setNodeZoom = useCanvasStore((state) => state.setNodeZoom);
  const viewportZoom = useStore((state) => state.transform[2]);
  const drop = useNodeDropTarget(id, data.kind);

  const wrapper = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setStage(wrapper.current?.closest<HTMLElement>(".canvas-stage") ?? null);
  }, []);

  const zoom = effectiveZoom({ zoom: storedZoom }, viewportZoom, threshold);
  const focused = zoom === "focus";

  const card = (
    <Card
      id={id}
      data={data}
      zoom={zoom}
      selected={Boolean(selected)}
      onZoom={(next) => setNodeZoom(id, next)}
      isOver={drop.isOver}
    />
  );

  return (
    <div
      ref={wrapper}
      className={`canvas-node-wrapper${focused ? " is-focused" : ""}`}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="semantic-handle semantic-handle--target"
      />
      {focused && stage
        ? createPortal(
            <div className="canvas-focus-layer">
              <FocusHint
                title={data.title}
                onExit={() => setNodeZoom(id, "normal")}
              />
              {card}
            </div>,
            stage,
          )
        : card}
      <Handle
        type="source"
        position={Position.Right}
        className="semantic-handle semantic-handle--source"
      />
    </div>
  );
});

function FocusHint({ title, onExit }: { title: string; onExit: () => void }) {
  const { t } = usePreferences();
  return (
    <div className="canvas-pill canvas-focus-hint">
      <span className="canvas-pill-glyph" aria-hidden="true">
        ⤢
      </span>
      {t("canvas.focus.hint", { title })}
      <button type="button" onClick={onExit}>
        {t("canvas.focus.exit")}
      </button>
    </div>
  );
}

function Card({
  id,
  data,
  zoom,
  selected,
  isOver,
  onZoom,
}: {
  id: string;
  data: CanvasNodeData;
  zoom: NodeZoom;
  selected: boolean;
  isOver: boolean;
  onZoom: (zoom: NodeZoom) => void;
}) {
  const { t } = usePreferences();
  const meta = NODE_META[data.kind];
  const Content = NODE_CONTENT[data.kind];
  const mini = zoom === "mini";
  const focused = zoom === "focus";

  return (
    <article
      className={[
        "canvas-node",
        `canvas-node--${data.kind}`,
        mini ? "canvas-node--mini" : "",
        focused ? "canvas-node--focus" : "",
        selected ? "is-selected" : "",
        isOver ? "is-drop-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        mini ? { width: MINI_SIZE.width, height: MINI_SIZE.height } : undefined
      }
      aria-label={`${t(meta.labelKey)}: ${data.title}`}
    >
      <header
        className="node-header"
        onDoubleClick={(event) => {
          event.stopPropagation();
          onZoom(focused ? "normal" : "focus");
        }}
      >
        <span
          className="node-glyph"
          style={{ background: meta.softColor, color: meta.color }}
          title={t(meta.labelKey)}
          aria-hidden="true"
        >
          {meta.glyph}
        </span>
        <span className="node-title" title={data.title}>
          {data.title}
        </span>
        <StatusBadge status={data.status} />
        <div className="node-controls">
          {mini ? (
            <button
              type="button"
              className="nodrag"
              title={t("node.expand")}
              aria-label={t("node.expand")}
              onPointerDown={swallow}
              onClick={(event) => {
                swallow(event);
                onZoom("normal");
              }}
            >
              ＋
            </button>
          ) : (
            <>
              <button
                type="button"
                className="nodrag"
                title={t("node.mini")}
                aria-label={t("node.mini")}
                onPointerDown={swallow}
                onClick={(event) => {
                  swallow(event);
                  onZoom("mini");
                }}
              >
                −
              </button>
              <button
                type="button"
                className="nodrag"
                title={focused ? t("node.exitFocus") : t("node.focus")}
                aria-label={focused ? t("node.exitFocus") : t("node.focus")}
                onPointerDown={swallow}
                onClick={(event) => {
                  swallow(event);
                  onZoom(focused ? "normal" : "focus");
                }}
              >
                {focused ? "⤡" : "⤢"}
              </button>
            </>
          )}
        </div>
      </header>
      {!mini && (
        <div className="node-body nodrag nowheel">
          <Content id={id} data={data} focused={focused} />
        </div>
      )}
    </article>
  );
}

function StatusBadge({
  status,
}: {
  status: CanvasNodeData["status"];
}): ReactNode {
  const { t } = usePreferences();
  const meta = STATUS_META[status];
  return (
    <span className={`node-status node-status--${status}`}>
      <span
        aria-hidden="true"
        className={SPINNING_STATUSES.includes(status) ? "is-spinning" : ""}
      >
        {meta.glyph}
      </span>
      {t(meta.label)}
    </span>
  );
}
