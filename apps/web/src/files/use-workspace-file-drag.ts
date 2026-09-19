import {
  useEffect,
  useRef,
  type DragEvent,
  type PointerEvent,
  type MouseEvent,
} from "react";
import type { FileEntry } from "@armadra/shared";
import { toast } from "sonner";
import { RUNTIME_URL } from "../api/client";
import { t } from "../app/preferences-store";
import { isDesktop } from "../platform";
import { useCanvasStore } from "../store/canvas-store";
import { getFlow } from "../canvas/flow/flow-context";
import {
  createWorkspaceFileDrag,
  fileDragMessage,
  writeWorkspaceFileDrag,
  WORKSPACE_FILE_DROP_EVENT,
  type WorkspaceFileDropDetail,
} from "./workspace-drag";

export function needsPointerFileDrag(): boolean {
  return isDesktop() && /Win/i.test(navigator.platform || navigator.userAgent);
}

/** Windows Tauri's native OS drop handler disables HTML5 DND. Internal files
 * use pointer events there, without changing native Finder/Explorer importing. */
export function useWorkspaceFileDrag(
  workspaceId: string | undefined,
  pointerFallback = needsPointerFileDrag(),
) {
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);
  const boardId = useCanvasStore((state) => state.document?.board?.id ?? null);
  useEffect(() => () => cleanup.current?.(), [workspaceId, boardId]);

  return (entry: FileEntry) => ({
    draggable: !pointerFallback,
    "aria-description": t("fileDrag.hint"),
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (performance.now() < suppressClickUntil.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      if (!workspaceId || pointerFallback) {
        event.preventDefault();
        return;
      }
      try {
        writeWorkspaceFileDrag(event.dataTransfer, RUNTIME_URL, workspaceId, [
          entry,
        ]);
      } catch (error) {
        event.preventDefault();
        toast.error(t(fileDragMessage(error)));
      }
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (
        !pointerFallback ||
        !workspaceId ||
        event.button !== 0 ||
        event.pointerType === "touch" ||
        event.isPrimary === false
      )
        return;
      cleanup.current?.();
      let drag;
      try {
        drag = createWorkspaceFileDrag(RUNTIME_URL, workspaceId, [entry]);
      } catch (error) {
        toast.error(t(fileDragMessage(error)));
        return;
      }
      event.stopPropagation();
      const origin = { x: event.clientX, y: event.clientY };
      const pointerId = event.pointerId;
      const source = event.currentTarget;
      const flow = getFlow();
      let active = false;
      let ghost: HTMLDivElement | null = null;
      const dispose = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("keydown", escape, true);
        window.removeEventListener("blur", cancel);
        window.removeEventListener("pointerout", leave, true);
        source.removeEventListener("lostpointercapture", cancel);
        try {
          if (source.hasPointerCapture?.(pointerId))
            source.releasePointerCapture(pointerId);
        } catch {
          /* Already detached. */
        }
        ghost?.remove();
        if (cleanup.current === cancel) cleanup.current = null;
      };
      const cancel = () => {
        if (active) suppressClickUntil.current = performance.now() + 250;
        dispose();
      };
      const escape = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          cancel();
        }
      };
      const leave = (event: globalThis.PointerEvent) => {
        if (
          event.pointerId === pointerId &&
          event.relatedTarget === null &&
          !source.hasPointerCapture?.(pointerId)
        )
          cancel();
      };
      const move = (event: globalThis.PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        if (
          useCanvasStore.getState().document?.board?.id !==
            (boardId ?? undefined) ||
          getFlow() !== flow
        ) {
          cancel();
          return;
        }
        if (
          !active &&
          Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 6
        )
          return;
        active = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!ghost) {
          ghost = document.createElement("div");
          ghost.dataset.fileDragPreview = "true";
          ghost.setAttribute("aria-hidden", "true");
          ghost.className =
            "pointer-events-none fixed z-[9999] max-w-60 truncate rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-lg";
          ghost.textContent = entry.name;
          document.body.append(ghost);
        }
        ghost.style.left = `${Math.max(4, Math.min(event.clientX + 12, innerWidth - ghost.offsetWidth - 4))}px`;
        ghost.style.top = `${Math.max(4, Math.min(event.clientY + 12, innerHeight - ghost.offsetHeight - 4))}px`;
      };
      const finish = (event: globalThis.PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        if (
          useCanvasStore.getState().document?.board?.id !==
            (boardId ?? undefined) ||
          getFlow() !== flow
        ) {
          cancel();
          return;
        }
        if (active) {
          event.preventDefault();
          event.stopImmediatePropagation();
          suppressClickUntil.current = performance.now() + 250;
          const point = { x: event.clientX, y: event.clientY };
          document
            .elementFromPoint(point.x, point.y)
            ?.dispatchEvent(
              new CustomEvent<WorkspaceFileDropDetail>(
                WORKSPACE_FILE_DROP_EVENT,
                { bubbles: true, cancelable: true, detail: { drag, point } },
              ),
            );
        }
        dispose();
      };
      cleanup.current = cancel;
      source.addEventListener("lostpointercapture", cancel);
      try {
        source.setPointerCapture?.(pointerId);
      } catch {
        /* pointerout/blur cancel when capture is unavailable. */
      }
      window.addEventListener("pointermove", move, {
        capture: true,
        passive: false,
      });
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("keydown", escape, true);
      window.addEventListener("blur", cancel);
      window.addEventListener("pointerout", leave, true);
    },
  });
}
