import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { runtimeApi } from "../api/client";
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
import { useWorkspacesQuery } from "./WorkspaceGrid";

/**
 * 加载链：工作空间 → 看板列表 → 看板文档，外加“记住上次打开的东西”。
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
   * 「记住当前工作空间」的 effect 先跑一步，把 `aicc.workspace` 抹成空；
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
    bootWorkspaceRef.current = restore ? lastWorkspaceId() : null;
    bootBoardRef.current = restore ? lastBoardId() : null;
  }

  const workspace = useCanvasStore((state) => state.workspace);
  const boardId = useCanvasStore((state) => state.boardId);
  const document = useCanvasStore((state) => state.document);
  const saveState = useCanvasStore((state) => state.saveState);
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const setBoards = useCanvasStore((state) => state.setBoards);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const setDocument = useCanvasStore((state) => state.setDocument);
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
    const match = workspaces.data.find((item) => item.id === remembered);
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

  /* --------------------------- 看板列表与选中项 -------------------------- */
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
  useEffect(() => {
    if (!workspace || !board.data) return;
    if (board.data.board.workspaceId !== workspace.id) return;
    if (board.data.board.id !== boardId) return;
    // 已经有同一块板的本地文档就不要覆盖，否则会吞掉未保存的编辑
    if (document?.board.id === board.data.board.id) return;
    setDocument(board.data);
  }, [board.data, boardId, document, setDocument, workspace]);

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
