import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@armadra/shared";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Switch } from "@/ui/switch";
import {
  filesGateway,
  FilesystemOwnershipMovedError,
  FilesystemReadOnlyError,
} from "@/files/gateway";
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
      // 经文件域网关：这个开关改的是「这个工作空间允许执行吗」，切换后由
      // Host 记录，调用方不需要知道写去了哪一侧。
    }) => filesGateway.updatePermissions(id, permissions),
    onSuccess: (updated) => {
      client.setQueryData<WorkspaceSummary[]>(["workspaces"], (rows) =>
        rows?.map((row) =>
          row.id === updated.workspaceId
            ? { ...row, permissions: updated.permissions }
            : row,
        ),
      );
      const current = useCanvasStore.getState();
      if (current.workspace?.id === updated.workspaceId)
        current.setWorkspace({
          ...current.workspace,
          permissions: updated.permissions,
        });
      invalidateGitQueries(client, updated.workspaceId);
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
          {/* 「谁在写这个域」和「写失败了」是两件事：切换窗口开着的时候
              这个开关根本不该被解释成保存失败，那会让人一直重试。 */}
          {save.error instanceof FilesystemReadOnlyError
            ? t("ownership.filesystem.readonly")
            : save.error instanceof FilesystemOwnershipMovedError
              ? t("ownership.filesystem.moved")
              : t("gitRepo.permissionSaveFailed")}
        </p>
      )}
    </SettingsGroup>
  );
}
