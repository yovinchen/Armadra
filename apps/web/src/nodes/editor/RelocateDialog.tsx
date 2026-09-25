import * as React from "react";

import { isConflict } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

/** 请求错误带着的 HTTP 状态；读不出来就是别的失败。 */
function statusOf(cause: unknown): number | undefined {
  if (cause === null || typeof cause !== "object" || !("status" in cause))
    return undefined;
  const status = (cause as { status: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * 重新定位（编辑器设计 §3）：选一个已经存在的文件，把草稿接过去。
 *
 * 合并交给三方合并对话框；覆盖要再确认一次——它会换掉那个文件现有的内容。
 * 目标不存在时不代为新建：那是另存为的事。
 */
export function RelocateDialog({
  open,
  currentPath,
  onOpenChange,
  onMerge,
  onOverwrite,
}: {
  open: boolean;
  currentPath: string;
  onOpenChange: (open: boolean) => void;
  onMerge: (path: string) => Promise<void>;
  onOverwrite: (path: string) => Promise<void>;
}) {
  const t = useT();
  const [path, setPath] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setPath("");
    setConfirming(false);
    setError(null);
    setBusy(false);
  }, [open]);

  const target = path.trim().replace(/^\/+/, "");
  const usable = target !== "" && target !== currentPath;

  const run = async (action: (path: string) => Promise<void>) => {
    if (!usable || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action(target);
      onOpenChange(false);
    } catch (cause) {
      setConfirming(false);
      setError(
        statusOf(cause) === 404
          ? t("editor.relocate.missing")
          : isConflict(cause)
            ? t("editor.relocate.changed")
            : cause instanceof Error
              ? cause.message
              : t("editor.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[var(--z-dialog)]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(onMerge);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("editor.relocate")}</DialogTitle>
            {confirming && (
              <DialogDescription>
                {t("editor.relocate.confirm", { path: target })}
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="flex flex-col gap-1.5 py-3">
            <label
              className="text-[length:var(--text-caption)] text-muted-foreground"
              htmlFor="editor-relocate-path"
            >
              {t("editor.saveAs.path")}
            </label>
            <Input
              id="editor-relocate-path"
              autoFocus
              value={path}
              disabled={confirming}
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
              onClick={() =>
                confirming ? setConfirming(false) : onOpenChange(false)
              }
            >
              {t("dialog.cancel")}
            </Button>
            {confirming ? (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => void run(onOverwrite)}
              >
                {t("editor.relocate.overwrite")}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!usable || busy}
                  onClick={() => setConfirming(true)}
                >
                  {t("editor.relocate.overwrite")}
                </Button>
                <Button type="submit" disabled={!usable || busy}>
                  {t("editor.draft.merge")}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
