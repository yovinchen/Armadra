import * as React from "react";

import { useT } from "@/app/preferences-store";
import { PatchBody } from "@/nodes/DiffNode";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { ScrollArea } from "@/ui/scroll-area";
import { applyEditPreview } from "./edit-preview";
import { useEditPreviewStore } from "./edit-preview-store";

/**
 * `WorkspaceEdit` 的预览与确认（语言服务设计 §2.6）。
 *
 * 重命名这类操作会改到用户此刻看不见的文件。所以在写之前先把**每个**文件
 * 的 diff 摊开，并且：
 *
 *  * 任何一项走不通就整次不可应用——半个重命名比不重命名更糟；
 *  * 应用之后 applied / failed 两张表留在对话框里，用户自己决定要不要
 *    再来一次（重新发一次重命名，重新算一份预览）。
 *
 * 已经打开的文件不在这里改：写盘之后 `file.changed` 会让干净的编辑器按
 * 既有规则自己重载。
 */
export function EditPreviewDialog() {
  const t = useT();
  const { preview, loading, result, error, applying } = useEditPreviewStore();
  const store = useEditPreviewStore;
  const open = loading || preview !== null || error !== null;

  const changed = React.useMemo(
    () => (preview?.files ?? []).filter((file) => file.patch !== ""),
    [preview],
  );

  const apply = async () => {
    if (!preview || preview.blocked) return;
    store.getState().setApplying(true);
    try {
      store.getState().finish(await applyEditPreview(preview));
    } catch (cause) {
      store
        .getState()
        .fail(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) store.getState().close();
      }}
    >
      <DialogContent className="flex max-h-[80vh] w-[min(92vw,52rem)] max-w-none flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{preview?.title ?? t("lsp.preview.title")}</DialogTitle>
          <DialogDescription>
            {loading
              ? t("lsp.preview.computing")
              : preview
                ? t("lsp.preview.files", {
                    count: String(preview.files.length),
                  })
                : ""}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-[12px] text-[var(--danger)]">{error}</p>}

        {preview?.blocked && (
          <p className="text-[12px] text-[var(--warn)]">
            {t("lsp.preview.blocked")}
          </p>
        )}

        {preview && preview.files.length === 0 && !loading && (
          <p className="text-[12px] text-muted-foreground">
            {t("lsp.preview.noChanges")}
          </p>
        )}

        {result && (
          <div className="flex flex-col gap-1 text-[12px]">
            <span>
              {t("lsp.preview.applied", {
                count: String(result.applied.length),
              })}
            </span>
            {result.failed.length > 0 && (
              <div className="flex flex-col gap-0.5 text-[var(--danger)]">
                <span>{t("lsp.preview.failedTitle")}</span>
                {result.failed.map((failure) => (
                  <span key={failure.path} className="break-all">
                    {failure.path} · {failure.message}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 pr-2">
            {(preview?.files ?? []).map((file) => (
              <div key={file.uri} className="min-w-0">
                <div className="flex items-center gap-2 pb-1">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {file.path ?? file.uri}
                  </span>
                  {file.blocked && (
                    <Badge variant="outline">
                      {t(`lsp.blocked.${file.blocked}`)}
                    </Badge>
                  )}
                  {!file.blocked && file.patch === "" && (
                    <Badge variant="outline">
                      {t("lsp.preview.unchanged")}
                    </Badge>
                  )}
                </div>
                {file.patch !== "" && (
                  <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-border">
                    <PatchBody patch={file.patch} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="ghost" onClick={() => store.getState().close()}>
            {result ? t("lsp.preview.close") : t("lsp.preview.cancel")}
          </Button>
          {!result && (
            <Button
              disabled={
                applying ||
                loading ||
                !preview ||
                preview.blocked ||
                changed.length === 0
              }
              onClick={() => void apply()}
            >
              {t("lsp.preview.apply")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
