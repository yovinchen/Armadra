import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import {
  WORKSPACE_COLORS,
  type WorkspacePermissions,
  type WorkspaceSummary,
} from "@armadra/shared";
import { toast } from "sonner";
import { runtimeApi } from "../api/client";
import { pickDirectory } from "../platform";
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
import { Switch } from "@/ui/switch";

/** `/a/b/c` 与 `C:\a\b` 都取最后一段做默认名。 */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

const DEFAULT_PERMISSIONS: WorkspacePermissions = {
  read: true,
  write: true,
  execute: true,
};

export interface NewWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 拖入目录 / 系统选择器带进来的路径。 */
  initialPath?: string | null;
  onCreated?: (workspace: WorkspaceSummary) => void;
}

export function NewWorkspaceDialog({
  open,
  onOpenChange,
  initialPath,
  onCreated,
}: NewWorkspaceDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]);
  const [permissions, setPermissions] =
    useState<WorkspacePermissions>(DEFAULT_PERMISSIONS);
  // 用户手改过名字之后就不再跟着路径变
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath(initialPath ?? "");
    setName(initialPath ? basename(initialPath) : "");
    setNameTouched(false);
    setColor(WORKSPACE_COLORS[0]);
    setPermissions(DEFAULT_PERMISSIONS);
  }, [initialPath, open]);

  const create = useMutation({
    mutationFn: () =>
      runtimeApi.createWorkspace({
        name: name.trim(),
        rootPath: path.trim(),
        color,
        permissions,
      }),
    onSuccess: (workspace) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onOpenChange(false);
      onCreated?.({ ...workspace, boards: [] } as WorkspaceSummary);
    },
    onError: (cause: Error) => toast.error(cause.message),
  });

  async function browse() {
    const picked = await pickDirectory();
    if (!picked) return;
    setPath(picked);
    if (!nameTouched) setName(basename(picked));
  }

  const ready = name.trim().length > 0 && path.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[var(--z-dialog)]">
        <DialogHeader>
          <DialogTitle>{t("workspace.new")}</DialogTitle>
        </DialogHeader>

        {/* 分组卡片：标签左 / 控件右，卡外无第二层边框（§24.2「分组表单」） */}
        <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-3 rounded-[var(--r-card)] border border-border bg-[var(--card)] p-4">
          <label className="text-muted-foreground" htmlFor="workspace-name">
            {t("workspace.name")}
          </label>
          <Input
            id="workspace-name"
            value={name}
            onChange={(event) => {
              setNameTouched(true);
              setName(event.target.value);
            }}
          />

          <label className="text-muted-foreground" htmlFor="workspace-path">
            {t("workspace.path")}
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              id="workspace-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label={t("workspace.browse")}
              onClick={() => void browse()}
            >
              <FolderOpen />
            </Button>
          </div>

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

          <span className="text-muted-foreground">{t("workspace.read")}</span>
          <Switch
            checked={permissions.read}
            aria-label={t("workspace.read")}
            onCheckedChange={(checked) =>
              setPermissions((current) => ({ ...current, read: checked }))
            }
          />
          <span className="text-muted-foreground">{t("workspace.write")}</span>
          <Switch
            checked={permissions.write}
            aria-label={t("workspace.write")}
            onCheckedChange={(checked) =>
              setPermissions((current) => ({ ...current, write: checked }))
            }
          />
          <span className="text-muted-foreground">
            {t("workspace.execute")}
          </span>
          <Switch
            checked={permissions.execute}
            aria-label={t("workspace.execute")}
            onCheckedChange={(checked) =>
              setPermissions((current) => ({ ...current, execute: checked }))
            }
          />
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
