import { useT } from "@/app/preferences-store";
import type { LoadState } from "./types";

/**
 * 状态栏（编辑器设计 §2「文件信息」）：编码、BOM、换行、只读、语言服务。
 *
 * 语言服务永远是「LSP 未启用」——Armadra 还没有语言服务器，所以这里说的是
 * 事实，编辑器也不摆补全按钮（设计 §2、§4）。
 */
export function StatusBar({
  state,
}: {
  state: Extract<LoadState, { kind: "text" }>;
}) {
  const t = useT();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border)] px-2 py-0.5 text-[length:var(--text-caption)] text-muted-foreground">
      {state.encoding && (
        <span
          title={
            state.encoding === "unknown"
              ? t("editor.encodingReadonly")
              : undefined
          }
        >
          {t(`editor.encoding.${state.encoding}`)}
        </span>
      )}
      {state.bom && <span>{t("editor.bom")}</span>}
      {state.eol && (
        <span title={state.eol === "mixed" ? t("editor.eolMixed") : undefined}>
          {t(`editor.eol.${state.eol}`)}
        </span>
      )}
      {state.readonly && <span>{t("editor.fileReadonly")}</span>}
      <span className="ml-auto">{t("editor.lsp")}</span>
    </div>
  );
}
