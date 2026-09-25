import * as React from "react";
import type { EditorView } from "codemirror";
import {
  Columns2,
  Download,
  Eye,
  File,
  GitMerge,
  Lightbulb,
  Pencil,
  Save,
  Search,
} from "lucide-react";
import type { WatchMode } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { unifiedLineDiff } from "@/lib/line-diff";
import { isDesktop, openExternal } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DropdownMenuItem } from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { NodeShell } from "./NodeShell";
import { onEditorReveal, takePendingReveal } from "./editor-reveal";
import type { NodeBodyProps } from "./registry";
import { Centered } from "./editor/Centered";
import { ComparePanel } from "./editor/ComparePanel";
import { ExternalBar } from "./editor/ExternalBar";
import { MarkdownPreview } from "./editor/MarkdownPreview";
import { MediaPreview } from "./editor/MediaPreview";
import { StatusBar } from "./editor/StatusBar";
import {
  MAX_EDITABLE_BYTES,
  extensionOf,
  loadEditorCore,
  loadLanguage,
  revealLine,
  searchPhrases,
} from "./editor/codemirror";
import { useEditorRefs } from "./editor/refs";
import type { ExternalChange, LoadState, ViewMode } from "./editor/types";
import { useExternalChanges } from "./editor/use-external-changes";
import { useEditorKeybindings } from "./editor/use-editor-keys";
import { useFileSave } from "./editor/use-save";
import { useLanguageService } from "@/editor/language/use-language";
import { languageIdFor } from "@/editor/language/language-ids";
import { hasConflictMarkers, openMergeView } from "@/editor/merge/conflict";

/**
 * 文件编辑器节点（编辑器设计 §2–§4）。
 *
 * 这个组件只做装配：CodeMirror 的加载与主题在 `editor/codemirror.ts`，可变
 * 引用在 `editor/refs.ts`，外部改动与保存各是一个 hook，提示条 / 预览 /
 * 比较面板 / 状态栏各是一个子组件。
 */
export function EditorNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const data = node.data.kind === "editor" ? node.data : undefined;
  const path = data?.path ?? "";
  const workspaceId = useCanvasStore((state) => state.workspace?.id);

  const [state, setState] = React.useState<LoadState>({ kind: "loading" });
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  /** 外部改动提示条；`null` 表示没有待处理的外部改动。 */
  const [external, setExternal] = React.useState<ExternalChange | null>(null);
  /** 「比较」打开时磁盘上的正文；`null` 表示没在比较。 */
  const [diskContent, setDiskContent] = React.useState<string | null>(null);
  /** Runtime 说这台机器没有可用的监听后端，只能按需查版本。 */
  const [degraded, setDegraded] = React.useState(false);
  /**
   * 改动怎么送过来。远程执行主机上可能是轮询而不是文件系统事件，延迟不是一
   * 回事，所以在头部标出来，而不是让人以为远端和本地一样快。
   */
  const [watchMode, setWatchMode] = React.useState<WatchMode>("events");
  const [watchReason, setWatchReason] = React.useState<string | null>(null);
  /** Markdown 才有的编辑/并排/预览；其它文件永远是 `edit`。 */
  const [viewMode, setViewMode] = React.useState<ViewMode>("edit");
  /** 每重建一次 CodeMirror 就自增：语言扩展要重新插一遍。 */
  const [viewGeneration, setViewGeneration] = React.useState(0);

  const identity = JSON.stringify([workspaceId, path]);
  const refs = useEditorRefs(identity);
  refs.dirtyRef.current = dirty;

  // 内容版本是唯一的保存凭据。非 UTF-8 的文件 Runtime 不给版本（正文是
  // 有损读出来的），所以这一条同时也是「非 UTF-8 只读」的实现（E01/M4）。
  const writable =
    data?.readonly !== true &&
    state.kind === "text" &&
    state.identity === identity &&
    state.readonly !== true &&
    Boolean(state.sha256);
  refs.writableRef.current = writable;

  /* --------------------------------- 读取 --------------------------------- */

  React.useEffect(() => {
    if (!workspaceId || !path) return;
    let cancelled = false;
    let mediaUrl: string | null = null;
    const controller = new AbortController();
    setState({ kind: "loading" });
    setSaving(false);
    setDirty(false);
    setExternal(null);
    setDiskContent(null);
    setDegraded(false);
    setViewMode("edit");
    refs.versionRef.current = undefined;
    refs.recreateRef.current = false;
    refs.bomRef.current = false;
    void (async () => {
      const info = await runtimeApi.fileInfo(workspaceId, path);
      if (cancelled) return;
      if (
        info.preview === "image" ||
        info.preview === "video" ||
        info.preview === "audio" ||
        info.preview === "pdf"
      ) {
        const response = await fetch(
          runtimeApi.fileDownloadUrl(workspaceId, path),
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Media download failed");
        const blob = await response.blob();
        if (cancelled) return;
        // 下载路由永远回 octet-stream；类型在这里按 Runtime 报的 MIME 补上，
        // 引擎才知道该用哪个播放器或查看器。
        mediaUrl = URL.createObjectURL(
          new Blob([blob], { type: info.mimeType }),
        );
        setState({ kind: "media", media: info.preview, src: mediaUrl, info });
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
      refs.sizeRef.current = file.size;
      refs.versionRef.current = file.sha256;
      refs.bomRef.current = file.bom === true;
      refs.baselineRef.current = file.content;
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
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    };
  }, [path, workspaceId]);

  /* ------------------------------ CodeMirror ------------------------------ */

  React.useEffect(() => {
    if (state.kind !== "text" || state.identity !== identity) return;
    const host = refs.hostRef.current;
    if (!host) return;

    let cancelled = false;
    let created: EditorView | null = null;
    const content = state.content;
    const eol = state.eol;

    void loadEditorCore().then((core) => {
      if (cancelled) return;
      refs.coreRef.current = core;
      const { view, language, access, service } = core.create({
        parent: host,
        doc: content,
        readonly: !refs.writableRef.current,
        // CRLF 文件必须声明分隔符，否则 `doc.toString()` 会把换行统一成
        // LF，一次保存就把整份文件改了（E01/M4）。`mixed` 无法原样还原，
        // 走默认的 LF，状态栏会把这件事说出来。
        lineSeparator: eol === "crlf" ? "\r\n" : undefined,
        phrases: searchPhrases(t),
        onDocChanged: (content) =>
          setDirty(content !== refs.baselineRef.current),
      });
      created = view;
      refs.viewRef.current = view;
      refs.viewIdentityRef.current = identity;
      refs.languageRef.current = language;
      refs.accessRef.current = access;
      refs.serviceRef.current = service;
      setDirty(false);
      setViewGeneration((generation) => generation + 1);
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
      if (refs.viewRef.current === created) {
        refs.viewRef.current = null;
        refs.viewIdentityRef.current = null;
      }
      refs.languageRef.current = null;
      refs.accessRef.current = null;
      refs.serviceRef.current = null;
    };
    // `t` 只决定查找面板的初始文案，切语言不该重建编辑器（会丢光标与撤销栈）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, state, identity]);

  // 项目搜索点一条命中：文件已经开着就直接滚过去。
  React.useEffect(() => {
    return onEditorReveal((revealedPath) => {
      if (revealedPath !== path) return;
      const view = refs.viewRef.current;
      if (!view || refs.viewIdentityRef.current !== identity) return;
      const line = takePendingReveal(path);
      if (line !== undefined) revealLine(view, line);
    });
  }, [identity, path]);

  React.useEffect(() => {
    let cancelled = false;
    void import("@codemirror/state").then(({ EditorState }) => {
      if (
        !cancelled &&
        refs.viewRef.current &&
        refs.accessRef.current &&
        refs.viewIdentityRef.current === identity
      ) {
        refs.viewRef.current.dispatch({
          effects: refs.accessRef.current.reconfigure(
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

  const { reload, compare, keepDraft } = useExternalChanges(refs, {
    id,
    path,
    workspaceId,
    identity,
    watching: state.kind === "text" && state.identity === identity,
    degraded,
    external,
    setDirty,
    setExternal,
    setDiskContent,
    setDegraded,
    setWatchMode,
    setWatchReason,
  });

  /* ------------------------------- 语言服务 ------------------------------- */

  // 有内容版本才开会话：没有版本的文件（非 UTF-8、超过 1 MiB）Runtime 给
  // 不出可核对的正文，状态栏说「LSP 不适用」而不是开一条会话（§2.3）。
  const languageEligible =
    state.kind === "text" &&
    state.identity === identity &&
    Boolean(state.sha256) &&
    languageIdFor(path) !== null;

  const language = useLanguageService({
    nodeId: id,
    path,
    workspaceId,
    identity,
    eligible: languageEligible,
    dirty,
    sha256: state.kind === "text" ? state.sha256 : undefined,
    viewRef: refs.viewRef,
    viewIdentityRef: refs.viewIdentityRef,
    serviceRef: refs.serviceRef,
    viewGeneration,
  });

  /* --------------------------------- 保存 --------------------------------- */

  const [keyboardRoot, setKeyboardRoot] = React.useState<HTMLElement | null>(
    null,
  );

  const { save } = useFileSave(refs, {
    path,
    workspaceId,
    identity,
    writable,
    setDirty,
    setSaving,
    setExternal,
    beforeSave: language.beforeSave,
    afterSave: language.afterSave,
  });

  // 编辑器内部的五条键位（`editor` 作用域）。监听器装在这个节点自己的根元素
  // 上，所以同时开着的几个编辑器节点里只有键盘所在的那个会响应。
  useEditorKeybindings({
    root: keyboardRoot,
    view: refs.viewRef.current,
    save: () => void save(),
  });

  /* --------------------------------- 渲染 --------------------------------- */

  const markdown = ["md", "markdown"].includes(extensionOf(path));
  const showEditor = viewMode !== "preview";
  const showPreview = markdown && viewMode !== "edit";
  /** 预览用的正文：编辑器已经起来就用它的实时内容，否则用刚读到的。 */
  const previewSource =
    refs.viewRef.current && refs.viewIdentityRef.current === identity
      ? refs.viewRef.current.state.sliceDoc()
      : state.kind === "text"
        ? state.content
        : "";

  /**
   * 这个文件里有 Git 冲突标记。判断只看已经读进来的正文，不额外问 Git：
   * 合并入口出现的条件应该和「打开它就看得见 `<<<<<<<`」完全一致，而三份
   * 原文要等真的打开合并视图时再去索引里取。
   */
  const conflicted =
    state.kind === "text" &&
    state.identity === identity &&
    hasConflictMarkers(state.content);

  /**
   * 头部只留「一眼要看到」的状态与两个常按的控件（F5：所有节点头部一个样）。
   * 脏点说的是「有没有没存的东西」，预览挡是写 Markdown 时一直在切的，保存
   * 有它自己的快捷键但也必须看得见；其余命令进 `···`。
   */
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
      {!degraded && watchMode === "poll" && state.kind === "text" && (
        <Badge variant="outline" title={watchReason ?? undefined}>
          {t("ssh.execution.poll")}
        </Badge>
      )}
      {dirty && (
        <span
          aria-label={t("editor.dirty")}
          title={t("editor.dirty")}
          className="size-[7px] shrink-0 rounded-full bg-[var(--warn)]"
        />
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

  const menuItems = (
    <>
      {state.kind === "text" && (
        <DropdownMenuItem
          onSelect={() => {
            const view = refs.viewRef.current;
            if (view && refs.coreRef.current)
              refs.coreRef.current.openSearch(view);
          }}
        >
          <Search />
          {t("editor.find")}
        </DropdownMenuItem>
      )}
      {/* 代码操作没有别的入口：⌘. 要先把焦点放进编辑器，而一块画布上的
          编辑器常常还没有焦点。只在会话真的在跑时出现。 */}
      {language.status?.state === "running" && state.kind === "text" && (
        <DropdownMenuItem
          onSelect={() => {
            const view = refs.viewRef.current;
            if (!view || refs.viewIdentityRef.current !== identity) return;
            view.focus();
            void import("@/editor/language/code-actions").then((module) =>
              module.showCodeActions(view),
            );
          }}
        >
          <Lightbulb />
          {t("lsp.action.title")}
        </DropdownMenuItem>
      )}
      {conflicted && writable && workspaceId && (
        <DropdownMenuItem
          // 编辑器节点拿到的是工作空间相对路径，也就是根检出里的路径。
          onSelect={() => void openMergeView(workspaceId, path, ".")}
        >
          <GitMerge />
          {t("merge.open")}
        </DropdownMenuItem>
      )}
    </>
  );

  return (
    <NodeShell
      node={node}
      selected={selected}
      headerActions={headerActions}
      menuItems={menuItems}
    >
      {/*
       * `data-keybinding-scope` 是 `when: "editorFocus"` 唯一的依据：焦点
       * 判定发生在一个只拿得到 EventTarget 的监听器里，`closest()` 是从它
       * 问出「我在谁里面」的唯一手段。
       */}
      <div
        ref={setKeyboardRoot}
        data-keybinding-scope="editor"
        className="h-full w-full overflow-hidden"
      >
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
                  if (!isDesktop()) return;
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
        {state.kind === "media" && (
          <MediaPreview
            media={state.media}
            src={state.src}
            title={node.title}
            onError={() => {
              URL.revokeObjectURL(state.src);
              setState((current) =>
                current.kind === "media" && current.src === state.src
                  ? { kind: "attachment", info: current.info }
                  : current,
              );
            }}
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
                ref={refs.hostRef}
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
                    refs.viewRef.current?.state.sliceDoc() ?? "",
                  )}
                  onClose={() => setDiskContent(null)}
                />
              )}
            </div>
            <StatusBar
              state={state}
              language={language.status}
              ownership={language.ownership}
              languageApplicable={languageEligible}
            />
          </div>
        )}
      </div>
    </NodeShell>
  );
}
