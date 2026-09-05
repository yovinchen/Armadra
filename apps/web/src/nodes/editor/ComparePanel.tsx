import { X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { PatchBody } from "../DiffNode";

/** 磁盘版 → 草稿的差异，着色复用变更节点的 `PatchBody`。 */
export function ComparePanel({
  patch,
  onClose,
}: {
  patch: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[var(--surface-sunken)]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-caption)] text-muted-foreground">
          {t("editor.compareTitle")}
        </span>
        <IconButton label={t("editor.compareClose")} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {patch ? (
          <PatchBody patch={patch} />
        ) : (
          <div className="p-2">
            <Badge variant="outline">{t("editor.compareEmpty")}</Badge>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
