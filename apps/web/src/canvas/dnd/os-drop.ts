import { useCallback, useEffect, type DragEvent } from "react";

import { onFileDrop } from "../../platform";
import { useCanvasStore } from "../../store/canvas-store";
import { screenToPage } from "../flow/flow-context";
import {
  addBrowserFiles,
  addNodesForPaths,
  addWorkspaceEntriesToCanvas,
  captureImportTarget,
} from "./external-content";
import { pastePoint } from "../interaction/pointer";
import { localClipboardText, paste } from "../whiteboard/tools/use-clipboard";
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
import { t, usePreferencesStore } from "../../app/preferences-store";

/**
 * 拖放与粘贴的入口（React Flow 计划 F27）。
 *
 * 规则本身住在 `external-content.ts`。React Flow 不接管 drop / paste，
 * 所以这个文件是**唯一入口**（旧引擎里它只是补两块盲区）：
 *
 * | 场景 | 处理 |
 * | --- | --- |
 * | 桌面版 OS 拖放（壳给真实路径） | 图片 → Runtime 按路径导入资产后建白板图片，目录 → `files` 节点，其余 → `editor` 节点 |
 * | 浏览器拖放（`DataTransfer`） | 同一张规则表 |
 * | 工作区文件树拖入 | `addWorkspaceEntriesToCanvas` |
 * | 焦点在输入框 / 终端里的粘贴 | 拦下来，交给它们自己 |
 *
 * 粘贴只有一条入口：浏览器原生的 `paste` 事件。⌘V 在 `keybindings.ts` 里
 * 登记为 `native`（命中即放行，不 `preventDefault`），所以 ⌘V、右键菜单的
 * 「粘贴」、IME 的粘贴走的是同一个事件。这条路是**必须**的——异步剪贴板
 * API 读不到 Finder 复制的文件，打包壳的 WebView 上连 `read()` 都可能没有，
 * 只有 `ClipboardEvent.clipboardData` 同时给得出文本、图片和文件
 * （2026-09-06 用户反馈：从别处复制的内容粘不进画布）。
 */

/* --------------------------------- 拖放 ----------------------------------- */

export interface OsDropHandlers {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function useOsDrop(): OsDropHandlers {
  // 桌面版：壳把落点上的 `File` 换成绝对路径交过来。
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

  // The Windows pointer fallback dispatches this after hit-testing. A
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

  /** 画布上所有的浏览器拖放都进这里：React Flow 不接管 drop。 */
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
    const target = captureImportTarget();
    if (!target) return;
    const point = screenToPage({ x: event.clientX, y: event.clientY });
    void addBrowserFiles(files, point, target);
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
 * 原生 `paste` 事件的落地。
 *
 * 守卫先行：输入框、终端、可编辑区里的粘贴必须原样交给它们，所以在
 * `document.body` 的冒泡相位提前 `stopPropagation`——目标元素这时已经
 * 收到事件，`document` 上的监听器再也看不到它。
 *
 * 落地规则与拖放同一张表（`whiteboard/tools/use-clipboard.paste`）：
 * `armadra/canvas@1` 的 JSON 原样复原，文件交给 `addBrowserFiles`
 * （图片 → `wb.image`，其余 → 导入进工作区的 `editor` 节点），剩下的纯文本
 * → `wb.text`；落点按 `pasteAtCursor` 偏好。
 */
export function usePasteToCanvas(): void {
  useEffect(() => {
    const guard = (event: ClipboardEvent) => {
      if (isTextEntry(event.target)) event.stopPropagation();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isTextEntry(event.target) || isTerminalDropTarget(event.target))
        return;
      const state = useCanvasStore.getState();
      if (!state.document || !state.workspace) return;
      if (isCanvasLocked()) return;
      const transfer = event.clipboardData;
      // 图片之外的文件也收：Finder 复制来的文件走的是拖放那条导入路径
      // （`external-content.addBrowserFiles` 自己按同一张表分流）。
      const files = Array.from(transfer?.files ?? []);
      let text = transfer?.getData("text/plain") ?? null;
      // 载荷是空的时候退回应用内那一份：系统剪贴板写不进去也不该让应用内的
      // 复制粘贴失效（`use-clipboard.localClipboardText`）。
      if (files.length === 0 && !text?.trim()) text = localClipboardText();
      if (files.length === 0 && !text?.trim()) return;
      event.preventDefault();
      void paste(
        {
          workspaceId: state.workspace.id,
          at: pastePoint(
            usePreferencesStore.getState().whiteboard.pasteAtCursor,
          ),
        },
        { text, files },
      );
    };
    document.body.addEventListener("paste", guard);
    document.addEventListener("paste", onPaste);
    return () => {
      document.body.removeEventListener("paste", guard);
      document.removeEventListener("paste", onPaste);
    };
  }, []);
}
