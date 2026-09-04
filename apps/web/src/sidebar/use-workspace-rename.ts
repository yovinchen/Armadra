import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@armadra/shared";
import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";

export function useWorkspaceRename(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      await client.cancelQueries({ queryKey: ["workspaces"] });
      return runtimeApi.updateWorkspace(workspaceId, { name });
    },
    onSuccess: (workspace) => {
      client.setQueryData<WorkspaceSummary[]>(["workspaces"], (rows) =>
        rows?.map((row) =>
          row.id === workspaceId ? { ...row, ...workspace } : row,
        ),
      );
      const state = useCanvasStore.getState();
      if (state.workspace?.id === workspaceId) state.setWorkspace(workspace);
    },
  });
}
