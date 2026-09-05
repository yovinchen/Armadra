import * as React from "react";
// CodeMirror 内核（含 basicSetup 的一堆扩展）压缩后 ~420 kB，只有编辑器节点
// 用得上，全部走动态 `import()`（§17 代码分割）。这里只留类型引用。
import type { EditorView } from "codemirror";
import type { Compartment, Extension } from "@codemirror/state";
import {
  Columns2,
  Download,
  Eye,
  File,
  Pencil,
  Save,
  Search,
  X,
} from "lucide-react";
import type {
  FileChangeKind,
  FileEncoding,
  FileEol,
  ImportedFileInfo,
} from "@armadra/shared";

import { toast } from "sonner";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { isConflict, runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { unifiedLineDiff } from "@/lib/line-diff";
import { isTauri, openExternal } from "@/platform";
import { PatchBody } from "./DiffNode";
import { NodeShell } from "./NodeShell";
import { onEditorReveal, takePendingReveal } from "./editor-reveal";
import type { NodeBodyProps } from "./registry";

/** 超过这个大小不进编辑器，只挂一个徽标（§3.4：内容区不放解释段落）。 */
const MAX_EDITABLE_BYTES = 1024 * 1024;

function extensionOf(path: string): string {
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
async function loadLanguage(path: string): Promise<Extension[]> {
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

interface CreateEditorOptions {
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

interface EditorCore {
  create(options: CreateEditorOptions): {
    view: EditorView;
    language: Compartment;
    access: Compartment;
  };
  /** 打开查找/替换面板；替换那一半由 `EditorState.readOnly` 决定是否出现。 */
  openSearch(view: EditorView): void;
}

/** CodeMirror 内核 + 主题；只在第一次打开编辑器节点时加载一次。 */
let corePromise: Promise<EditorCore> | null = null;

function loadEditorCore(): Promise<EditorCore> {
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
                access.of(EditorState.readOnly.of(readonly)),
                EditorView.updateListener.of((update) => {
                  if (update.docChanged) onDocChanged(update.state.sliceDoc());
                }),
              ],
            }),
          });
          return { view, language, access };
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
function searchPhrases(t: (key: string) => string): Record<string, string> {
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
function revealLine(view: EditorView, line: number): void {
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

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "too-large" }
  | { kind: "image"; src: string; info: ImportedFileInfo }
  | { kind: "attachment"; info: ImportedFileInfo }
  | {
      kind: "text";
      content: string;
      size: number;
      sha256?: string;
      identity: string;
      /** Runtime 探到的编码 / BOM / 换行（E01/M4）；旧 Runtime 不给。 */
      encoding?: FileEncoding;
      bom?: boolean;
      eol?: FileEol;
      /** 文件本身不可写，与工作区权限无关。 */
      readonly?: boolean;
    };

/** 编辑区显示什么：正文、并排、纯预览。仅 Markdown 用得上。 */
type ViewMode = "edit" | "split" | "preview";

/**
 * 磁盘上这个文件的最新状态（E01/M4）。
 * `sha256` 为空表示文件已不在（`kind === "removed"`）。
 */
interface ExternalChange {
  kind: FileChangeKind;
  sha256?: string;
}

/**
 * 编辑器节点（§3.4）。阶段一用 CodeMirror 6：体积小、WebKit 兼容好。
 *
 * 保存携带已读取内容的SHA，保护同大小外部修改；旧服务无版本时只读。
 * `data.readonly` 为 true（Runtime 报告文件不可写）时降级为只读。
 *
 * 打开文本文件时向 Runtime 注册监听（E01/M4）：外部改动到达时，没有草稿就
 * 直接重载，有草稿就挂一条非模态提示条，由用户选择比较 / 重载 / 保留。
 * Runtime 说监听不可用时退回按需版本检查（窗口重新获得焦点时问一次）。
 */
export function EditorNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const data = node.data.kind === "editor" ? node.data : undefined;
  const path = data?.path ?? "";
  const workspaceId = useCanvasStore((state) => state.workspace?.id);

  const hostRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const languageRef = React.useRef<Compartment | null>(null);
  const accessRef = React.useRef<Compartment | null>(null);
  const baselineRef = React.useRef("");
  const [state, setState] = React.useState<LoadState>({ kind: "loading" });
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  /** 外部改动提示条；`null` 表示没有待处理的外部改动。 */
  const [external, setExternal] = React.useState<ExternalChange | null>(null);
  /** 「比较」打开时磁盘上的正文；`null` 表示没在比较。 */
  const [diskContent, setDiskContent] = React.useState<string | null>(null);
  /** Runtime 说这台机器没有可用的监听后端，只能按需查版本。 */
  const [degraded, setDegraded] = React.useState(false);
  /** 磁盘上这个文件的字节数，读到时记下、每次保存成功后更新（仅用于显示与旧接口兼容）。 */
  const sizeRef = React.useRef<number | undefined>(undefined);
  const versionRef = React.useRef<string | undefined>(undefined);
  /** 文件原本带 BOM，保存时要原样写回去（E01/M4）。 */
  const bomRef = React.useRef(false);
  /** Markdown 才有的编辑/并排/预览；其它文件永远是 `edit`。 */
  const [viewMode, setViewMode] = React.useState<ViewMode>("edit");
  const coreRef = React.useRef<EditorCore | null>(null);
  /** 磁盘上的文件已经没了，下一次保存按「新建」提交（不带内容版本）。 */
  const recreateRef = React.useRef(false);
  const dirtyRef = React.useRef(false);
  dirtyRef.current = dirty;
  const identity = JSON.stringify([workspaceId, path]);
  const identityRef = React.useRef(identity);
  const viewIdentityRef = React.useRef<string | null>(null);
  const pendingSaveRef = React.useRef<object | null>(null);
  if (identityRef.current !== identity) {
    identityRef.current = identity;
    pendingSaveRef.current = null;
  }

  // 内容版本是唯一的保存凭据。非 UTF-8 的文件 Runtime 不给版本（正文是
  // 有损读出来的），所以这一条同时也是「非 UTF-8 只读」的实现（E01/M4）。
  const writable =
    data?.readonly !== true &&
    state.kind === "text" &&
    state.identity === identity &&
    state.readonly !== true &&
    Boolean(state.sha256);
  const writableRef = React.useRef(writable);
  writableRef.current = writable;

  /* --------------------------------- 读取 --------------------------------- */

  React.useEffect(() => {
    if (!workspaceId || !path) return;
    let cancelled = false;
    let imageUrl: string | null = null;
    const controller = new AbortController();
    setState({ kind: "loading" });
    setSaving(false);
    setDirty(false);
    setExternal(null);
    setDiskContent(null);
    setDegraded(false);
    setViewMode("edit");
    versionRef.current = undefined;
    recreateRef.current = false;
    bomRef.current = false;
    void (async () => {
      const info = await runtimeApi.fileInfo(workspaceId, path);
      if (cancelled) return;
      if (info.preview === "image") {
        const response = await fetch(
          runtimeApi.fileDownloadUrl(workspaceId, path),
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Image download failed");
        const blob = await response.blob();
        if (cancelled) return;
        imageUrl = URL.createObjectURL(
          new Blob([blob], { type: info.mimeType }),
        );
        setState({ kind: "image", src: imageUrl, info });
        return;
      }
      if (info.preview !== "text") {
        setState({ kind: "attachment", info });
        return;
      }
      const file = await runtimeApi.readFile(workspaceId, path);
      if (cancelled) return;
      if (file.size > MAX_EDITABLE_BYTES) {
        setState({ kind: "attachment", info });
        return;
      }
      sizeRef.current = file.size;
      versionRef.current = file.sha256;
      bomRef.current = file.bom === true;
      baselineRef.current = file.content;
      setState({
        kind: "text",
        content: file.content,
        size: file.size,
        sha256: file.sha256,
        identity,
        encoding: file.encoding,
        bom: file.bom,
        eol: file.eol,
        readonly: file.readonly,
      });
    })().catch(() => {
      if (!cancelled) setState({ kind: "error" });
    });
    return () => {
      cancelled = true;
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [path, workspaceId]);

  /* ------------------------------ CodeMirror ------------------------------ */

  React.useEffect(() => {
    if (state.kind !== "text" || state.identity !== identity) return;
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let created: EditorView | null = null;
    const content = state.content;
    const eol = state.eol;

    void loadEditorCore().then((core) => {
      if (cancelled) return;
      coreRef.current = core;
      const { view, language, access } = core.create({
        parent: host,
        doc: content,
        readonly: !writableRef.current,
        // CRLF 文件必须声明分隔符，否则 `doc.toString()` 会把换行统一成
        // LF，一次保存就把整份文件改了（E01/M4）。`mixed` 无法原样还原，
        // 走默认的 LF，状态栏会把这件事说出来。
        lineSeparator: eol === "crlf" ? "\r\n" : undefined,
        phrases: searchPhrases(t),
        onDocChanged: (content) => setDirty(content !== baselineRef.current),
      });
      created = view;
      viewRef.current = view;
      viewIdentityRef.current = identity;
      languageRef.current = language;
      accessRef.current = access;
      setDirty(false);
      // 搜索面板开着这个文件时排队的「打开到行」，挂载后自己来取。
      const line = takePendingReveal(path);
      if (line !== undefined) revealLine(view, line);

      // 语言包异步到货后热替换语法；编辑器本身不重建，光标和撤销栈都不受影响。
      void loadLanguage(path).then((extensions) => {
        if (cancelled || !extensions.length) return;
        view.dispatch({ effects: language.reconfigure(extensions) });
      });
    });

    return () => {
      cancelled = true;
      created?.destroy();
      if (viewRef.current === created) {
        viewRef.current = null;
        viewIdentityRef.current = null;
      }
      languageRef.current = null;
      accessRef.current = null;
    };
    // `t` 只决定查找面板的初始文案，切语言不该重建编辑器（会丢光标与撤销栈）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, state, identity]);

  // 项目搜索点一条命中：文件已经开着就直接滚过去。
  React.useEffect(() => {
    return onEditorReveal((revealedPath) => {
      if (revealedPath !== path) return;
      const view = viewRef.current;
      if (!view || viewIdentityRef.current !== identity) return;
      const line = takePendingReveal(path);
      if (line !== undefined) revealLine(view, line);
    });
  }, [identity, path]);

  React.useEffect(() => {
    let cancelled = false;
    void import("@codemirror/state").then(({ EditorState }) => {
      if (
        !cancelled &&
        viewRef.current &&
        accessRef.current &&
        viewIdentityRef.current === identity
      ) {
        viewRef.current.dispatch({
          effects: accessRef.current.reconfigure(
            EditorState.readOnly.of(!writable),
          ),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [writable, identity]);

  /* ------------------------------ 外部改动监听 ----------------------------- */

  const watching = state.kind === "text" && state.identity === identity;

  /** 用磁盘上的正文替换编辑器内容；不重建视图，撤销栈和滚动位置都保留。 */
  const reload = React.useCallback(async () => {
    if (!workspaceId || !path) return;
    const file = await runtimeApi.readFile(workspaceId, path);
    if (identityRef.current !== identity) return;
    baselineRef.current = file.content;
    sizeRef.current = file.size;
    versionRef.current = file.sha256;
    bomRef.current = file.bom === true;
    recreateRef.current = false;
    const view = viewRef.current;
    if (view && viewIdentityRef.current === identity)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: file.content },
      });
    setDirty(false);
    setExternal(null);
    setDiskContent(null);
  }, [identity, path, workspaceId]);

  /** 一次外部改动：没有草稿就直接重载并提示，有草稿交给用户决定。 */
  const applyExternal = React.useCallback(
    (change: ExternalChange) => {
      // 我们自己刚写下去的内容不是外部改动。Runtime 已经按写前登记的哈希
      // 拦过一层，这里再按当前内容版本兜一次，节点绝不为自己的保存报警。
      if (change.sha256 && change.sha256 === versionRef.current) return;
      if (change.kind === "removed" || dirtyRef.current) {
        setExternal(change);
        return;
      }
      void reload().then(
        () => toast(t("editor.reloaded")),
        () => setExternal(change),
      );
    },
    [reload, t],
  );

  React.useEffect(() => {
    if (!workspaceId || !path || !watching) return;
    let cancelled = false;
    void runtimeApi
      .watchFile(workspaceId, path, id)
      .then((registration) => {
        if (cancelled) return;
        setDegraded(registration.status === "unsupported");
        // 读取和注册之间也可能被改过，注册的回答就是那一刻的磁盘版本。
        const version = registration.version;
        if (
          version.exists &&
          version.sha256 &&
          version.sha256 !== versionRef.current
        )
          applyExternal({ kind: "modified", sha256: version.sha256 });
      })
      .catch(() => {
        // 旧 Runtime 没有这条路由：当作不可监听，退回按需检查。
        if (!cancelled) setDegraded(true);
      });
    const off = onWorkspaceEvent("file.changed", (event) => {
      if (event.workspaceId !== workspaceId || event.path !== path) return;
      applyExternal({ kind: event.kind, sha256: event.sha256 ?? undefined });
    });
    return () => {
      cancelled = true;
      off();
      void runtimeApi.unwatchFile(workspaceId, path, id).catch(() => undefined);
    };
  }, [applyExternal, id, path, watching, workspaceId]);

  // 监听不可用时的退化路径：窗口重新获得焦点才问一次版本，不做轮询。
  React.useEffect(() => {
    if (!degraded || !watching || !workspaceId || !path) return;
    const check = () => {
      void runtimeApi
        .fileVersion(workspaceId, path)
        .then((version) => {
          if (identityRef.current !== identity) return;
          if (!version.exists) {
            if (versionRef.current !== undefined)
              applyExternal({ kind: "removed" });
          } else if (version.sha256 && version.sha256 !== versionRef.current)
            applyExternal({ kind: "modified", sha256: version.sha256 });
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [applyExternal, degraded, identity, path, watching, workspaceId]);

  const compare = React.useCallback(() => {
    if (!workspaceId || !path) return;
    void runtimeApi
      .readFile(workspaceId, path)
      .then((file) => {
        if (identityRef.current === identity) setDiskContent(file.content);
      })
      // 文件已经不在了：拿空正文比，整份草稿显示为新增。
      .catch(() => {
        if (identityRef.current === identity) setDiskContent("");
      });
  }, [identity, path, workspaceId]);

  /**
   * 保留草稿：把最新的磁盘版本当作保存令牌，下一次保存就覆盖这次外部改动；
   * 文件已被删除时改成「新建」提交。之后磁盘再变，Runtime 仍会 409 再提示。
   */
  const keepDraft = React.useCallback(() => {
    if (!external) return;
    if (external.kind === "removed") {
      versionRef.current = undefined;
      recreateRef.current = true;
    } else if (external.sha256) {
      versionRef.current = external.sha256;
      recreateRef.current = false;
    }
    setExternal(null);
    setDiskContent(null);
  }, [external]);

  /* --------------------------------- 保存 --------------------------------- */

  const save = React.useCallback(async () => {
    const view = viewRef.current;
    if (
      !view ||
      !workspaceId ||
      !writable ||
      pendingSaveRef.current ||
      viewIdentityRef.current !== identity ||
      // 没有内容版本只有一种情况可以保存：文件被外部删除后用户选了保留草稿，
      // 这一次按「新建」提交，别的写者抢先建了同名文件仍然会 409。
      (!versionRef.current && !recreateRef.current)
    )
      return;
    const submitted = view.state.sliceDoc();
    const token = {};
    pendingSaveRef.current = token;
    setSaving(true);
    try {
      const result = await runtimeApi.writeFile(
        workspaceId,
        path,
        submitted,
        sizeRef.current,
        versionRef.current,
        // 文件本来带 BOM 就写回去；不带就绝不新增一个。
        bomRef.current,
      );
      if (identityRef.current !== identity || viewRef.current !== view) return;
      // 只更新基准大小，不重建编辑器：重建会丢光标和撤销栈。
      sizeRef.current = result.size;
      versionRef.current = result.sha256;
      recreateRef.current = false;
      baselineRef.current = submitted;
      setDirty(view.state.sliceDoc() !== submitted);
      setExternal(null);
    } catch (error) {
      if (identityRef.current !== identity) return;
      toast.error(
        isConflict(error) ? t("editor.conflict") : t("editor.saveFailed"),
      );
      // 冲突就是「磁盘上又变了」：把当前版本取回来，重新挂提示条。
      if (isConflict(error) && workspaceId)
        void runtimeApi
          .fileVersion(workspaceId, path)
          .then((version) => {
            if (identityRef.current !== identity) return;
            setExternal({
              kind: version.exists ? "modified" : "removed",
              sha256: version.sha256 ?? undefined,
            });
          })
          .catch(() => undefined);
    } finally {
      if (pendingSaveRef.current === token) {
        pendingSaveRef.current = null;
        if (identityRef.current === identity) setSaving(false);
      }
    }
  }, [path, identity, workspaceId, writable]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    },
    [save],
  );

  /* --------------------------------- 渲染 --------------------------------- */

  const markdown = ["md", "markdown"].includes(extensionOf(path));
  const showEditor = viewMode !== "preview";
  const showPreview = markdown && viewMode !== "edit";
  /** 预览用的正文：编辑器已经起来就用它的实时内容，否则用刚读到的。 */
  const previewSource =
    viewRef.current && viewIdentityRef.current === identity
      ? viewRef.current.state.sliceDoc()
      : state.kind === "text"
        ? state.content
        : "";

  const headerActions = (
    <>
      {state.kind === "text" && !state.sha256 && (
        <Badge variant="outline">
          {state.encoding === "unknown"
            ? t("editor.encodingReadonly")
            : t("editor.versionRequired")}
        </Badge>
      )}
      {degraded && state.kind === "text" && (
        <Badge variant="outline">{t("editor.watchUnsupported")}</Badge>
      )}
      {dirty && (
        <span
          aria-label={t("editor.dirty")}
          title={t("editor.dirty")}
          className="size-[7px] shrink-0 rounded-full bg-[var(--warn)]"
        />
      )}
      {state.kind === "text" && (
        <IconButton
          label={t("editor.find")}
          onClick={() => {
            const view = viewRef.current;
            if (view && coreRef.current) coreRef.current.openSearch(view);
          }}
        >
          <Search />
        </IconButton>
      )}
      {markdown && state.kind === "text" && (
        <IconButton
          label={t(
            viewMode === "edit"
              ? "editor.preview"
              : viewMode === "split"
                ? "editor.previewSplit"
                : "editor.previewEdit",
          )}
          active={viewMode !== "edit"}
          onClick={() =>
            setViewMode((current) =>
              current === "edit"
                ? "split"
                : current === "split"
                  ? "preview"
                  : "edit",
            )
          }
        >
          {viewMode === "edit" ? (
            <Eye />
          ) : viewMode === "split" ? (
            <Columns2 />
          ) : (
            <Pencil />
          )}
        </IconButton>
      )}
      {writable && state.kind === "text" && (
        <IconButton
          label={t("editor.save")}
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          <Save />
        </IconButton>
      )}
    </>
  );

  return (
    <NodeShell node={node} selected={selected} headerActions={headerActions}>
      <div className="h-full w-full overflow-hidden" onKeyDown={onKeyDown}>
        {state.kind === "too-large" && (
          <Centered>
            <Badge variant="outline">{t("editor.tooLarge")}</Badge>
          </Centered>
        )}
        {state.kind === "error" && (
          <Centered>
            <Badge variant="destructive">{t("editor.failed")}</Badge>
          </Centered>
        )}
        {state.kind === "attachment" && workspaceId && (
          <div className="flex h-full min-w-0 flex-col items-center justify-center gap-3 overflow-auto p-5 text-center">
            <File
              aria-hidden
              className="size-8 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0 max-w-full">
              <p className="break-all text-sm font-medium">{state.info.name}</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {formatBytes(state.info.size)} · {state.info.mimeType}
              </p>
            </div>
            <Button variant="secondary" size="sm" asChild>
              <a
                href={runtimeApi.fileDownloadUrl(workspaceId, path)}
                download={state.info.name}
                onClick={(event) => {
                  if (!isTauri()) return;
                  event.preventDefault();
                  void openExternal(
                    runtimeApi.fileDownloadUrl(workspaceId, path),
                  );
                }}
              >
                <Download />
                {t("editor.download")}
              </a>
            </Button>
          </div>
        )}
        {state.kind === "image" && (
          <img
            src={state.src}
            onError={() => {
              URL.revokeObjectURL(state.src);
              setState((current) =>
                current.kind === "image" && current.src === state.src
                  ? { kind: "attachment", info: current.info }
                  : current,
              );
            }}
            alt={node.title}
            draggable={false}
            className="h-full w-full object-contain"
          />
        )}
        {state.kind === "text" && (
          <div className="flex h-full w-full flex-col overflow-hidden">
            {external && (
              <ExternalBar
                change={external}
                onCompare={compare}
                onReload={() => void reload().catch(() => undefined)}
                onKeep={keepDraft}
              />
            )}
            <div className="relative flex min-h-0 flex-1">
              {/* 预览模式下编辑器只是隐藏，不卸载：草稿、光标和撤销栈都留着。 */}
              <div
                ref={hostRef}
                className={cn(
                  "h-full min-w-0 overflow-hidden",
                  showEditor ? "flex-1" : "hidden",
                )}
              />
              {showPreview && (
                <MarkdownPreview
                  source={previewSource}
                  workspaceId={workspaceId}
                  path={path}
                  bordered={showEditor}
                />
              )}
              {diskContent !== null && (
                <ComparePanel
                  patch={unifiedLineDiff(
                    diskContent,
                    viewRef.current?.state.sliceDoc() ?? "",
                  )}
                  onClose={() => setDiskContent(null)}
                />
              )}
            </div>
            <StatusBar state={state} />
          </div>
        )}
      </div>
    </NodeShell>
  );
}

/**
 * 外部改动提示条：非模态，不挡编辑区，三个选择都留给用户。
 * 文件被删除时没有可比较也没有可重载的磁盘版本，只剩「保留草稿」。
 */
function ExternalBar({
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

/** 磁盘版 → 草稿的差异，着色复用变更节点的 `PatchBody`。 */
function ComparePanel({
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

/**
 * Markdown 预览（编辑器设计 §4：不执行脚本，HTML 经清理）。
 *
 * `react-markdown` 默认就不渲染裸 HTML——这里刻意不装 `rehype-raw`，所以
 * 文档里的 `<script>` / `<img onerror>` 只会以文本出现。另外两条：
 *
 *  * 图片的相对路径经 Runtime 的文件读取接口取，不让页面直接摸文件系统，
 *    也不让一份 Markdown 把绝对路径变成外部请求；
 *  * 链接一律 `noreferrer`，且只放行 http/https 与文档内锚点——`javascript:`
 *    在这里就是一段没用的文本。
 */
function MarkdownPreview({
  source,
  workspaceId,
  path,
  bordered,
}: {
  source: string;
  workspaceId: string | undefined;
  path: string;
  bordered: boolean;
}) {
  const directory = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/"))
    : "";

  const resolve = React.useCallback(
    (source: string | undefined): string | undefined => {
      if (!source || !workspaceId) return undefined;
      if (/^(https?:|data:)/i.test(source)) return source;
      // `/a.png` 在工作区里就是根下的 a.png；`../` 交给 Runtime 拒绝。
      const relative = source.replace(/^\/+/, "");
      const joined =
        source.startsWith("/") || !directory
          ? relative
          : `${directory}/${relative}`;
      return runtimeApi.fileDownloadUrl(workspaceId, joined);
    },
    [directory, workspaceId],
  );

  return (
    <ScrollArea
      className={cn(
        "min-w-0 flex-1 bg-[var(--surface-sunken)]",
        bordered && "border-l border-[var(--border)]",
      )}
    >
      <div className="sticky-markdown p-3 text-[12.5px] leading-relaxed">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            img: ({ src, alt }) => (
              <img
                src={resolve(typeof src === "string" ? src : undefined)}
                alt={alt ?? ""}
              />
            ),
            a: ({ href, children }) => (
              <a
                href={
                  typeof href === "string" && /^(https?:|#)/i.test(href)
                    ? href
                    : undefined
                }
                target="_blank"
                rel="noreferrer noopener"
              >
                {children}
              </a>
            ),
          }}
        >
          {source}
        </Markdown>
      </div>
    </ScrollArea>
  );
}

/**
 * 状态栏（编辑器设计 §2「文件信息」）：编码、BOM、换行、只读、语言服务。
 *
 * 语言服务永远是「LSP 未启用」——Armadra 还没有语言服务器，所以这里说的是
 * 事实，编辑器也不摆补全按钮（设计 §2、§4）。
 */
function StatusBar({ state }: { state: Extract<LoadState, { kind: "text" }> }) {
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      {children}
    </div>
  );
}
