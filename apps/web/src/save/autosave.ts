import { useEffect } from "react";
import {
  MAX_WHITEBOARD_BYTES,
  type BoardDocument,
  type Viewport,
} from "@armadra/shared";
import { t } from "../app/preferences-store";
import { isConflict, isLeaseHeld, runtimeApi } from "../api/client";
import { serializeWhiteboard } from "../canvas/whiteboard/serialize";
import { useCanvasStore } from "../store/canvas-store";
import { clearLocalEdits, localEdits } from "../store/canvas/pending";
import { isReadOnly, presenceClientId } from "../store/canvas/presence";
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

/**
 * 保存被 423 拒了：租约在别的设备手里（core JSON §9）。`app/use-board-sync`
 * 听这个事件，立刻重新心跳拿在线表，并按远端重载这块画布。
 */
export const LEASE_LOST_EVENT = "armadra:canvas-lease-lost";
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
    remote = await runtimeApi.loadBoard(workspaceId, boardId);
  } catch (reason) {
    fail(reason);
    return;
  }
  const state = useCanvasStore.getState();
  // 拉的这段时间里用户已经切走了：那份文档不再是当前画布，丢掉即可。
  if (state.boardId !== boardId || !state.document) return;
  if (state.document.board.id !== boardId) return;
  useCanvasStore.setState({
    // 只把**这个窗口动过的**那几条重放上去；另一个窗口同时改的别的节点照收
    // 远端的（`store/canvas/pending.ts`）。
    document: replayLocalEdits(remote, state.document, localEdits()),
    saveState: "dirty",
    saveError: null,
  });
}

function boardQueue(): CanvasSaveQueue {
  if (queue) return queue;
  queue = new CanvasSaveQueue(
    (workspaceId, boardId, document) =>
      runtimeApi.saveBoard(workspaceId, boardId, document, presenceClientId()),
    (workspaceId, boardId, source, saved, reason) => {
      queue?.rebasePending(workspaceId, boardId, saved.board);
      conflictStreak.delete(`${workspaceId}:${boardId}`);
      const current = useCanvasStore.getState();
      if (current.boardId !== boardId || !current.document) return;
      if (current.document === source) {
        // 手里这份原封不动地落盘了：这一轮的「本地动过哪些」结清，下一次
        // 远端合并就该整份照收（`store/canvas/pending.ts`）。
        if (reason !== "viewport") clearLocalEdits();
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
      // 423 = 别的设备拿着编辑租约。不是故障，不亮红灯：本地这份作废，
      // 转成只读，由画布同步按远端重载。
      if (isLeaseHeld(cause)) {
        clearLocalEdits();
        useCanvasStore.setState({ saveState: "saved", saveError: null });
        window.dispatchEvent(new Event(LEASE_LOST_EVENT));
        return;
      }
      // 409 = 别的窗口先存了。自动变基重放，别急着亮红灯。
      if (isConflict(cause)) {
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
 * 保存那一刻才把白板文档序列化出来（React Flow 计划 F34），并**就地写回
 * store**：保存队列的成功回调按文档对象身份判断「保存途中有没有又改过」，
 * 换一个新对象再交出去会被永远判成「改过了」，于是保存永不收敛。
 *
 * 不在每次改动时算：一次拖拽会产生几十条 store 事件，每条都全量
 * `JSON.stringify` 整份白板太贵。超过上限返回 false，调用方置 `saveError`
 * 并放弃这一轮。
 */
function syncWhiteboard(): boolean {
  const state = useCanvasStore.getState();
  const document = state.document;
  if (!document) return true;
  const whiteboard = serializeWhiteboard(state.whiteboard);
  if (whiteboard.length > MAX_WHITEBOARD_BYTES) return false;
  if (whiteboard === document.board.whiteboard) return true;
  useCanvasStore.setState({
    document: { ...document, board: { ...document.board, whiteboard } },
  });
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
    // 只读时落下来的只可能是排版副产物（文字自适应高度之类），写出去也会被
    // 423 拒；丢掉，远端那份才是真的。
    if (isReadOnly(state)) {
      clearLocalEdits();
      useCanvasStore.setState({ saveState: "saved" });
      return;
    }
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
    // 视口也存在画布文档里：只读的一方平移只是自己看，不写。
    if (isReadOnly(state)) return;
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
