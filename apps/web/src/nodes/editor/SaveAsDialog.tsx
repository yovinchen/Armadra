import * as React from "react";

import { isConflict } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

/**
 * 另存为（编辑器设计 §3「文件被移动/删除：保留草稿，允许另存为」）。
 *
 * 只收工作空间相对路径，写入按「新建」提交：目标已经有文件就是 409，
 * 在这里说出来，而不是把别人的文件盖掉。
 */
export function SaveAsDialog({
  open,
  initialPath,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  initialPath: string;
  onOpenChange: (open: boolean) => void;
  /** 写盘并把节点改指到新路径；失败就抛。 */
  onSave: (path: string) => Promise<void>;
}) {
  const t = useT();
  const [path, setPath] = React.useState(initialPath);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setPath(initialPath);
    setError(null);
    setSaving(false);
  }, [initialPath, open]);

  const target = path.trim().replace(/^\/+/, "");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(target);
      onOpenChange(false);
    } catch (cause) {
      setError(
        isConflict(cause)
          ? t("editor.saveAs.exists")
          : cause instanceof Error
            ? cause.message
            : t("editor.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[var(--z-dialog)]">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t("editor.saveAs")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5 py-3">
            <label
              className="text-[length:var(--text-caption)] text-muted-foreground"
              htmlFor="editor-save-as-path"
            >
              {t("editor.saveAs.path")}
            </label>
            <Input
              id="editor-save-as-path"
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
            {error && (
              <p
                role="alert"
                className="break-words text-[12px] text-[var(--danger)]"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("dialog.cancel")}
            </Button>
            <Button type="submit" disabled={!target || saving}>
              {t("editor.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
