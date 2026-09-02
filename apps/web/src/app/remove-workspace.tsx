/**
 * 「从列表移除」——启动页卡片与侧栏工作空间行共用的一份实现（§20）。
 *
 * 移除的是记录不是项目：Runtime 的 `DELETE /api/workspaces/{id}` 只终结这个
 * 工作空间的终端会话并删掉库里的行，磁盘上的目录一个字节都不动。所以
 * 确认框上只有那一句话，别的说明一律不写（§14）。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { runtimeApi } from "../api/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { useT } from "./preferences-store";
import { useCloseWorkspace } from "./workspace-actions";

/**
 * 删除 + 收尾：先把 tab 关掉（`useCloseWorkspace` 要读缓存里的工作空间列表
 * 来决定切到哪个，所以必须在 invalidate 之前），再让 `["workspaces"]` 失效。
 */
export function useRemoveWorkspace() {
  const queryClient = useQueryClient();
  const closeWorkspace = useCloseWorkspace();

  return useMutation({
    mutationFn: (workspaceId: string) =>
      runtimeApi.deleteWorkspace(workspaceId),
    onSuccess: (_result, workspaceId) => {
      closeWorkspace(workspaceId);
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (cause: Error) => toast.error(cause.message),
  });
}

export function RemoveWorkspaceDialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useT();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="z-[var(--z-dialog)]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("launcher.removeTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("launcher.removeNote")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("launcher.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {t("launcher.removeConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
