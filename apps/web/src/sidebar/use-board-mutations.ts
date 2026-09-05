/**
 * 看板的增删改（§26）。
 *
 * 真相仍然在 Runtime：改完就让 `["boards", id]` 与 `["workspaces"]` 失效，
 * `use-board-sync` 订阅同一把 key，会把新列表灌回 store，侧栏不维护第二份。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Workspace } from "@ai-coding-canvas/shared";

import { runtimeApi } from "../api/client";

export function useBoardMutations(workspaceId: string) {
  const queryClient = useQueryClient();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["boards", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  };

  const create = useMutation({
    mutationFn: (name: string) => runtimeApi.createBoard(workspaceId, name),
    onSuccess: refresh,
    onError: (cause: Error) => toast.error(cause.message),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      runtimeApi.updateBoard(workspaceId, input.id, { name: input.name }),
    onSuccess: refresh,
    onError: (cause: Error) => toast.error(cause.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => runtimeApi.deleteBoard(workspaceId, id),
    onSuccess: refresh,
    onError: (cause: Error) => toast.error(cause.message),
  });

  return { create, rename, remove, refresh };
}

/** 工作空间改名。名字在会话头与标题里也在用，所以成功后回调一次。 */
export function useRenameWorkspace(
  workspaceId: string,
  onRenamed: (workspace: Workspace) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      runtimeApi.updateWorkspace(workspaceId, { name }),
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onRenamed(next);
    },
    onError: (cause: Error) => toast.error(cause.message),
  });
}
