import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import type { ExternalChange } from "./types";

/**
 * 外部改动提示条：非模态，不挡编辑区，三个选择都留给用户。
 * 文件被删除时没有可比较也没有可重载的磁盘版本，只剩「保留草稿」。
 */
export function ExternalBar({
  change,
  onCompare,
  onReload,
  onKeep,
}: {
  change: ExternalChange;
  onCompare: () => void;
  onReload: () => void;
  onKeep: () => void;
}) {
  const t = useT();
  const removed = change.kind === "removed";
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] bg-[var(--warn-soft)] px-2 py-1"
    >
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-caption)]">
        {t(`editor.external.${change.kind}`)}
      </span>
      {!removed && (
        <Button variant="ghost" size="sm" className="h-6" onClick={onCompare}>
          {t("editor.compare")}
        </Button>
      )}
      {!removed && (
        <Button variant="ghost" size="sm" className="h-6" onClick={onReload}>
          {t("editor.reloadDiscard")}
        </Button>
      )}
      <Button variant="secondary" size="sm" className="h-6" onClick={onKeep}>
        {t("editor.keepDraft")}
      </Button>
    </div>
  );
}
