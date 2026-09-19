import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import type { Workspace } from "@armadra/shared";
import { toast } from "sonner";
import { isDesktop, pickDirectory } from "../platform";
import { useT } from "../app/preferences-store";
import { useCreateWorkspace } from "../app/workspace-actions";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

export interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspace: Workspace) => void;
}

/**
 * 新建文件夹（§20，2026-09-05 精简到只剩路径）。
 *
 * 一个路径字段加一个「选择」钮，别的都没有：名称取路径末段，颜色轮询，
 * 权限固定全开。系统目录选择器自带「新建文件夹」，用户在里面就能把目录
 * 建出来；直接手填一个还不存在的路径也行，Runtime 负责 `mkdir`，
 * 已经存在就当作打开。
 */
export function NewFolderDialog({
  open,
  onOpenChange,
  onCreated,
}: NewFolderDialogProps) {
  const t = useT();
  const createWorkspace = useCreateWorkspace();
  const [path, setPath] = useState("");

  useEffect(() => {
    if (open) setPath("");
  }, [open]);

  const create = useMutation({
    mutationFn: () => createWorkspace(path, { createDirectory: true }),
    onSuccess: (workspace) => {
      onOpenChange(false);
      onCreated?.(workspace);
    },
    onError: (cause: Error) => toast.error(cause.message),
  });

  const ready = path.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[var(--z-dialog)]">
        <DialogHeader>
          <DialogTitle>{t("launcher.newFolder")}</DialogTitle>
        </DialogHeader>

        {/* 分组卡片：标签左 / 控件右（§24.2「分组表单」） */}
        <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 rounded-[var(--r-card)] border border-border bg-[var(--card)] p-4">
          <label className="text-muted-foreground" htmlFor="folder-path">
            {t("workspace.path")}
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              id="folder-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
            {isDesktop() && (
              <Button
                variant="outline"
                size="icon"
                aria-label={t("folder.choose")}
                onClick={() => {
                  void pickDirectory().then((picked) => {
                    if (picked) setPath(picked);
                  });
                }}
              >
                <FolderOpen />
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("dialog.cancel")}
          </Button>
          <Button
            disabled={!ready || create.isPending}
            onClick={() => create.mutate()}
          >
            {t("dialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
