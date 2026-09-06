import * as React from "react";
import { X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  countDiagnostics,
  groupDiagnostics,
  severityOf,
  useDiagnosticsStore,
  type Diagnostic,
} from "@/editor/language/diagnostics-store";
import { pathOfUri } from "@/editor/language/uri";
import { openFileInEditor } from "@/files/open-editor";
import { useCanvasStore } from "@/store/canvas-store";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { SheetTitle } from "@/ui/sheet";
import { WorkPanelSheet } from "../WorkPanelSheet";

/**
 * 问题面板（语言服务设计 §1.1「诊断」、§4.2）。
 *
 * 按文件分组、点一条打开并定位。它看的是 `diagnostics-store`，而不是某个
 * 编辑器视图的 lint 状态——server 会为整个项目报诊断，其中大部分文件此刻
 * 并没有打开，只看视图就只能看到已经在眼前的那些问题。
 */
export function ProblemsPanel() {
  const t = useT();
  const mode = useCanvasStore((state) => state.panels.problems);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const byUri = useDiagnosticsStore((state) => state.byUri);

  const groups = React.useMemo(() => groupDiagnostics(byUri), [byUri]);
  const counts = React.useMemo(() => countDiagnostics(byUri), [byUri]);

  return (
    <WorkPanelSheet
      panel="problems"
      open={mode === "drawer"}
      onClose={() => setPanel("problems", "closed")}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <SheetTitle className="flex-1 truncate text-[13px] font-semibold">
          {t("problems.title")}
        </SheetTitle>
        <span className="text-[length:var(--text-caption)] text-muted-foreground">
          {t("problems.summary", {
            errors: String(counts.errors),
            warnings: String(counts.warnings),
          })}
        </span>
        <IconButton
          label={t("problems.close")}
          onClick={() => setPanel("problems", "closed")}
        >
          <X />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {groups.length === 0 && (
            <p className="text-[12px] text-muted-foreground">
              {t("problems.empty")}
            </p>
          )}
          {groups.map((group) => {
            const path = pathOfUri(group.uri);
            return (
              <div key={group.uri} className="min-w-0">
                <p className="truncate pb-1 text-[12px] font-medium">
                  {path ?? group.uri}
                </p>
                <ul className="flex flex-col">
                  {group.diagnostics.map((diagnostic, index) => (
                    <DiagnosticRow
                      key={`${diagnostic.range.start.line}:${diagnostic.range.start.character}:${index}`}
                      diagnostic={diagnostic}
                      path={path}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </WorkPanelSheet>
  );
}

const SEVERITY_COLOR = {
  error: "bg-[var(--danger)]",
  warning: "bg-[var(--warn)]",
  info: "bg-[var(--brand)]",
  hint: "bg-[var(--faint)]",
} as const;

function DiagnosticRow({
  diagnostic,
  path,
}: {
  diagnostic: Diagnostic;
  path: string | null;
}) {
  const t = useT();
  const severity = severityOf(diagnostic);
  // LSP 的行号从 0 起，编辑器的定位接口从 1 起。
  const line = diagnostic.range.start.line + 1;
  return (
    <li>
      <button
        type="button"
        disabled={!path}
        className="flex w-full min-w-0 items-start gap-2 rounded-[var(--radius-sm)] px-1 py-1 text-left hover:bg-[var(--hover)] disabled:cursor-default disabled:hover:bg-transparent"
        onClick={() => {
          if (path) openFileInEditor(path, { line });
        }}
      >
        <span
          aria-hidden
          className={`mt-1.5 size-[7px] shrink-0 rounded-full ${SEVERITY_COLOR[severity]}`}
        />
        <span className="min-w-0 flex-1 text-[12px]">
          <span className="break-words">{diagnostic.message}</span>
          <span className="pl-2 text-muted-foreground">
            {t("problems.at", { line: String(line) })}
            {diagnostic.source ? ` · ${diagnostic.source}` : ""}
            {diagnostic.code !== undefined ? ` · ${diagnostic.code}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}
