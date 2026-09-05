import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import {
  WORKSPACE_COLORS,
  type WorkspaceSummary,
} from "@armadra/shared";
import { toast } from "sonner";
import { runtimeApi } from "../api/client";
import { isTauri, pickDirectory } from "../platform";
import { useT } from "../app/preferences-store";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

/** 拼 `<父目录>/<名称>`，两边的分隔符各自去重。 */
function joinPath(parent: string, name: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name.replace(/^[\\/]+/, "")}`;
}

export interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspace: WorkspaceSummary) => void;
}

/**
 * 新建文件夹（§20）：父目录 + 名称 + 颜色，Runtime 负责 `mkdir` 并建工作空间。
 *
 * 浏览器里没有系统选择器，`pickDirectory()` 直接返回 `null`，
 * 所以父目录始终是一个可手填的输入框，选择按钮只在桌面壳里出现。
 */
export function NewFolderDialog({
  open,
  onOpenChange,
  onCreated,
}: NewFolderDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]);

  useEffect(() => {
    if (!open) return;
    setParent("");
    setName("");
    setColor(WORKSPACE_COLORS[0]);
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      runtimeApi.createWorkspace({
        name: name.trim(),
        rootPath: joinPath(parent.trim(), name.trim()),
        color,
        createDirectory: true,
      }),
    onSuccess: (workspace) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onOpenChange(false);
      onCreated?.({ ...workspace, boards: [] } as WorkspaceSummary);
    },
    onError: (cause: Error) => toast.error(cause.message),
  });

  const ready = parent.trim().length > 0 && name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[var(--z-dialog)]">
        <DialogHeader>
          <DialogTitle>{t("launcher.newFolder")}</DialogTitle>
        </DialogHeader>

        {/* 分组卡片：标签左 / 控件右（§24.2「分组表单」） */}
        <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-3 rounded-[var(--r-card)] border border-border bg-[var(--card)] p-4">
          <label className="text-muted-foreground" htmlFor="folder-parent">
            {t("folder.parent")}
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              id="folder-parent"
              value={parent}
              onChange={(event) => setParent(event.target.value)}
            />
            {isTauri() && (
              <Button
                variant="outline"
                size="icon"
                aria-label={t("folder.choose")}
                onClick={() => {
                  void pickDirectory().then((picked) => {
                    if (picked) setParent(picked);
                  });
                }}
              >
                <FolderOpen />
              </Button>
            )}
          </div>

          <label className="text-muted-foreground" htmlFor="folder-name">
            {t("folder.name")}
          </label>
          <Input
            id="folder-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />

          <span className="text-muted-foreground">{t("workspace.color")}</span>
          <div
            role="radiogroup"
            aria-label={t("workspace.color")}
            className="flex gap-0.5"
          >
            {WORKSPACE_COLORS.map((swatch) => (
              <Button
                key={swatch}
                variant="ghost"
                size="icon-sm"
                role="radio"
                aria-checked={swatch === color}
                aria-label={swatch}
                onClick={() => setColor(swatch)}
              >
                <ColorDot
                  color={swatch}
                  size={14}
                  selected={swatch === color}
                />
              </Button>
            ))}
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
