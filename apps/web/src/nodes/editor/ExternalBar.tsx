import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import type { ExternalChange } from "./types";

/**
 * 外部改动提示条：非模态，不挡编辑区，几个选择都留给用户。
 *
 * 有草稿时多一个「合并」：base 是草稿改起时的那一版、ours 是草稿、theirs
 * 是磁盘版的三方合并（编辑器设计 §3）。文件被删除时没有可比较、可重载也
 * 可合并的磁盘版本，只剩保留草稿、另存为，与重新定位到另一个已有文件。
 */
export function ExternalBar({
  change,
  dirty,
  onCompare,
  onMerge,
  onReload,
  onKeep,
  onSaveAs,
  onRelocate,
}: {
  change: ExternalChange;
  dirty: boolean;
  onCompare: () => void;
  onMerge: () => void;
  onReload: () => void;
  onKeep: () => void;
  onSaveAs: () => void;
  /** 把草稿接到另一个已经存在的文件上。 */
  onRelocate: () => void;
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
      {!removed && dirty && (
        <Button variant="ghost" size="sm" className="h-6" onClick={onMerge}>
          {t("editor.draft.merge")}
        </Button>
      )}
      {!removed && (
        <Button variant="ghost" size="sm" className="h-6" onClick={onReload}>
          {t("editor.reloadDiscard")}
        </Button>
      )}
      {removed && (
        <Button variant="ghost" size="sm" className="h-6" onClick={onSaveAs}>
          {t("editor.saveAs")}
        </Button>
      )}
      {removed && (
        <Button variant="ghost" size="sm" className="h-6" onClick={onRelocate}>
          {t("editor.relocate")}
        </Button>
      )}
      <Button variant="secondary" size="sm" className="h-6" onClick={onKeep}>
        {t("editor.keepDraft")}
      </Button>
    </div>
  );
}
