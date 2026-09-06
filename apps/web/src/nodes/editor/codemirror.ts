import type { EditorView } from "codemirror";
import type { Compartment, Extension } from "@codemirror/state";

/** 超过这个大小不进编辑器，只挂一个徽标（§3.4：内容区不放解释段落）。 */
export const MAX_EDITABLE_BYTES = 1024 * 1024;

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * 扩展名 → CodeMirror 语言支持。认不出来就纯文本。
 *
 * 七个语言包加起来比编辑器本体还大，全静态引入会把它们压进入口 chunk
 * （§17 代码分割）。这里按扩展名动态 `import()`，编辑器先以空语法起来，
 * 语言包到货后用 Compartment 热替换（见下面的 effect）。
 */
export async function loadLanguage(path: string): Promise<Extension[]> {
  switch (extensionOf(path)) {
    case "ts":
    case "tsx":
      return [
        (await import("@codemirror/lang-javascript")).javascript({
          typescript: true,
          jsx: true,
        }),
      ];
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [
        (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
      ];
    case "json":
      return [(await import("@codemirror/lang-json")).json()];
    case "md":
    case "markdown":
      return [(await import("@codemirror/lang-markdown")).markdown()];
    case "rs":
      return [(await import("@codemirror/lang-rust")).rust()];
    case "py":
      return [(await import("@codemirror/lang-python")).python()];
    case "css":
      return [(await import("@codemirror/lang-css")).css()];
    case "html":
    case "htm":
      return [(await import("@codemirror/lang-html")).html()];
    default:
      return [];
  }
}

export interface CreateEditorOptions {
  parent: HTMLElement;
  doc: string;
  readonly: boolean;
  /**
   * 文件本来的换行。CodeMirror 默认按 `/\r\n?|\n/` 切行、再用 `\n` 拼回，
   * 一个 CRLF 文件不声明 `lineSeparator` 就会在第一次保存时被悄悄改成 LF。
   */
  lineSeparator?: string;
  /** 查找/替换面板的中文文案（`EditorState.phrases`）。 */
  phrases: Record<string, string>;
  onDocChanged: (content: string) => void;
}

export interface EditorCore {
  create(options: CreateEditorOptions): {
    view: EditorView;
    language: Compartment;
    access: Compartment;
    /**
     * 语言服务的扩展槽（语言服务设计 §4.2）。会话是异步开起来的，编辑器
     * 不等它：文件先打开、能编辑，补全 / 诊断 / hover 到货后热插进来。
     */
    service: Compartment;
  };
  /** 打开查找/替换面板；替换那一半由 `EditorState.readOnly` 决定是否出现。 */
  openSearch(view: EditorView): void;
}

/** CodeMirror 内核 + 主题；只在第一次打开编辑器节点时加载一次。 */
let corePromise: Promise<EditorCore> | null = null;

export function loadEditorCore(): Promise<EditorCore> {
  corePromise ??= Promise.all([
    import("codemirror"),
    import("@codemirror/state"),
    import("@codemirror/search"),
  ]).then(
    ([
      { basicSetup, EditorView },
      { Compartment, EditorState },
      { search, openSearchPanel },
    ]) => {
      const theme = EditorView.theme(EDITOR_THEME_SPEC, { dark: true });
      return {
        create({
          parent,
          doc,
          readonly,
          lineSeparator,
          phrases,
          onDocChanged,
        }: CreateEditorOptions) {
          const language = new Compartment();
          const access = new Compartment();
          const service = new Compartment();
          const view = new EditorView({
            parent,
            state: EditorState.create({
              doc,
              extensions: [
                basicSetup,
                theme,
                // basicSetup 已经带了 searchKeymap（⌘F / ⌘⌥F），这里把
                // search 本身显式装上，才能把面板固定在顶部并给它文案。
                search({ top: true }),
                EditorState.phrases.of(phrases),
                ...(lineSeparator
                  ? [EditorState.lineSeparator.of(lineSeparator)]
                  : []),
                language.of([]),
                service.of([]),
                access.of(EditorState.readOnly.of(readonly)),
                EditorView.updateListener.of((update) => {
                  if (update.docChanged) onDocChanged(update.state.sliceDoc());
                }),
              ],
            }),
          });
          return { view, language, access, service };
        },
        openSearch(view: EditorView) {
          openSearchPanel(view);
        },
      };
    },
  );
  return corePromise;
}

/**
 * CodeMirror 查找面板的英文短语 → 界面语言。
 *
 * 面板的标签、按钮和三个开关（大小写 / 正则 / 全字）都是它自己画的，
 * 只认 `EditorState.phrases`；替换那一行在只读文档上本来就不渲染，所以
 * 「替换受只读状态约束」不需要额外一层判断。
 */
export function searchPhrases(
  t: (key: string) => string,
): Record<string, string> {
  return {
    Find: t("editor.search.find"),
    Replace: t("editor.search.replace"),
    next: t("editor.search.next"),
    previous: t("editor.search.previous"),
    all: t("editor.search.all"),
    "match case": t("editor.search.matchCase"),
    "by word": t("editor.search.byWord"),
    regexp: t("editor.search.regexp"),
    replace: t("editor.search.replaceOne"),
    "replace all": t("editor.search.replaceAll"),
    close: t("editor.search.close"),
    "current match": t("editor.search.currentMatch"),
    "replaced $ matches": t("editor.search.replacedMatches"),
    "replaced match on line $": t("editor.search.replacedOnLine"),
    "on line": t("editor.search.onLine"),
  };
}

/**
 * 把光标放到第 `line` 行（1 起）并滚过去。
 *
 * 行号来自 Runtime 的搜索结果，文件可能在那之后被改短，所以先夹到实际
 * 行数——越界的行号只该落在文件末尾，不该抛异常。
 */
export function revealLine(view: EditorView, line: number): void {
  const target = Math.min(Math.max(line, 1), view.state.doc.lines);
  const { from } = view.state.doc.line(target);
  view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
  view.focus();
}

/** 主题只写 token，不写字面色（§4.3）。传给 `EditorView.theme` 用。 */
const EDITOR_THEME_SPEC = {
  "&": {
    height: "100%",
    backgroundColor: "var(--surface-sunken)",
    color: "var(--text)",
    fontSize: "12.5px",
  },
  ".cm-content": { fontFamily: "var(--font-code)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-deep)",
    color: "var(--faint)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  ".cm-cursor": { borderLeftColor: "var(--brand)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--brand-soft)",
  },
  ".cm-scroller": { overflow: "auto" },
};
