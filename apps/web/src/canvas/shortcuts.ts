import { useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { pickDirectory } from "../platform";
import { useCreateBoard } from "../sidebar/BoardList";
import { setPendingWorkspacePath } from "../modals/new-workspace-state";
import { useAutoArrange } from "./auto-arrange";
import { FIT_VIEW_OPTIONS } from "./ZoomControls";

/** B3 listens for this to start the selected agent (plan §5 cross-ownership). */
export const RUN_AGENT_EVENT = "canvas:run-agent";

export interface RunAgentEventDetail {
  nodeId: string;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.isContentEditable ||
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}

/**
 * Global shortcuts (SPEC §11):
 *
 * | key | action |
 * | --- | --- |
 * | ⌘K | toggle the command palette |
 * | ⌘N | new workspace modal |
 * | ⌘O | folder picker, then the new workspace modal |
 * | ⌘⇧N | new board |
 * | ⏎ | focus the selected node |
 * | Esc | close modal → exit focus → clear selection |
 * | ⇧1 | fit view · ⇧0 zoom to 100% |
 * | ⌫ / Delete | handled by React Flow (with the confirm dialog) |
 * | ⌘⏎ | run the selected agent |
 * | ⌘⇧L | auto-arrange · ⌘⇧T toggle theme |
 *
 * Everything except ⌘K and Esc is ignored while an input has focus. The edge
 * picker owns Esc and 1–6 while it is open (see `EdgePicker`).
 */
export function useCanvasShortcuts(): void {
  const { setTheme, resolvedTheme } = usePreferences();
  const { fitView, zoomTo } = useReactFlow();
  const arrange = useAutoArrange();
  const createBoard = useCreateBoard();

  const latest = useRef({
    arrange,
    createBoard,
    fitView,
    resolvedTheme,
    setTheme,
    zoomTo,
  });
  latest.current = {
    arrange,
    createBoard,
    fitView,
    resolvedTheme,
    setTheme,
    zoomTo,
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const store = useCanvasStore.getState();
      const meta = event.metaKey || event.ctrlKey;
      const typing = isTyping(event.target);

      // ⌘K stays available while typing: it is the way out of a stray focus.
      if (meta && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        store.setModal(store.modal === "command" ? null : "command");
        return;
      }

      if (event.key === "Escape") {
        // Topmost surface first: a modal sits above the focused node, so Esc
        // must dismiss what the user is actually looking at.
        if (store.modal !== null) {
          event.preventDefault();
          store.setModal(null);
          return;
        }
        const focused = store.document?.nodes.find(
          (node) => node.zoom === "focus",
        );
        if (focused) {
          event.preventDefault();
          store.setNodeZoom(focused.id, "normal");
          return;
        }
        if (store.selectedNodeId) {
          event.preventDefault();
          store.selectNode(null);
        }
        return;
      }

      if (typing) return;

      if (meta && event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "n") {
          event.preventDefault();
          latest.current.createBoard.mutate();
          return;
        }
        if (key === "l") {
          event.preventDefault();
          latest.current.arrange();
          return;
        }
        if (key === "t") {
          event.preventDefault();
          latest.current.setTheme(
            latest.current.resolvedTheme === "dark" ? "light" : "dark",
          );
          return;
        }
      }

      if (meta && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "n") {
          event.preventDefault();
          // A plain ⌘N must never inherit a path left over from a ⌘O.
          setPendingWorkspacePath(null);
          store.setModal("newWorkspace");
          return;
        }
        if (key === "o") {
          event.preventDefault();
          // The picked folder is handed to B4's modal through the one-shot box.
          void pickDirectory()
            .then((picked) => setPendingWorkspacePath(picked))
            .catch(() => setPendingWorkspacePath(null))
            .finally(() => {
              useCanvasStore.getState().setModal("newWorkspace");
            });
          return;
        }
        if (event.key === "Enter") {
          const node = store.document?.nodes.find(
            (item) => item.id === store.selectedNodeId,
          );
          if (node?.type === "agent") {
            event.preventDefault();
            window.dispatchEvent(
              new CustomEvent<RunAgentEventDetail>(RUN_AGENT_EVENT, {
                detail: { nodeId: node.id },
              }),
            );
          }
          return;
        }
      }

      if (meta) return;

      if (event.key === "Enter" && store.selectedNodeId) {
        event.preventDefault();
        store.setNodeZoom(store.selectedNodeId, "focus");
        return;
      }

      if (event.shiftKey && event.code === "Digit1") {
        event.preventDefault();
        void latest.current.fitView(FIT_VIEW_OPTIONS);
        return;
      }

      if (event.shiftKey && event.code === "Digit0") {
        event.preventDefault();
        void latest.current.zoomTo(1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
