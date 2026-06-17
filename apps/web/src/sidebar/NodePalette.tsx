/**
 * “添加节点” palette (plan §1.2): 3 columns × 9 node types. A card can be
 * clicked — the node lands in the centre of the viewport — or dragged onto the
 * canvas, where `DropLayer` creates it under the cursor (SPEC §5).
 */
import { useReactFlow } from "@xyflow/react";
import type { DragEvent } from "react";
import type { CanvasNodeType } from "@ai-coding-canvas/shared";
import { useCanvasStore, DEFAULT_NODE_SIZES } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { NODE_META, PALETTE_TYPES } from "../nodes";
import { createNodeData } from "../nodes/defaults";
import { clearDragPayload, setDragPayload } from "../canvas/dnd/payload";

export function NodePalette() {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const addNode = useCanvasStore((state) => state.addNode);
  const flow = useReactFlow();

  return (
    <div className="node-palette">
      {PALETTE_TYPES.map((type) => {
        const meta = NODE_META[type];
        return (
          <button
            key={type}
            type="button"
            className="palette-card"
            title={t(meta.descriptionKey)}
            draggable
            onDragStart={(event: DragEvent<HTMLButtonElement>) =>
              setDragPayload(event, { kind: "node", type })
            }
            onDragEnd={() => clearDragPayload()}
            onClick={() => {
              addNode(
                createNodeData(type, {
                  rootPath: workspace?.rootPath ?? ".",
                  label: t(meta.labelKey),
                }),
                viewportCentre(flow, type),
              );
            }}
          >
            <span
              className="palette-glyph"
              style={{ background: meta.softColor, color: meta.color }}
              aria-hidden="true"
            >
              {meta.glyph}
            </span>
            <span className="palette-name">{t(meta.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Centre of the stage, offset so the card itself is centred, not its corner. */
function viewportCentre(
  flow: ReturnType<typeof useReactFlow>,
  type: CanvasNodeType,
) {
  const stage =
    document.querySelector<HTMLElement>(".canvas-stage") ??
    document.querySelector<HTMLElement>(".react-flow__pane");
  if (!stage) return undefined;
  const rect = stage.getBoundingClientRect();
  const centre = flow.screenToFlowPosition({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
  const size = DEFAULT_NODE_SIZES[type];
  return {
    x: Math.round(centre.x - size.width / 2),
    y: Math.round(centre.y - size.height / 2),
  };
}
