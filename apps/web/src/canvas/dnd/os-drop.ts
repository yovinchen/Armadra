import { useCallback, useEffect, type DragEvent } from "react";

import { onFileDrop } from "../../platform";
import { useCanvasStore } from "../../store/canvas-store";
import { getEditor, screenToPage } from "../editor-context";
import {
  addBrowserFiles,
  addNodesForPaths,
  addWorkspaceEntriesToCanvas,
  captureImportTarget,
} from "./external-content";
import { RUNTIME_URL } from "../../api/client";
import { isCanvasLocked } from "../canvas-lock";
import {
  assertDragScope,
  hasWorkspaceFileDrag,
  readWorkspaceFileDrag,
  fileDragMessage,
  WORKSPACE_FILE_DROP_EVENT,
  type WorkspaceFileDropDetail,
} from "../../files/workspace-drag";
import { toast } from "sonner";
import { t } from "../../app/preferences-store";

/**
 * 拖放与粘贴的入口（tldraw 计划 §8 Phase 3 / content）。
 *
 * 规则本身住在 `external-content.ts`，因为 tldraw 自己就监听画布的 `drop`
 * 和文档的 `paste`，两条路最后都进 `editor.putExternalContent`。这个文件
 * 只补 tldraw 覆盖不到的两块：
 *
 * | 场景 | 处理 |
 * | --- | --- |
 * | 桌面版 OS 拖放（Tauri 给真实路径，webview 收不到 `DataTransfer`） | 图片 → Runtime 按路径导入资产后建 image shape，目录 → `files` 节点，其余 → `editor` 节点 |
 * | 掉在 tldraw 容器外面的浏览器拖放 | 原样转交 `putExternalContent` |
 * | 焦点在输入框 / 终端里的粘贴 | 拦下来，别让 tldraw 变成 text shape |
 */

/* --------------------------------- 拖放 ----------------------------------- */

export interface OsDropHandlers {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function useOsDrop(): OsDropHandlers {
  // 桌面版：Tauri 的 `onDragDropEvent` 吃掉了 webview 的拖放，只给路径。
  useEffect(
    () =>
      onFileDrop((paths, point) => {
        if (!useCanvasStore.getState().document) return;
        if (isTerminalDropTarget(document.elementFromPoint(point.x, point.y))) {
          toast.error(t("fileDrag.externalPathUnavailable"));
          return;
        }
        if (!isCanvasDropPoint(point)) return;
        void addNodesForPaths(paths, screenToPage(point));
      }),
    [],
  );

  // Windows Tauri's pointer fallback dispatches this after hit-testing. A
  // terminal consumes it first; only an unconsumed canvas destination arrives.
  useEffect(() => {
    const dropped = (event: Event) => {
      if (!(event instanceof CustomEvent) || isTerminalDropTarget(event.target))
        return;
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".canvas-stage") ||
        isTextEntry(event.target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const detail = event.detail as WorkspaceFileDropDetail;
      if (
        !detail?.point ||
        !Number.isFinite(detail.point.x) ||
        !Number.isFinite(detail.point.y)
      )
        return;
      importWorkspaceDrop(
        { getData: () => JSON.stringify(detail.drag) },
        detail.point,
      );
    };
    document.addEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
    return () =>
      document.removeEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
  }, []);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (isTerminalDropTarget(event.target)) return;
    if (
      !hasWorkspaceFileDrag(event.dataTransfer) &&
      !Array.from(event.dataTransfer.types ?? []).includes("Files")
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  /**
   * 兜底：tldraw 的画布自己会处理落在它身上的拖放（并且 `stopPropagation`），
   * 所以这里只会收到落在画布容器**外面**的那些。
   */
  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (isTerminalDropTarget(event.target)) return;
    if (hasWorkspaceFileDrag(event.dataTransfer)) {
      event.preventDefault();
      event.stopPropagation();
      if (isTextEntry(event.target)) return;
      importWorkspaceDrop(event.dataTransfer, {
        x: event.clientX,
        y: event.clientY,
      });
      return;
    }
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    if (isTextEntry(event.target)) return;
    if (
      Array.from(event.dataTransfer.items ?? []).some(
        (item) => item.webkitGetAsEntry?.()?.isDirectory,
      )
    ) {
      toast.error(t("canvas.importFolderUnsupported"));
      return;
    }
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    const editor = getEditor();
    const target = captureImportTarget();
    if (!editor || !target) return;
    const point = screenToPage({ x: event.clientX, y: event.clientY });
    editor.markHistoryStoppingPoint("drop");
    void addBrowserFiles(editor, files, point, target);
  }, []);

  return { onDragOver, onDrop };
}

function importWorkspaceDrop(
  transfer: Pick<DataTransfer, "getData">,
  point: { x: number; y: number },
) {
  try {
    const drag = readWorkspaceFileDrag(transfer);
    const target = captureImportTarget();
    if (!target) return;
    assertDragScope(drag, RUNTIME_URL, target.workspaceId);
    if (isCanvasLocked()) {
      toast.error(t("fileDrag.canvasLocked"));
      return;
    }
    void addWorkspaceEntriesToCanvas(
      drag.entries,
      screenToPage(point),
      target,
    ).catch((error: unknown) => toast.error(t(fileDragMessage(error))));
  } catch (error) {
    toast.error(t(fileDragMessage(error)));
  }
}

export function isTerminalDropTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("[data-slot='terminal-body'], .xterm"))
  );
}

/** OS events are window-wide. Sidebar/dialog drops do not belong to a board. */
export function isCanvasDropPoint(point: { x: number; y: number }): boolean {
  const target = document.elementFromPoint(point.x, point.y);
  return (
    Boolean(target?.closest(".canvas-stage")) &&
    !target?.closest(
      "[role='dialog'], [role='menu'], input, textarea, .xterm, [data-slot='terminal-body']",
    )
  );
}

/* --------------------------------- 粘贴 ----------------------------------- */

/** 正在输入框 / 终端里打字时，粘贴必须原样交给它们。 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest(".nodrag, .xterm, [contenteditable='true']"));
}

/**
 * 粘贴：图片 → image shape，文本 → text shape，落点是视口中心。
 *
 * 这两条 tldraw 已经替我们做了（`useNativeClipboardEvents` → `putExternalContent`
 * → `external-content.ts` 的处理器），这里只剩一件事：**别让它抢走输入框的粘贴**。
 * tldraw 的监听器挂在 `document` 上且不认输入框，所以在 `document.body` 的冒泡
 * 相位提前 `stopPropagation`——目标元素这时已经收到事件，document 上的那个
 * 再也看不到它。
 */
export function usePasteToCanvas(): void {
  useEffect(() => {
    const guard = (event: ClipboardEvent) => {
      if (isTextEntry(event.target)) event.stopPropagation();
    };
    document.body.addEventListener("paste", guard);
    return () => document.body.removeEventListener("paste", guard);
  }, []);
}
