import * as React from "react";
// CodeMirror 内核（含 basicSetup 的一堆扩展）压缩后 ~420 kB，只有编辑器节点
// 用得上，全部走动态 `import()`（§17 代码分割）。这里只留类型引用。
import type { EditorView } from "codemirror";
import type { Compartment, Extension } from "@codemirror/state";
import { Download, File, Save } from "lucide-react";
import type { ImportedFileInfo } from "@armadra/shared";

import { toast } from "sonner";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { isConflict, runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/app/preferences-store";
import { formatBytes } from "@/lib/format";
import { isTauri, openExternal } from "@/platform";
import { NodeShell } from "./NodeShell";
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
  onDocChanged: () => void;
}

interface EditorCore {
  create(options: CreateEditorOptions): {
    view: EditorView;
    language: Compartment;
  };
}

/** CodeMirror 内核 + 主题；只在第一次打开编辑器节点时加载一次。 */
let corePromise: Promise<EditorCore> | null = null;

function loadEditorCore(): Promise<EditorCore> {
  corePromise ??= Promise.all([
    import("codemirror"),
    import("@codemirror/state"),
  ]).then(([{ basicSetup, EditorView }, { Compartment, EditorState }]) => {
    const theme = EditorView.theme(EDITOR_THEME_SPEC, { dark: true });
    return {
      create({ parent, doc, readonly, onDocChanged }: CreateEditorOptions) {
        const language = new Compartment();
        const view = new EditorView({
          parent,
          state: EditorState.create({
            doc,
            extensions: [
              basicSetup,
              theme,
              language.of([]),
              EditorState.readOnly.of(readonly),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) onDocChanged();
              }),
            ],
          }),
        });
        return { view, language };
      },
    };
  });
  return corePromise;
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
  | { kind: "image"; src: string }
  | { kind: "attachment"; info: ImportedFileInfo }
  | { kind: "text"; content: string; size: number };

/**
 * 编辑器节点（§3.4）。阶段一用 CodeMirror 6：体积小、WebKit 兼容好。
 *
 * 保存走 `PUT /file`，带上读到时的字节数作乐观锁：文件在编辑期间被 Agent
 * 改过，Runtime 返 409，这里提示"文件已被修改"而不是把对方的改动盖掉。
 * `data.readonly` 为 true（Runtime 报告文件不可写）时降级为只读。
 */
export function EditorNode({ node, selected }: NodeBodyProps) {
  const t = useT();
  const data = node.data.kind === "editor" ? node.data : undefined;
  const path = data?.path ?? "";
  const workspaceId = useCanvasStore((state) => state.workspace?.id);

  const hostRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const languageRef = React.useRef<Compartment | null>(null);
  const [state, setState] = React.useState<LoadState>({ kind: "loading" });
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  /** 磁盘上这个文件的字节数，读到时记下、每次保存成功后更新（CAS 令牌）。 */
  const sizeRef = React.useRef<number | undefined>(undefined);

  const writable = data?.readonly !== true;

  /* --------------------------------- 读取 --------------------------------- */

  React.useEffect(() => {
    if (!workspaceId || !path) return;
    let cancelled = false;
    let imageUrl: string | null = null;
    const controller = new AbortController();
    setState({ kind: "loading" });
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
        setState({ kind: "image", src: imageUrl });
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
      setState({ kind: "text", content: file.content, size: file.size });
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
    if (state.kind !== "text") return;
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let created: EditorView | null = null;
    const content = state.content;

    void loadEditorCore().then((core) => {
      if (cancelled) return;
      const { view, language } = core.create({
        parent: host,
        doc: content,
        readonly: !writable,
        onDocChanged: () => setDirty(true),
      });
      created = view;
      viewRef.current = view;
      languageRef.current = language;
      setDirty(false);

      // 语言包异步到货后热替换语法；编辑器本身不重建，光标和撤销栈都不受影响。
      void loadLanguage(path).then((extensions) => {
        if (cancelled || !extensions.length) return;
        view.dispatch({ effects: language.reconfigure(extensions) });
      });
    });

    return () => {
      cancelled = true;
      created?.destroy();
      if (viewRef.current === created) viewRef.current = null;
      languageRef.current = null;
    };
  }, [path, state, writable]);

  /* --------------------------------- 保存 --------------------------------- */

  const save = React.useCallback(async () => {
    const view = viewRef.current;
    if (!view || !workspaceId || !writable || saving) return;
    setSaving(true);
    try {
      const result = await runtimeApi.writeFile(
        workspaceId,
        path,
        view.state.doc.toString(),
        sizeRef.current,
      );
      // 只更新基准大小，不重建编辑器：重建会丢光标和撤销栈。
      sizeRef.current = result.size;
      setDirty(false);
    } catch (error) {
      toast.error(
        isConflict(error) ? t("editor.conflict") : t("editor.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }, [path, saving, workspaceId, writable]);

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

  const headerActions = (
    <>
      {dirty && (
        <span
          aria-label={t("editor.dirty")}
          title={t("editor.dirty")}
          className="size-[7px] shrink-0 rounded-full bg-[var(--warn)]"
        />
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
            alt={node.title}
            draggable={false}
            className="h-full w-full object-contain"
          />
        )}
        {state.kind === "text" && (
          <div ref={hostRef} className="h-full w-full overflow-hidden" />
        )}
      </div>
    </NodeShell>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      {children}
    </div>
  );
}
