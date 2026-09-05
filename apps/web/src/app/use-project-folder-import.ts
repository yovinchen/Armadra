import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@armadra/shared";
import { toast } from "sonner";
import { runtimeApi } from "../api/client";
import { isTauri, onFileDrop, pickDirectory } from "../platform";
import {
  chooseBrowserFolder,
  droppedFolders,
  FolderReadError,
  type FolderSource,
} from "../platform/folder-import";
import { useT } from "./preferences-store";
import { workspaceRequest } from "./workspace-create";
import { useOpenWorkspace } from "./workspace-actions";

const MAX_FOLDERS = 16;

/** Works for both the desktop pane and the portalled mobile Sheet. */
export function isProjectDropPoint(point: { x: number; y: number }): boolean {
  const target = document.elementFromPoint(point.x, point.y);
  return (
    Boolean(target?.closest("[data-project-drop-zone]")) &&
    !target?.closest("input, textarea, [role='menu']")
  );
}

export function useProjectFolderImport() {
  const t = useT();
  const queryClient = useQueryClient();
  const openWorkspace = useOpenWorkspace();
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const report = useCallback(
    (error: unknown, name?: string) => {
      const message =
        error instanceof FolderReadError
          ? t(`folderImport.${error.reason}`)
          : (error as Error).message;
      toast.error(t("folderImport.failed", { name: name ?? "" }), {
        description: message,
      });
    },
    [t],
  );

  const run = useCallback(
    async (sources: (string | FolderSource)[]) => {
      if (working.current || !sources.length) return;
      if (sources.length > MAX_FOLDERS) {
        toast.error(t("folderImport.tooManyFolders"));
        return;
      }
      working.current = true;
      setBusy(true);
      try {
        for (const source of sources) {
          try {
            const copied = typeof source !== "string";
            const existing =
              queryClient.getQueryData<WorkspaceSummary[]>(["workspaces"]) ??
              [];
            const workspace =
              typeof source === "string"
                ? await runtimeApi.openDirectory(
                    workspaceRequest(source, existing, false),
                  )
                : await runtimeApi.importWorkspace(await source.read());
            openWorkspace(workspace);
            void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
            if (copied)
              toast.success(t("folderImport.copied", { name: workspace.name }));
          } catch (error) {
            report(
              error,
              typeof source === "string"
                ? source.split(/[\\/]/).pop()
                : source.name,
            );
          }
        }
      } finally {
        working.current = false;
        setBusy(false);
      }
    },
    [openWorkspace, queryClient, report, t],
  );

  useEffect(
    () =>
      onFileDrop((paths, point) => {
        if (isProjectDropPoint(point)) void run(paths);
      }),
    [run],
  );

  const choose = useCallback(async () => {
    if (working.current) return;
    try {
      if (isTauri()) {
        const path = await pickDirectory();
        if (path) await run([path]);
      } else await run(await chooseBrowserFolder());
    } catch (error) {
      report(error);
    }
  }, [report, run]);

  const resetDrag = () => {
    depth.current = 0;
    setDragging(false);
  };
  const events = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      resetDrag();
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, [role='menu']")
      )
        return;
      try {
        void run(droppedFolders(event.dataTransfer));
      } catch (error) {
        report(error);
      }
    },
  };
  return { busy, dragging, choose, events };
}
