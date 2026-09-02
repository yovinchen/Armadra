import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Workspace } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import {
  rememberBoard,
  rememberWorkspace,
  usePreferencesStore,
} from "./preferences-store";

/**
 * 打开（或切换到）一个工作空间。启动页卡片、TabBar 的 tab 与 `+` 三处共用。
 *
 * 顺序有讲究：先把 store 切过去让界面立刻响应，再异步通知 Runtime
 * “这个工作空间被打开了”（它只用来更新 `lastOpenedAt`，失败无所谓）。
 */
export function useOpenWorkspace() {
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const openWorkspaceTab = usePreferencesStore(
    (state) => state.openWorkspaceTab,
  );

  return useCallback(
    (workspace: Workspace) => {
      const current = useCanvasStore.getState().workspace;
      if (current?.id === workspace.id) return;
      rememberWorkspace(workspace.id);
      rememberBoard(null);
      openWorkspaceTab(workspace.id);
      setWorkspace(workspace);
      selectBoard(null);
      void runtimeApi.openWorkspace(workspace.id).catch(() => undefined);
    },
    [openWorkspaceTab, selectBoard, setWorkspace],
  );
}

/** 关闭一个工作空间 tab；关的是当前工作空间时切到剩下的第一个。 */
export function useCloseWorkspace() {
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const closeWorkspaceTab = usePreferencesStore(
    (state) => state.closeWorkspaceTab,
  );
  const queryClient = useQueryClient();

  return useCallback(
    (workspaceId: string) => {
      closeWorkspaceTab(workspaceId);
      const state = useCanvasStore.getState();
      if (state.workspace?.id !== workspaceId) return;
      const remaining = usePreferencesStore
        .getState()
        .openWorkspaceIds.filter((id) => id !== workspaceId);
      const summaries =
        queryClient.getQueryData<Workspace[]>(["workspaces"]) ?? [];
      const next = remaining
        .map((id) => summaries.find((item) => item.id === id))
        .find((item): item is Workspace => Boolean(item));
      rememberWorkspace(next?.id ?? null);
      rememberBoard(null);
      setWorkspace(next ?? null);
      selectBoard(null);
      if (next) void runtimeApi.openWorkspace(next.id).catch(() => undefined);
    },
    [closeWorkspaceTab, queryClient, selectBoard, setWorkspace],
  );
}
