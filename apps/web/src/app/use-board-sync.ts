import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BoardDocument } from "@armadra/shared";
import { runtimeApi } from "../api/client";
import { onWorkspaceEvent } from "../api/events";
import { useDraftsActive } from "../canvas/flow/drafts";
import {
  useCanvasEventFollower,
  useCanvasOwnership,
  canvasGateway,
} from "../canvas-ownership";
import { flushBoardSaves } from "../save/autosave";
import { SAVE_RETRY_EVENT } from "../shell/Banners";
import { useCanvasStore } from "../store/canvas-store";
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
  const document = useCanvasStore((state) => state.document);
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

  /**
   * 启动就探一次画布写归属（H01 §4）。
   *
   * 探到之前保存是停的：不知道该写给谁的时候写出去，等于赌一把。
   * 探测失败也是一个真状态，不会被当成「Runtime 在写」蒙混过去。
   */
  useEffect(() => {
    void useCanvasOwnership.getState().probe();
  }, []);

  const boards = useQuery({
    queryKey: ["boards", workspace?.id],
    queryFn: () => runtimeApi.listBoards(workspace!.id),
    enabled: Boolean(workspace),
  });

  const board = useQuery({
    queryKey: ["board", workspace?.id, boardId],
    queryFn: () => canvasGateway.loadBoard(workspace!.id, boardId!),
    enabled: Boolean(workspace && boardId),
  });

  /**
   * Host 在写时按 sequence 续订它的事件（H01 §3.3）。
   *
   * Runtime 那条路上有工作空间事件 WebSocket；Host 这条没有，所以这里保留
   * 一个游标，只取读完之后发生的改动。这里**只让文档查询失效**，不直接改
   * store：本地还没落盘的编辑不该被一次轮询盖掉，合并仍然走保存冲突那条路。
   */
  const queryClient = useQueryClient();
  const workspaceId = workspace?.id ?? null;
  const onCanvasChanged = useCallback(() => {
    if (!workspaceId) return;
    void queryClient.invalidateQueries({ queryKey: ["board", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["boards", workspaceId] });
  }, [queryClient, workspaceId]);
  useCanvasEventFollower(workspaceId, onCanvasChanged);

  /**
   * Runtime 在写时的同一件事（A04）。
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
    if (document?.board.id !== board.data.board.id) {
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
    document,
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
