import type { EditorView } from "codemirror";
import type { Compartment, Extension, RangeSet } from "@codemirror/state";
import type { GutterMarker, ViewUpdate } from "@codemirror/view";

import { gutterMarks, type GutterKind } from "./git-gutter";

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
  /**
   * 换一份 HEAD 的行（见 `git-gutter.ts`）；`null` 清掉行边标记。标记随后
   * 跟着编辑实时重算，调用方只在磁盘或 HEAD 可能变了的时候来一次。
   */
  setGitHead(view: EditorView, head: readonly string[] | null): void;
}

/** 按键之后等这么久再重算行边标记：连续打字时只算最后一次。 */
const GUTTER_DEBOUNCE_MS = 250;

/** CodeMirror 内核 + 主题；只在第一次打开编辑器节点时加载一次。 */
let corePromise: Promise<EditorCore> | null = null;

export function loadEditorCore(): Promise<EditorCore> {
  corePromise ??= Promise.all([
    import("codemirror"),
    import("@codemirror/state"),
    import("@codemirror/search"),
    import("@codemirror/view"),
  ]).then(
    ([
      { basicSetup, EditorView },
      {
        Compartment,
        EditorState,
        RangeSet: RangeSets,
        StateEffect,
        StateField,
      },
      { search, openSearchPanel },
      { GutterMarker: GutterMarkerBase, ViewPlugin, gutter },
    ]) => {
      const theme = EditorView.theme(EDITOR_THEME_SPEC, { dark: true });

      /* ----------------------------- Git 行边标记 ---------------------------- */

      class GitMarker extends GutterMarkerBase {
        constructor(readonly kind: GutterKind) {
          super();
        }
        override eq(other: GutterMarker): boolean {
          return other instanceof GitMarker && other.kind === this.kind;
        }
        override toDOM(): Node {
          const element = document.createElement("div");
          element.className = `cm-git-${this.kind}`;
          return element;
        }
      }
      const markers: Record<GutterKind, GitMarker> = {
        added: new GitMarker("added"),
        modified: new GitMarker("modified"),
        removed: new GitMarker("removed"),
      };
      const setHead = StateEffect.define<readonly string[] | null>();
      const setMarks = StateEffect.define<RangeSet<GutterMarker>>();
      const headField = StateField.define<readonly string[] | null>({
        create: () => null,
        update(value, transaction) {
          for (const effect of transaction.effects)
            if (effect.is(setHead)) return effect.value;
          return value;
        },
      });
      const marksField = StateField.define<RangeSet<GutterMarker>>({
        create: () => RangeSets.empty,
        update(value, transaction) {
          for (const effect of transaction.effects) {
            if (effect.is(setMarks)) return effect.value;
            if (effect.is(setHead) && effect.value === null)
              return RangeSets.empty;
          }
          // 重算之前先跟着改动挪位置，打字时标记不会先闪回原处。
          return transaction.docChanged
            ? value.map(transaction.changes)
            : value;
        },
      });
      const marksOf = (view: EditorView): RangeSet<GutterMarker> => {
        const head = view.state.field(headField);
        if (!head) return RangeSets.empty;
        const { doc } = view.state;
        // 末尾换行之后那一格空行不是一行内容，和 `linesOf` 切 HEAD 的口径一致。
        const lines = doc.toJSON().map((line) => line.replace(/\r$/, ""));
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        return RangeSets.of(
          gutterMarks(head, lines).map((mark) =>
            markers[mark.kind].range(doc.line(mark.line).from),
          ),
          true,
        );
      };
      // 重算放在更新之外：CodeMirror 不许在一次更新里再派发事务。
      const recompute = ViewPlugin.fromClass(
        class {
          timer: ReturnType<typeof setTimeout> | undefined;
          constructor(readonly view: EditorView) {}
          update(update: ViewUpdate) {
            const headChanged = update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(setHead)),
            );
            if (!headChanged && !update.docChanged) return;
            if (!this.view.state.field(headField)) return;
            clearTimeout(this.timer);
            this.timer = setTimeout(
              () =>
                this.view.dispatch({
                  effects: setMarks.of(marksOf(this.view)),
                }),
              headChanged ? 0 : GUTTER_DEBOUNCE_MS,
            );
          }
          destroy() {
            clearTimeout(this.timer);
          }
        },
      );
      const gitGutter = [
        headField,
        marksField,
        recompute,
        gutter({
          class: "cm-git-gutter",
          markers: (view) => view.state.field(marksField),
        }),
      ];
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
                gitGutter,
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
        setGitHead(view: EditorView, head: readonly string[] | null) {
          view.dispatch({ effects: setHead.of(head) });
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
 * 把光标放到第 `line` 行（1 起）、第 `column` 列（1 起，缺省行首）并滚过去。
 *
 * 行号来自 Runtime 的搜索结果或手敲的 `:行:列`，文件可能在那之后被改短，
 * 所以两个都先夹到实际范围——越界的行号只该落在文件末尾，越界的列落在
 * 行尾，都不该抛异常。
 */
export function revealLine(
  view: EditorView,
  line: number,
  column?: number,
): void {
  const target = Math.min(Math.max(line, 1), view.state.doc.lines);
  const { from, length } = view.state.doc.line(target);
  const offset =
    column === undefined ? 0 : Math.min(Math.max(column - 1, 0), length);
  view.dispatch({
    selection: { anchor: from + offset },
    scrollIntoView: true,
  });
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
  // Git 行边标记：一条细竖线，新增 / 修改 / 删除各一种颜色；删除画在被删
  // 位置的那一行顶上，因为被删的行已经不在了。
  ".cm-git-gutter .cm-gutterElement": { width: "3px", padding: "0" },
  ".cm-git-added, .cm-git-modified": { height: "100%" },
  ".cm-git-added": { backgroundColor: "var(--success)" },
  ".cm-git-modified": { backgroundColor: "var(--brand)" },
  ".cm-git-removed": { height: "3px", backgroundColor: "var(--danger)" },
};
