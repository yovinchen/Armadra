/**
 * Makes a node card a drop target (plan §1.4 / SPEC §5): dropping a file,
 * folder or image on an **Agent** creates the matching File/Context/Image node
 * to its left, links it with a `ref` edge and appends a context chip.
 *
 * Every other node type returns inert handlers, so `NodeCard` can spread the
 * result unconditionally.
 */
import { useCallback, useState, type DragEvent } from "react";
import type {
  CanvasNodeType,
  ContextChip,
  ContextChipKind,
} from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../../store/canvas-store";
import { usePreferences } from "../../preferences/Preferences";
import {
  clearDragPayload,
  currentDragPayload,
  nodeDataForPayload,
  readDragPayload,
  type DragPayload,
} from "./payload";
import { setDropHint } from "./hint";

export interface NodeDropTarget {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  isOver: boolean;
}

const INERT: NodeDropTarget = {
  onDragOver: () => undefined,
  onDragLeave: () => undefined,
  onDrop: () => undefined,
  isOver: false,
};

/** Offset of the node created next to the Agent (prototype `dropOnNode`). */
const ATTACH_OFFSET = { x: -320, y: 40 };

export function useNodeDropTarget(
  nodeId: string,
  nodeType: CanvasNodeType,
): NodeDropTarget {
  const { t } = usePreferences();
  const [isOver, setIsOver] = useState(false);
  const accepts = nodeType === "agent";

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!accepts) return;
      const payload = currentDragPayload();
      if (!payload || payload.kind === "node") return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropHint(t("dnd.hint.agent"));
      setIsOver(true);
    },
    [accepts, t],
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!accepts) return;
      event.stopPropagation();
      // The stage listener restores its own hint on the next `dragover`.
      setIsOver(false);
    },
    [accepts],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!accepts) return;
      const payload =
        readDragPayload(event.dataTransfer) ?? currentDragPayload();
      clearDragPayload();
      setIsOver(false);
      setDropHint(null);
      if (!payload || payload.kind === "node") return;
      event.preventDefault();
      event.stopPropagation();
      attachToAgent(nodeId, payload, t);
    },
    [accepts, nodeId, t],
  );

  if (!accepts) return INERT;
  return { onDragOver, onDragLeave, onDrop, isOver };
}

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** New node + `ref` edge + context chip, in that order (SPEC §5). */
export function attachToAgent(
  agentId: string,
  payload: DragPayload,
  t: Translate,
): void {
  const store = useCanvasStore.getState();
  const agent = store.document?.nodes.find((node) => node.id === agentId);
  if (!agent || agent.data.kind !== "agent") return;

  const created = store.addNode(
    nodeDataForPayload(payload, {
      rootPath: store.workspace?.rootPath ?? ".",
      t,
      // `node` payloads never reach this branch, so the label is unused.
      label: () => "",
    }),
    {
      x: agent.position.x + ATTACH_OFFSET.x,
      y: agent.position.y + ATTACH_OFFSET.y,
    },
    // Keep the Agent as the inspector subject — the drop is about its context.
    { select: false },
  );
  if (!created) return;

  store.addEdge(created.id, agentId, "ref");

  const chip: ContextChip = {
    id: crypto.randomUUID(),
    kind: chipKind(payload),
    label: chipLabel(payload),
    value: chipValue(payload),
  };
  const existing = agent.data.contextChips ?? [];
  if (existing.some((entry) => entry.value === chip.value)) return;
  useCanvasStore
    .getState()
    .updateNode(agentId, { contextChips: [...existing, chip] });
}

function chipKind(payload: DragPayload): ContextChipKind {
  if (payload.kind === "folder") return "context";
  if (payload.kind === "file") return "file";
  // The chip vocabulary has no `image` kind (domain §2).
  return "text";
}

function chipLabel(payload: DragPayload): string {
  const label = payload.kind === "node" ? payload.type : payload.name;
  return label.length > 160 ? `${label.slice(0, 159)}…` : label;
}

function chipValue(payload: DragPayload): string {
  return payload.kind === "node" ? payload.type : payload.path;
}
