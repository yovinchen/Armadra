/**
 * 看板的增删（§26 →§28）。
 *
 * 真相仍然在 Runtime：改完就让 `["boards", id]` 与 `["workspaces"]` 失效，
 * `use-board-sync` 订阅同一把 key，会把新列表灌回 store，侧栏不维护第二份。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { Board, WorkspaceSummary } from "@armadra/shared";
import { useCanvasStore } from "../store/canvas-store";
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

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["boards", workspaceId] }),
        queryClient.cancelQueries({ queryKey: ["workspaces"] }),
      ]);
      return runtimeApi.updateBoard(workspaceId, id, { name });
    },
    onSuccess: (board) => {
      queryClient.setQueryData<Board[]>(["boards", workspaceId], (rows) =>
        rows?.map((row) => (row.id === board.id ? board : row)),
      );
      queryClient.setQueryData<WorkspaceSummary[]>(["workspaces"], (rows) =>
        rows?.map((row) =>
          row.id === workspaceId
            ? {
                ...row,
                boards: row.boards.map((item) =>
                  item.id === board.id ? { ...item, name: board.name } : item,
                ),
              }
            : row,
        ),
      );
      const state = useCanvasStore.getState();
      if (state.workspace?.id !== workspaceId) return;
      state.setBoards(
        state.boards.map((item) =>
          item.id === board.id ? { ...item, name: board.name } : item,
        ),
      );
      // Name edits do not change the document CAS timestamp or discard unsaved shapes.
      if (state.document?.board.id === board.id)
        useCanvasStore.setState({
          document: {
            ...state.document,
            board: { ...state.document.board, name: board.name },
          },
        });
    },
  });

  return { create, remove, rename, refresh };
}
