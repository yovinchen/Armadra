import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Workspace, WorkspaceSummary } from "@armadra/shared";
import { toast } from "sonner";
import { isConflict, runtimeApi } from "../api/client";
import { filesGateway } from "../files/gateway";
import { isDesktop, pickDirectory } from "../platform";
import { useCanvasStore } from "../store/canvas-store";
import {
  rememberBoard,
  rememberWorkspace,
  usePreferencesStore,
} from "./preferences-store";
import { workspaceRequest } from "./workspace-create";

/**
 * 建（或接管）一个工作空间：调用方只给路径。
 *
 * 名称、颜色、权限都由 `workspaceRequest` 从路径推出来，用户不再填。
 * `createDirectory` 为真时 Runtime 先 `mkdir`；目录已经在那儿了它会回 409，
 * 那不是错误——直接改成「打开已有目录」再发一次。Runtime 那边对同一个
 * `rootPath` 是幂等的，所以已经建过的工作空间会原样回来。
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  return useCallback(
    async (
      rootPath: string,
      options: { createDirectory?: boolean } = {},
    ): Promise<Workspace> => {
      const existing =
        queryClient.getQueryData<WorkspaceSummary[]>(["workspaces"]) ?? [];
      const request = workspaceRequest(
        rootPath,
        existing,
        options.createDirectory ?? false,
      );
      let workspace: Workspace;
      // 经文件域网关：根注册落在哪一侧，取决于文件域现在归谁写。
      try {
        workspace = await filesGateway.createWorkspace(request);
      } catch (cause) {
        if (!request.createDirectory || !isConflict(cause)) throw cause;
        workspace = await filesGateway.createWorkspace({
          ...request,
          createDirectory: false,
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      return workspace;
    },
    [queryClient],
  );
}

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

/**
 * 「打开文件夹」：系统选择器 → 建（或接管）工作空间 → 打开，中间不再弹对话框，
 * 因为名称、颜色、权限全都不用问了。拖一个目录进窗口走的是同一条路。
 *
 * 浏览器里没有系统选择器（`pickDirectory()` 恒为 `null`），退回 `fallback`——
 * 手填路径的新建文件夹对话框对已存在的目录就是「打开」。
 */
export function useOpenFolder(fallback: () => void) {
  const createWorkspace = useCreateWorkspace();
  const openWorkspace = useOpenWorkspace();

  return useCallback(async () => {
    const picked = isDesktop() ? await pickDirectory() : null;
    if (!picked) {
      if (!isDesktop()) fallback();
      return;
    }
    try {
      openWorkspace(await createWorkspace(picked));
    } catch (cause) {
      toast.error((cause as Error).message);
    }
  }, [createWorkspace, fallback, openWorkspace]);
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
