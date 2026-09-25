import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BoardDocument } from "@armadra/shared";
import { runtimeApi } from "../api/client";
import { onWorkspaceEvent } from "../api/events";
import { useDraftsActive } from "../canvas/flow/drafts";
import { LEASE_LOST_EVENT, flushBoardSaves } from "../save/autosave";
import { SAVE_RETRY_EVENT } from "../shell/Banners";
import { useCanvasStore } from "../store/canvas-store";
import {
  applyPresence,
  markPresenceActivity,
  presenceClientId,
  presenceDeviceName,
  takePresenceActivity,
} from "../store/canvas/presence";
import {
  lastBoardId,
  lastWorkspaceId,
  rememberBoard,
  rememberWorkspace,
  usePreferencesStore,
} from "./preferences-store";
import { useWorkspacesQuery } from "./workspaces-query";

/**
 * 加载链：工作空间 → 画布列表 → 画布文档，外加“记住上次打开的东西”。
 *
 * 保存不在这里：`save/autosave.ts`（归属 canvas）订阅 store 自己做防抖，
 * 壳只负责在切板/关窗前 `flushBoardSaves()`，以及把通知条上的“重试”
 * 翻译成一次重新置脏。
 */
export function useBoardSync() {
  /**
   * 上次打开的 id，在**任何 effect 跑之前**先抓进 ref。
   *
   * 这是「刷新后回到启动页」那个 bug 的根：挂载时 store 里还没有工作空间，
   * 「记住当前工作空间」的 effect 先跑一步，把 `armadra.workspace` 抹成空；
   * 等工作空间列表请求回来，恢复用的 effect 已经读不到 id 了。
   * 渲染期取值天然早于所有 effect，顺序问题就没了。
   */
  const bootWorkspaceRef = useRef<string | null>(null);
  const bootBoardRef = useRef<string | null>(null);
  const bootReadRef = useRef(false);
  if (!bootReadRef.current) {
    bootReadRef.current = true;
    // 「打开时恢复上次工作空间」关掉后只是不**读**这两个值；仍然照常写回，
    // 这样重新打开开关时上次的位置还在（§24.1 通用页）。
    const restore = usePreferencesStore.getState().restoreLastWorkspace;
    // URL 参数优先（`?workspace=<id>&board=<id>`）：深链、多窗口与排查问题时
    // 不必先改 localStorage 才能落到指定画布。
    const params = new URLSearchParams(window.location.search);
    bootWorkspaceRef.current =
      params.get("workspace") ?? (restore ? lastWorkspaceId() : null);
    bootBoardRef.current =
      params.get("board") ?? (restore ? lastBoardId() : null);
  }

  const workspace = useCanvasStore((state) => state.workspace);
  const boardId = useCanvasStore((state) => state.boardId);
  /**
   * **只订阅板 id，不订阅整份 `document`。**
   *
   * 这个 hook 住在 `AppShell` 里，而 `document` 的对象身份在每一次
   * `updateNodeData`、甚至每一次平移（`setViewport` 也换 document）时都会变。
   * 订阅整份的代价是整个应用壳跟着重渲：实测一次会话状态跳动里，`AppShell`
   * 为根的重渲有四次、每次约 1,045 个组件（`docs/status/canvas-performance-baseline.md`）。
   * 下面那个合并 effect 真正要的只有「手里这份是不是同一块板」，剩下的用
   * `getState()` 当场读，避免订阅无关变化。
   */
  const documentBoardId = useCanvasStore((state) => state.document?.board.id);
  const saveState = useCanvasStore((state) => state.saveState);
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const setBoards = useCanvasStore((state) => state.setBoards);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const setDocument = useCanvasStore((state) => state.setDocument);
  const mergeRemoteDocument = useCanvasStore(
    (state) => state.mergeRemoteDocument,
  );
  // 手势进行中不合远端改动（见下面的「文档载入」）。
  const dragging = useDraftsActive();
  const openWorkspaceTab = usePreferencesStore(
    (state) => state.openWorkspaceTab,
  );

  const workspaces = useWorkspacesQuery();

  const boards = useQuery({
    queryKey: ["boards", workspace?.id],
    queryFn: () => runtimeApi.listBoards(workspace!.id),
    enabled: Boolean(workspace),
  });

  const board = useQuery({
    queryKey: ["board", workspace?.id, boardId],
    queryFn: () => runtimeApi.loadBoard(workspace!.id, boardId!),
    enabled: Boolean(workspace && boardId),
  });

  /**
   * 别处改过这块板时**只让文档查询失效**，不直接改 store：本地还没落盘的
   * 编辑不该被一次重取盖掉，合并仍然走保存冲突那条路。
   */
  const queryClient = useQueryClient();
  const workspaceId = workspace?.id ?? null;
  const onCanvasChanged = useCallback(() => {
    if (!workspaceId) return;
    void queryClient.invalidateQueries({ queryKey: ["board", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["boards", workspaceId] });
  }, [queryClient, workspaceId]);

  /**
   * `board.changed`（A04）。
   *
   * `board.changed` 带着保存之后的 `updatedAt`，那就是这块板的版本号：和
   * 手里这份一样就是**自己刚存的那一次**，重取回来只会得到同一份，什么都
   * 不做；不一样才是别人改的，让文档查询失效去取。没有这一层判断的话，
   * 每一次自己的自动保存都会顺手拉一次整份文档回来。
   */
  useEffect(() => {
    if (!workspaceId) return;
    return onWorkspaceEvent("board.changed", (event) => {
      const current = useCanvasStore.getState().document;
      if (!current || current.board.id !== event.boardId) return;
      if (current.board.updatedAt === event.updatedAt) return;
      onCanvasChanged();
    });
  }, [onCanvasChanged, workspaceId]);

  /**
   * 丢了租约：按远端重载，而且**不靠文档查询的引用变没变**。远端这段时间
   * 没人改过时，重取回来的那份与缓存逐字相同，React Query 的结构共享原样
   * 还回旧引用，下面「同一份响应只合一次」的闸门会把它挡掉——本地那笔没落盘
   * 的改动就这样一直留在屏幕上。所以这里自己取一份、直接合进去（此时
   * `saveState` 已被置回 `saved`，合并以远端为准）。
   */
  const onLeaseLost = useCallback(() => {
    if (!workspaceId || !boardId) return;
    void queryClient
      .fetchQuery({
        queryKey: ["board", workspaceId, boardId],
        queryFn: () => runtimeApi.loadBoard(workspaceId, boardId),
        staleTime: 0,
      })
      .then((remote) => useCanvasStore.getState().mergeRemoteDocument(remote))
      .catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ["boards", workspaceId] });
  }, [boardId, queryClient, workspaceId]);

  useBoardPresence(workspaceId, boardId, onCanvasChanged, onLeaseLost);

  /* ------------------------ 启动：恢复上次的工作空间 ---------------------- */
  /**
   * 只在**成功拿到列表之后**才算「试过了」。
   *
   * Runtime 暂时连不上时列表是 error，这个 effect 什么都不做也不落锁；
   * 等 `useWorkspacesQuery` 的轮询重连成功，它会自己再跑一次，
   * 于是「服务起来了但界面停在启动页」也就自愈了。
   */
  const restoredWorkspaceRef = useRef(false);
  useEffect(() => {
    if (workspace || restoredWorkspaceRef.current || !workspaces.data) return;
    restoredWorkspaceRef.current = true;
    const remembered = bootWorkspaceRef.current;
    // 什么都不记得（第一次启动，或上次把最后一个工作空间关掉了）就进列表里
    // 最近打开的那个——首启时它就是 Runtime 建好的默认项目，进来就有画布。
    // 「打开时恢复上次工作空间」关掉时 remembered 也是空，但那是用户要界面
    // 空着的选择，不在这里替他做主。
    const restore = usePreferencesStore.getState().restoreLastWorkspace;
    const match =
      workspaces.data.find((item) => item.id === remembered) ??
      (restore ? workspaces.data[0] : undefined);
    if (!match) return;
    openWorkspaceTab(match.id);
    setWorkspace(match);
    // 打不开（目录没了、Runtime 侧 404）就退回启动页，别停在一块死板上
    void runtimeApi.openWorkspace(match.id).catch(() => {
      if (useCanvasStore.getState().workspace?.id !== match.id) return;
      rememberWorkspace(null);
      setWorkspace(null);
    });
  }, [openWorkspaceTab, setWorkspace, workspace, workspaces.data]);

  /* --------------------------- 画布列表与选中项 -------------------------- */
  const restoredBoardForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace || !boards.data) return;
    setBoards(
      boards.data.map((item) => ({
        id: item.id,
        name: item.name,
        sortOrder: item.sortOrder,
      })),
    );
    if (restoredBoardForRef.current === workspace.id) return;
    restoredBoardForRef.current = workspace.id;
    const remembered = bootBoardRef.current;
    const match = boards.data.find((item) => item.id === remembered);
    selectBoard(match?.id ?? boards.data[0]?.id ?? null);
  }, [boards.data, selectBoard, setBoards, workspace]);

  /**
   * 只在**有值**时写回。清空是显式动作（关掉最后一个工作空间时
   * `useCloseWorkspace` 自己会 `rememberWorkspace(null)`）；
   * 加载途中的短暂 `null` 不该把「上次打开的东西」抹掉。
   */
  useEffect(() => {
    if (workspace?.id) rememberWorkspace(workspace.id);
  }, [workspace?.id]);

  useEffect(() => {
    if (boardId) rememberBoard(boardId);
    // 切板前把上一块板排队中的保存冲掉，避免 CAS 时间戳错位
    return () => void flushBoardSaves().catch(() => undefined);
  }, [boardId]);

  /* ------------------------------- 文档载入 ------------------------------ */
  /**
   * 第一次拿到某块板 → `setDocument`；之后每一次重取 → `mergeRemoteDocument`。
   *
   * 以前这里是「已经有同一块板就直接丢掉」，于是别的窗口的改动重取回来也
   * 被扔了（A04 记的第二处原因）。现在走合并：本地干净时远端为准，本地还
   * 脏时按保存冲突那套变基，视口永远留本地的（`canvas/sync/merge.ts`）。
   *
   * 两道闸门：
   *  - **同一份响应只合一次**。合并会换掉 `document`，而 `document` 是这个
   *    effect 的依赖；不记住合过哪一份就是一个自激循环。
   *  - **手势进行中先不合**。拖动中把节点对象换掉会让 d3-drag 当场错位，
   *    所以等 `drafts` 清空——那一刻这个 effect 会因为 `dragging` 变 false
   *    重新跑一次，把攒着的那份合进来。
   */
  const mergedRef = useRef<BoardDocument | null>(null);
  useEffect(() => {
    if (!workspace || !board.data) return;
    if (board.data.board.workspaceId !== workspace.id) return;
    if (board.data.board.id !== boardId) return;
    if (documentBoardId !== board.data.board.id) {
      mergedRef.current = board.data;
      setDocument(board.data);
      return;
    }
    if (dragging || mergedRef.current === board.data) return;
    mergedRef.current = board.data;
    mergeRemoteDocument(board.data);
  }, [
    board.data,
    boardId,
    documentBoardId,
    dragging,
    mergeRemoteDocument,
    setDocument,
    workspace,
  ]);

  /* ---------------------------- 保存失败后重试 --------------------------- */
  useEffect(() => {
    const retry = () => {
      const state = useCanvasStore.getState();
      if (!state.document) return;
      state.setSaveError(null);
      // 重新置脏即可：autosave 的订阅会立刻起一轮防抖
      state.setSaveState("dirty");
    };
    window.addEventListener(SAVE_RETRY_EVENT, retry);
    return () => window.removeEventListener(SAVE_RETRY_EVENT, retry);
  }, []);

  /* --------------------------- 有未落盘改动时拦窗 ------------------------- */
  useEffect(() => {
    if (
      saveState !== "dirty" &&
      saveState !== "saving" &&
      saveState !== "error"
    ) {
      return;
    }
    const guard = (event: BeforeUnloadEvent) => {
      void flushBoardSaves().catch(() => undefined);
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [saveState]);

  return { boards, board };
}

/** 心跳间隔；core 按三次没到算断开（core JSON §9.1）。 */
export const PRESENCE_HEARTBEAT_MS = 10_000;

/**
 * 在线设备与编辑租约（core JSON §9）。
 *
 * 打开一块画布就开始心跳，切走或关页面时离开。单设备、单窗口时第一次心跳
 * 就拿到租约，之后什么都不会发生；有别的设备在看时，谁持有租约由 core 说了
 * 算，这里只把回答放进 store（`store/canvas/presence.ts`），画布据此只读。
 *
 * 租约换手的那一刻按远端重载：丢了租约，本地那份作废；拿到租约，手里那份
 * 可能停在只读期间的某一版。
 */
function useBoardPresence(
  workspaceId: string | null,
  boardId: string | null,
  reload: () => void,
  discard: () => void,
): void {
  useEffect(() => {
    if (!workspaceId || !boardId) return;
    const clientId = presenceClientId();
    const deviceName = presenceDeviceName();
    let stopped = false;
    let left = false;

    const apply = (snapshot: Parameters<typeof applyPresence>[0]) => {
      if (stopped) return;
      const change = applyPresence(snapshot);
      if (change.lost) discard();
      else if (change.gained) reload();
    };
    const beat = () => {
      void runtimeApi
        .presenceHeartbeat(workspaceId, boardId, {
          clientId,
          deviceName,
          active: takePresenceActivity(),
        })
        .then(apply)
        // 连不上时什么都不改：上一份在线表继续有效，core 那边会按 TTL 把我们
        // 摘掉，重连后的第一次心跳再补回来。
        .catch(() => undefined);
    };
    const leave = () => {
      if (left) return;
      left = true;
      void runtimeApi
        .leavePresence(workspaceId, boardId, clientId)
        .catch(() => undefined);
    };

    beat();
    const timer = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);
    const offEvent = onWorkspaceEvent("canvas.presence", (event) => {
      if (event.boardId === boardId) apply(event);
    });
    // 被 423 拒了：别等下一拍，马上问一次谁拿着租约。
    const onLost = () => beat();
    // 后台标签页的定时器会被浏览器节流到一分钟一次，回到前台时先补一拍。
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    const onActivity = () => markPresenceActivity();
    window.addEventListener(LEASE_LOST_EVENT, onLost);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pointerdown", onActivity, { capture: true });
    window.addEventListener("keydown", onActivity, { capture: true });
    window.addEventListener("pagehide", leave);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      offEvent();
      window.removeEventListener(LEASE_LOST_EVENT, onLost);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointerdown", onActivity, { capture: true });
      window.removeEventListener("keydown", onActivity, { capture: true });
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [boardId, discard, reload, workspaceId]);
}
