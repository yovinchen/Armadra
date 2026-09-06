/**
 * 看板的增删（§26 →§28）。
 *
 * 真相仍然在 Runtime：改完就让 `["boards", id]` 与 `["workspaces"]` 失效，
 * `use-board-sync` 订阅同一把 key，会把新列表灌回 store，侧栏不维护第二份。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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

  const remove = useMutation({
    mutationFn: (id: string) => runtimeApi.deleteBoard(workspaceId, id),
    onSuccess: refresh,
    onError: (cause: Error) => toast.error(cause.message),
  });

  return { create, remove, refresh };
}
