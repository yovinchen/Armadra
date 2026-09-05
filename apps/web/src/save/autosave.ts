import { useEffect } from "react";
import {
  MAX_WHITEBOARD_BYTES,
  type BoardDocument,
  type Viewport,
} from "@armadra/shared";
import { t } from "../app/preferences-store";
import {
  canEditCanvas,
  canvasGateway,
  isCanvasConflict,
  useCanvasOwnership,
  CanvasOwnershipMovedError,
  CanvasReadOnlyError,
} from "../canvas-ownership";
import { getEditor } from "../canvas/editor-context";
import { markPushed } from "../canvas/sync/pushed";
import { captureWhiteboard } from "../canvas/sync/use-store-sync";
import { useCanvasStore } from "../store/canvas-store";
import {
  CanvasSaveQueue,
  MAX_CONFLICT_REPLAYS,
  replayLocalEdits,
} from "./canvas-save-queue";

/**
 * 自动保存 —— 把 store 的变化接到保存队列上。
 *
 * 两条通道，节奏不同：
 *  - **编辑**：`saveState === "dirty"` 起 600ms 防抖，落地后指示灯变「已保存」。
 *  - **视口**：平移/缩放不置 dirty（§3.2），单独 2s 节流静默 PUT；
 *    有编辑在排队时直接跳过——那次编辑保存本来就带着最新视口。
 *
 * 画布挂 `useBoardAutosave()`；壳在切画布/关窗口前调 `flushBoardSaves()`。
 */

export const EDIT_DEBOUNCE_MS = 600;
export const VIEWPORT_THROTTLE_MS = 2_000;

let queue: CanvasSaveQueue | null = null;

/** 每块画布连续吃到几次 409 了；存一次就清零。 */
const conflictStreak = new Map<string, number>();

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 保存冲突（409）：拉最新文档 → 把本地改动重放上去 → 重新保存。
 *
 * 两个窗口同开一块板时，谁先存谁赢，后一个的 CAS 一定失败。以前这里直接
 * 亮红灯，用户除了「重试」（还会再撞一次）没别的办法。现在自动变基：
 *
 *  1. `GET .../document` 取最新的一份；
 *  2. `replayLocalEdits` 把本地未落库的改动重放上去（节点位置 / 尺寸 /
 *     数据以本地为准，远端新增的节点保留，远端删除的节点不复活）；
 *  3. 写回 store —— `sync/use-store-sync` 会用 `mergeRemoteChanges` 把它灌进
 *     editor（**不进撤销栈**，用户的 ⌘Z 不该把别的窗口的节点撤掉），
 *     `saveState: "dirty"` 让下一轮防抖重新 PUT。
 *
 * 连续 `MAX_CONFLICT_REPLAYS` 次都撞上才亮红灯：那已经不是「撞了一下」，
 * 而是两边在同一块板上持续对写，得让用户知道。
 */
async function resolveConflict(
  workspaceId: string,
  boardId: string,
  cause: unknown,
): Promise<void> {
  const key = `${workspaceId}:${boardId}`;
  const streak = (conflictStreak.get(key) ?? 0) + 1;
  conflictStreak.set(key, streak);
  const fail = (reason: unknown) => {
    if (useCanvasStore.getState().boardId !== boardId) return;
    useCanvasStore.setState({
      saveState: "error",
      saveError: messageOf(reason),
    });
  };
  if (streak >= MAX_CONFLICT_REPLAYS) {
    fail(cause);
    return;
  }
  let remote: BoardDocument;
  try {
    remote = await canvasGateway.loadBoard(workspaceId, boardId);
  } catch (reason) {
    fail(reason);
    return;
  }
  const state = useCanvasStore.getState();
  // 拉的这段时间里用户已经切走了：那份文档不再是当前画布，丢掉即可。
  if (state.boardId !== boardId || !state.document) return;
  if (state.document.board.id !== boardId) return;
  useCanvasStore.setState({
    document: replayLocalEdits(remote, state.document),
    saveState: "dirty",
    saveError: null,
  });
}

function boardQueue(): CanvasSaveQueue {
  if (queue) return queue;
  queue = new CanvasSaveQueue(
    (workspaceId, boardId, document) =>
      canvasGateway.saveBoard(workspaceId, boardId, document),
    (workspaceId, boardId, source, saved, reason) => {
      queue?.rebasePending(workspaceId, boardId, saved.board);
      conflictStreak.delete(`${workspaceId}:${boardId}`);
      const current = useCanvasStore.getState();
      if (current.boardId !== boardId || !current.document) return;
      if (current.document === source) {
        useCanvasStore.setState({
          document: saved,
          saveState: reason === "viewport" ? current.saveState : "saved",
          saveError: null,
        });
        return;
      }
      // 保存飞行途中用户又改了：只采纳新的 CAS 时间戳，本地内容留着，
      // 保存态维持 dirty，下一轮防抖会把它带走。
      useCanvasStore.setState({
        document: { ...current.document, board: saved.board },
        saveState: reason === "viewport" ? current.saveState : "dirty",
        saveError: null,
      });
    },
    (workspaceId, boardId, cause) => {
      if (useCanvasStore.getState().boardId !== boardId) return;
      /**
       * 归属变了：这一次写不能重试，也不算失败。网关已经重新探过归属，
       * 文档留在 dirty，下一轮防抖要么走新的写方，要么因为还在维护窗口
       * 里而继续按兵不动。亮红灯会把「换了个写方」说成「改动丢了」。
       */
      if (
        cause instanceof CanvasOwnershipMovedError ||
        cause instanceof CanvasReadOnlyError
      ) {
        useCanvasStore.setState({ saveState: "dirty", saveError: null });
        return;
      }
      // 409 = 别的窗口先存了。自动变基重放，别急着亮红灯。
      if (isCanvasConflict(cause)) {
        void resolveConflict(workspaceId, boardId, cause);
        return;
      }
      useCanvasStore.setState({
        saveState: "error",
        saveError: messageOf(cause),
      });
    },
  );
  return queue;
}

/** 壳在切画布 / 关窗口前调用；等所有排队的 PUT 落地。 */
export function flushBoardSaves(): Promise<void> {
  return queue ? queue.flush() : Promise.resolve();
}

/** 仅测试用：丢掉队列单例。 */
export function resetAutosaveQueue() {
  queue = null;
  conflictStreak.clear();
}

interface Target {
  workspaceId: string;
  boardId: string;
  document: BoardDocument;
}

function target(): Target | null {
  const state = useCanvasStore.getState();
  if (!state.workspace || !state.boardId || !state.document) return null;
  return {
    workspaceId: state.workspace.id,
    boardId: state.boardId,
    document: state.document,
  };
}

/**
 * 保存那一刻才把白板快照序列化出来（tldraw 计划 §6.1），并**就地写回
 * store**：保存队列的成功回调按文档对象身份判断「保存途中有没有又改过」，
 * 换一个新对象再交出去会被永远判成「改过了」，于是保存永不收敛。
 *
 * 不在每次改动时算：一次拖拽会产生几十条 store 事件，每条都全量
 * `JSON.stringify` 整个 store 太贵。画布没挂载时沿用文档里已有的那份。
 * 超过上限返回 false，调用方置 `saveError` 并放弃这一轮。
 */
function syncWhiteboard(): boolean {
  const state = useCanvasStore.getState();
  const document = state.document;
  if (!document) return true;
  const whiteboard = captureWhiteboard(getEditor());
  if (whiteboard === null) return true;
  if (whiteboard.length > MAX_WHITEBOARD_BYTES) return false;
  if (whiteboard === document.board.whiteboard) return true;
  const next = { ...document, board: { ...document.board, whiteboard } };
  // 只换了 board 上的一个字符串，节点与连线一个没动：登记一下，
  // 免得 `use-store-sync` 把这当成外来文档再整块投影一遍。
  markPushed(next);
  useCanvasStore.setState({ document: next });
  return true;
}

/**
 * 装上订阅与两个定时器，返回卸载函数。非 React 环境（测试）也能直接用。
 */
export function startAutosave(): () => void {
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let viewportTimer: ReturnType<typeof setTimeout> | null = null;
  let lastViewport = useCanvasStore.getState().document?.board.viewport;
  /** 已经落过盘的视口；编辑保存也会带上它，所以两条通道共用这一格。 */
  let sentViewport = lastViewport;
  let lastBoardId = useCanvasStore.getState().boardId;

  const sameViewport = (a?: Viewport, b?: Viewport) =>
    Boolean(a && b && a.x === b.x && a.y === b.y && a.zoom === b.zoom);

  const clearTimers = () => {
    if (editTimer) clearTimeout(editTimer);
    if (viewportTimer) clearTimeout(viewportTimer);
    editTimer = null;
    viewportTimer = null;
  };

  const flushEdit = () => {
    editTimer = null;
    const state = useCanvasStore.getState();
    if (state.saveState !== "dirty") return;
    /**
     * 归属没落定就不写：维护窗口里两侧都拒写，`unknown` / `error` 则是
     * 「不知道该写给谁」。保存态留在 dirty——这份改动确实还没落盘，
     * 说成「已保存」是撒谎。
     */
    if (!canEditCanvas(useCanvasOwnership.getState().status)) return;
    if (!syncWhiteboard()) {
      useCanvasStore.setState({
        saveState: "error",
        saveError: t("canvas.whiteboardTooLarge"),
      });
      return;
    }
    const next = target();
    if (!next) return;
    sentViewport = next.document.board.viewport;
    useCanvasStore.setState({ saveState: "saving" });
    void boardQueue()
      .enqueue(next.workspaceId, next.boardId, next.document)
      .catch(() => undefined);
  };

  const flushViewport = () => {
    viewportTimer = null;
    const state = useCanvasStore.getState();
    // 有编辑在路上就不必单独存视口了，那次 PUT 会带上它。
    if (state.saveState !== "saved" && state.saveState !== "idle") return;
    if (!canEditCanvas(useCanvasOwnership.getState().status)) return;
    const next = target();
    if (!next) return;
    // 刚刚那次编辑保存已经把这个视口带走了，不必再 PUT 一遍。
    if (sameViewport(next.document.board.viewport, sentViewport)) return;
    sentViewport = next.document.board.viewport;
    void boardQueue()
      .saveViewport(next.workspaceId, next.boardId, next.document)
      .catch(() => undefined);
  };

  const unsubscribe = useCanvasStore.subscribe((state) => {
    if (state.boardId !== lastBoardId) {
      lastBoardId = state.boardId;
      lastViewport = state.document?.board.viewport;
      sentViewport = lastViewport;
      clearTimers();
      return;
    }

    if (state.saveState === "dirty") {
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(flushEdit, EDIT_DEBOUNCE_MS);
    }

    const viewport = state.document?.board.viewport;
    if (viewport && viewport !== lastViewport) {
      lastViewport = viewport;
      // 节流而不是防抖：连续平移时每 2 秒落一次，松手后不再多等。
      if (!viewportTimer) {
        viewportTimer = setTimeout(flushViewport, VIEWPORT_THROTTLE_MS);
      }
    }
  });

  return () => {
    clearTimers();
    unsubscribe();
  };
}

/** 画布挂一次。 */
export function useBoardAutosave(): void {
  useEffect(() => startAutosave(), []);
}
