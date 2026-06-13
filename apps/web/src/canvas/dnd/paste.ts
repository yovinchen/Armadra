/**
 * Paste-to-canvas (plan §1.4 / SPEC §5): an image on the clipboard becomes an
 * Image node, text becomes a Note whose title is the first line. Both land in
 * the centre of the current viewport.
 */
import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import type { CanvasNodeData, Position } from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../../store/canvas-store";
import { usePreferences } from "../../preferences/Preferences";
import {
  clampTitle,
  formatOf,
  noteDataFromText,
  type Translate,
} from "./payload";

/** Mirrors `MAX_IMAGE_SRC_BYTES` in the domain schema. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function usePasteToCanvas(): void {
  const flow = useReactFlow();
  const { t } = usePreferences();
  const addNode = useCanvasStore((state) => state.addNode);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTextEntry(event.target)) return;
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      if (!useCanvasStore.getState().document) return;

      const image = Array.from(clipboard.items ?? []).find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      const file = image?.getAsFile() ?? null;
      if (file) {
        event.preventDefault();
        void pasteImage(file, viewportCentre(flow), t, (data, position) => {
          addNode(data, position);
        });
        return;
      }

      const text = clipboard.getData("text/plain");
      if (!text.trim()) return;
      event.preventDefault();
      addNode(
        noteDataFromText(text, t("dnd.subtitle.pasted")),
        viewportCentre(flow),
      );
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addNode, flow, t]);
}

/** Typing in a field (or inside a `.nodrag` region) must paste normally. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest(".nodrag, [contenteditable='true']"));
}

async function pasteImage(
  file: File,
  position: Position | undefined,
  t: Translate,
  add: (data: CanvasNodeData, position: Position | undefined) => void,
): Promise<void> {
  if (file.size > MAX_IMAGE_BYTES) {
    console.warn(`[paste] 剪贴板图片超过 2 MiB（${file.size} 字节），已忽略。`);
    return;
  }
  const src = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  if (!src) {
    console.warn("[paste] 无法读取剪贴板图片。");
    return;
  }
  add(
    {
      kind: "image",
      title: clampTitle(t("dnd.pastedImage")),
      subtitle: t("dnd.subtitle.clipboard", {
        format: formatOf(file.type || "image/png"),
      }),
      status: "idle",
      src,
      mimeType: file.type || "image/png",
    },
    position,
  );
}

/** Centre of the canvas stage, in world coordinates. */
export function viewportCentre(
  flow: ReturnType<typeof useReactFlow>,
): Position | undefined {
  const stage =
    document.querySelector<HTMLElement>(".canvas-stage") ??
    document.querySelector<HTMLElement>(".react-flow__pane");
  if (!stage) return undefined;
  const rect = stage.getBoundingClientRect();
  return flow.screenToFlowPosition({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
}
