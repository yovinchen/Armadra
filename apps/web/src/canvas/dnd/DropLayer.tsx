/**
 * Canvas-wide drop affordance (plan §1.4 / SPEC §5): dashed highlight plus the
 * “松开创建 ×× 节点” pill, and the drop handler that turns a payload into a
 * node at the world position under the cursor.
 *
 * The listeners are attached natively to `.canvas-stage` instead of through
 * React props because the stage element belongs to B1's `CanvasWorkspace`;
 * this layer only needs an anchor inside it.
 */
import { useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import type { CanvasNodeData, Position } from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../../store/canvas-store";
import { usePreferences } from "../../preferences/Preferences";
import { NODE_META } from "../../nodes";
import {
  clampTitle,
  clearDragPayload,
  formatBytes,
  formatOf,
  currentDragPayload,
  hasOsFiles,
  nodeDataForPayload,
  noteDataFromText,
  readDragPayload,
  type DragPayload,
  type Translate,
} from "./payload";
import { setDropHint, useDropHint } from "./hint";

/** Mirrors `MAX_IMAGE_SRC_BYTES` in the domain schema. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Anything larger is not worth inlining into a Note node. */
const MAX_TEXT_BYTES = 256 * 1024;

export function DropLayer() {
  const anchorRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();
  const { t } = usePreferences();
  const hint = useDropHint();
  const addNode = useCanvasStore((state) => state.addNode);
  const rootPath = useCanvasStore((state) => state.workspace?.rootPath ?? ".");

  useEffect(() => {
    const stage = anchorRef.current?.closest<HTMLElement>(".canvas-stage");
    if (!stage) return;

    // dragenter/dragleave also fire when crossing child elements, so the
    // overlay is driven by a depth counter rather than by a single leave.
    let depth = 0;
    const reset = () => {
      depth = 0;
      setDropHint(null);
    };

    const describe = (payload: DragPayload | null): string => {
      if (!payload) return t("dnd.hint.files");
      switch (payload.kind) {
        case "file":
          return t("dnd.hint.file");
        case "folder":
          return t("dnd.hint.folder");
        case "image":
          return t("dnd.hint.image");
        case "node":
          return t("dnd.hint.node", {
            name: t(NODE_META[payload.type].labelKey),
          });
      }
    };

    const accepts = (event: DragEvent) =>
      Boolean(currentDragPayload()) ||
      hasOsFiles(event.dataTransfer) ||
      Array.from(event.dataTransfer?.types ?? []).includes("text/plain");

    const onDragEnter = (event: DragEvent) => {
      if (!accepts(event)) return;
      depth += 1;
      setDropHint(describe(currentDragPayload()));
    };

    const onDragOver = (event: DragEvent) => {
      if (!accepts(event)) return;
      // Without this the browser refuses the drop entirely.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (depth === 0) depth = 1;
      setDropHint(describe(currentDragPayload()));
    };

    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropHint(null);
    };

    const onDrop = (event: DragEvent) => {
      reset();
      const target = event.target as Element | null;
      // A drop that landed on a node card is the node's business
      // (`useNodeDropTarget`); dropping on a non-Agent node does nothing.
      if (target?.closest?.(".react-flow__node")) {
        clearDragPayload();
        return;
      }
      const payload =
        readDragPayload(event.dataTransfer) ?? currentDragPayload();
      clearDragPayload();
      const position = flow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      if (payload) {
        event.preventDefault();
        addNode(
          nodeDataForPayload(payload, {
            rootPath,
            t,
            label: (type) => t(NODE_META[type].labelKey),
          }),
          position,
        );
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void importOsFiles(files, position, t, (data, at) => {
          addNode(data, at);
        });
        return;
      }
      // Text dragged in from another app follows the paste rule: a Note.
      const text = event.dataTransfer?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      event.preventDefault();
      addNode(noteDataFromText(text, t("dnd.subtitle.dragged")), position);
    };

    stage.addEventListener("dragenter", onDragEnter);
    stage.addEventListener("dragover", onDragOver);
    stage.addEventListener("dragleave", onDragLeave);
    stage.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
    return () => {
      stage.removeEventListener("dragenter", onDragEnter);
      stage.removeEventListener("dragover", onDragOver);
      stage.removeEventListener("dragleave", onDragLeave);
      stage.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
      setDropHint(null);
    };
  }, [addNode, flow, rootPath, t]);

  return (
    <div className="drop-layer" ref={anchorRef} data-active={hint ? "" : null}>
      {hint && (
        <div className="drop-hint" role="status">
          <span className="drop-hint-pill">{hint}</span>
        </div>
      )}
    </div>
  );
}

/**
 * OS-level drops: images become Image nodes with an inline data URL, text-ish
 * files become Note nodes, everything else is skipped loudly (plan §4: no fake
 * data — a binary we cannot read must not become an empty node).
 */
export async function importOsFiles(
  files: File[],
  position: Position,
  t: Translate,
  add: (data: CanvasNodeData, position: Position) => void,
): Promise<void> {
  let index = 0;
  for (const file of files) {
    const at = { x: position.x + index * 28, y: position.y + index * 28 };
    const isImage = file.type.startsWith("image/");
    if (isImage && file.size > MAX_IMAGE_BYTES) {
      console.warn(`[dnd] 跳过过大的图片：${file.name}（${file.size} 字节）`);
      continue;
    }
    if (isImage) {
      const src = await readAsDataUrl(file);
      if (!src) continue;
      add(
        {
          kind: "image",
          title: clampTitle(file.name),
          subtitle: t("dnd.subtitle.dropped", {
            format: formatOf(file.type),
            size: formatBytes(file.size),
          }),
          status: "idle",
          src,
          mimeType: file.type,
        },
        at,
      );
      index += 1;
      continue;
    }
    const readable =
      file.type.startsWith("text/") || file.size <= MAX_TEXT_BYTES;
    if (!readable) {
      console.warn(`[dnd] 无法读取的文件类型：${file.name}（${file.type}）`);
      continue;
    }
    const content = await file.text().catch(() => "");
    if (!content.trim()) {
      console.warn(`[dnd] 文件为空或无法解码：${file.name}`);
      continue;
    }
    add(
      {
        kind: "note",
        title: clampTitle(file.name),
        subtitle: t("dnd.subtitle.dropped", {
          format: formatOf(file.type || "text/plain"),
          size: formatBytes(file.size),
        }),
        status: "idle",
        content: content.slice(0, 20_000),
      },
      at,
    );
    index += 1;
  }
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => {
      console.warn(`[dnd] 读取失败：${file.name}`);
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}
