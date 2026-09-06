import { ChevronDown, ChevronRight, X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  countReferences,
  useReferencesStore,
  type ReferenceGroup,
} from "@/editor/language/references-store";
import { openFileInEditor } from "@/files/open-editor";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";

/**
 * 引用面板（语言服务设计 §1.1「符号」、§4.2 `ReferencesPanel.tsx`）。
 *
 * 侧栏的一页，不是编辑器里的浮层：点一条会跳到另一个文件，而贴在某个
 * `EditorView` 上的面板在那一刻就没了。按文件分组、每组可收起、点一行打开
 * 并定位到那一行。
 */
export function ReferencesPanel() {
  const t = useT();
  const mode = useCanvasStore((state) => state.panels.references);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const symbol = useReferencesStore((state) => state.symbol);
  const loading = useReferencesStore((state) => state.loading);
  const error = useReferencesStore((state) => state.error);
  const groups = useReferencesStore((state) => state.groups);
  const external = useReferencesStore((state) => state.external);

  const total = countReferences(groups);

  return (
    <Sheet
      open={mode === "drawer"}
      onOpenChange={(next) => {
        if (!next) setPanel("references", "closed");
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-w-full gap-0 p-0 data-[side=right]:w-[min(100vw,var(--drawer-w))] data-[side=right]:sm:max-w-none"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
          <SheetTitle className="flex-1 truncate text-[13px] font-semibold">
            {symbol
              ? t("references.titleFor", { symbol })
              : t("references.title")}
          </SheetTitle>
          {!loading && !error && groups.length > 0 && (
            <span className="text-[length:var(--text-caption)] text-muted-foreground">
              {t("references.summary", {
                count: String(total),
                files: String(groups.length),
              })}
            </span>
          )}
          <IconButton
            label={t("references.close")}
            onClick={() => setPanel("references", "closed")}
          >
            <X />
          </IconButton>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-3">
            {loading && (
              <p role="status" className="text-[12px] text-muted-foreground">
                {t("references.searching")}
              </p>
            )}
            {error && (
              <Badge variant="destructive">{t("references.failed")}</Badge>
            )}
            {!loading && !error && groups.length === 0 && (
              <p className="text-[12px] text-muted-foreground">
                {t("references.empty")}
              </p>
            )}
            {groups.map((group) => (
              <Group key={group.uri} group={group} />
            ))}
            {external > 0 && (
              <p className="text-[12px] text-muted-foreground">
                {t("references.external", { count: String(external) })}
              </p>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function Group({ group }: { group: ReferenceGroup }) {
  const t = useT();
  const collapsed = useReferencesStore(
    (state) => state.collapsed[group.uri] === true,
  );
  const toggle = useReferencesStore((state) => state.toggle);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={!collapsed}
        className="flex w-full min-w-0 items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5 text-left hover:bg-[var(--hover)]"
        onClick={() => toggle(group.uri)}
      >
        {collapsed ? (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {group.path}
        </span>
        <span className="shrink-0 text-[length:var(--text-caption)] text-muted-foreground">
          {group.locations.length}
        </span>
      </button>
      {!collapsed && (
        <ul className="flex flex-col">
          {group.locations.map((location, index) => {
            // LSP 的行号从 0 起，编辑器的定位接口从 1 起。
            const line = location.line + 1;
            return (
              <li key={`${location.line}:${location.character}:${index}`}>
                <button
                  type="button"
                  aria-label={t("references.open", {
                    path: group.path,
                    line: String(line),
                  })}
                  className="flex w-full min-w-0 items-start gap-2 rounded-[var(--radius-sm)] px-1 py-0.5 text-left hover:bg-[var(--hover)]"
                  onClick={() => openFileInEditor(group.path, { line })}
                >
                  <span className="w-8 shrink-0 text-right font-mono text-[length:var(--text-caption)] tabular-nums text-muted-foreground">
                    {line}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                    {location.preview ?? ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
