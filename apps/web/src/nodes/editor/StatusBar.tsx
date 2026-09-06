import { useT } from "@/app/preferences-store";
import { LanguageStatus } from "@/editor/language/LanguageStatus";
import type { LanguageClient } from "@/editor/language/client";
import type { Ownership } from "@/editor/language/documents";
import type { LoadState } from "./types";

/**
 * 状态栏（编辑器设计 §2「文件信息」）：编码、BOM、换行、只读、语言服务。
 *
 * 语言服务那一格自己有状态与操作（重启 / 停止 / 诊断计数），所以它是一个
 * 组件而不是一句话；这里只把它放在最右边。
 */
export function StatusBar({
  state,
  language,
  ownership,
  languageApplicable,
}: {
  state: Extract<LoadState, { kind: "text" }>;
  language: LanguageClient["status"] | null;
  ownership: Ownership | null;
  /** 这个文件能不能有语言会话（有内容版本、认得出语言）。 */
  languageApplicable: boolean;
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
      <LanguageStatus
        status={language}
        ownership={ownership}
        applicable={languageApplicable}
      />
    </div>
  );
}
