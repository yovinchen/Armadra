import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@armadra/shared";
import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Switch } from "@/ui/switch";
import { invalidateGitQueries } from "../../git/queries";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";

export function WorkspaceExecution() {
  const workspace = useCanvasStore((state) => state.workspace);
  const client = useQueryClient();
  const t = useT();
  const gate = useRef(false);
  const save = useMutation({
    mutationFn: ({
      id,
      permissions,
    }: {
      id: string;
      permissions: NonNullable<typeof workspace>["permissions"];
    }) => runtimeApi.updateWorkspace(id, { permissions }),
    onSuccess: (updated) => {
      client.setQueryData<WorkspaceSummary[]>(["workspaces"], (rows) =>
        rows?.map((row) =>
          row.id === updated.id ? { ...row, ...updated } : row,
        ),
      );
      const current = useCanvasStore.getState();
      if (current.workspace?.id === updated.id) current.setWorkspace(updated);
      invalidateGitQueries(client, updated.id);
    },
  });
  if (!workspace) return null;
  return (
    <SettingsGroup>
      <SettingsRow
        label={t("gitRepo.allowExecution")}
        footnote={t("gitRepo.executionDetail")}
      >
        <Switch
          checked={workspace.permissions.execute}
          disabled={save.isPending}
          aria-label={t("gitRepo.allowExecution")}
          onCheckedChange={(next) => {
            if (gate.current) return;
            gate.current = true;
            save.mutate(
              {
                id: workspace.id,
                permissions: { ...workspace.permissions, execute: next },
              },
              {
                onSettled: () => {
                  gate.current = false;
                },
              },
            );
          }}
        />
      </SettingsRow>
      {save.error && (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive">
          {t("gitRepo.permissionSaveFailed")}
        </p>
      )}
    </SettingsGroup>
  );
}
