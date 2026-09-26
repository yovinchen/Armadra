import * as React from "react";
import { toast } from "sonner";
import type { EditorView } from "codemirror";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { useMergeStore } from "@/editor/merge/merge-store";
import { merge3 } from "@/lib/merge3";
import {
  ORIGIN_MAX_CHARS,
  clearDraft,
  draftOrigin,
  readDraft,
  writeDraft,
} from "./drafts";
import type { EditorRefs } from "./refs";
import type { ExternalChange, LoadState } from "./types";

/** 停手这么久才落一次本机副本：每个按键都序列化整份正文不值得。 */
const PERSIST_DEBOUNCE_MS = 400;

export interface DraftActions {
  /** 编辑器每改一次就叫一下；真正的写入是去抖过的。 */
  noteChange: () => void;
  /** 立刻按当前状态写一次（或清掉）本机副本。 */
  persistNow: () => void;
  /** 草稿与磁盘版三方合并，base 是草稿改起时的那一版。 */
  mergeWithDisk: () => void;
}

/**
 * 草稿保护（编辑器设计 §3）：未保存的内容落到本机，刷新或断线后放回来；
 * 磁盘在草稿期间变了就不直接覆盖任何一边，而是交给三方合并。
 *
 * 「草稿改起时的那一版」就是 `baselineRef` + `versionRef` 这一对：打开、
 * 保存、重载、合并完成时一起换，所以本机副本里的 base 与内容版本永远配对。
 */
export function useDraftProtection(
  refs: EditorRefs,
  options: {
    workspaceId: string | undefined;
    path: string;
    identity: string;
    state: LoadState;
    viewGeneration: number;
    setDirty: React.Dispatch<React.SetStateAction<boolean>>;
    setExternal: React.Dispatch<React.SetStateAction<ExternalChange | null>>;
    setDiskContent: React.Dispatch<React.SetStateAction<string | null>>;
    /** 磁盘那一版换了（合并完成）：行边标记要重取。 */
    onDiskSynced: () => void;
  },
): DraftActions {
  const {
    workspaceId,
    path,
    identity,
    state,
    viewGeneration,
    setDirty,
    setExternal,
    setDiskContent,
    onDiskSynced,
  } = options;
  const t = useT();
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  /** 这个视图已经问过本机副本了；视图重建（换文件）才会再问一次。 */
  const restoredRef = React.useRef<string | null>(null);

  /**
   * 排着队的那次写入属于哪个视图。卸载时编辑器的 effect 可能先一步把
   * `viewRef` 清掉，而最后那一截草稿恰恰要在这时候写下去；销毁后的视图
   * 状态仍然读得到。
   */
  const pendingViewRef = React.useRef<EditorView | null>(null);

  const persistNow = React.useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const pending = pendingViewRef.current;
    pendingViewRef.current = null;
    const view =
      pending ??
      (refs.viewIdentityRef.current === identity ? refs.viewRef.current : null);
    if (!workspaceId || !path || !view) return;
    const content = view.state.sliceDoc();
    if (content === refs.baselineRef.current && !refs.recreateRef.current) {
      clearDraft(workspaceId, path);
      return;
    }
    // 文件被删之后编辑器的基准不再是草稿改起的那一版（重开时是空串），所以
    // 那一版从上一份本机副本里接着带下去；上一份也没有时，编辑器手里的基准
    // 还是删之前打开的正文，就用它。
    let origin: { content: string; version?: string } | undefined;
    if (refs.recreateRef.current) {
      origin =
        draftOrigin(readDraft(workspaceId, path)) ??
        (refs.baselineRef.current !== ""
          ? { content: refs.baselineRef.current }
          : undefined);
      if (origin && origin.content.length > ORIGIN_MAX_CHARS)
        origin = undefined;
    }
    writeDraft(workspaceId, path, {
      base: refs.baselineRef.current,
      draft: content,
      ...(refs.versionRef.current && !refs.recreateRef.current
        ? { baseVersion: refs.versionRef.current }
        : {}),
      ...(origin
        ? {
            origin: origin.content,
            ...(origin.version ? { originVersion: origin.version } : {}),
          }
        : {}),
    });
  }, [identity, path, workspaceId]);

  const noteChange = React.useCallback(() => {
    if (refs.viewIdentityRef.current === identity)
      pendingViewRef.current = refs.viewRef.current;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
  }, [identity, persistNow]);

  // 关页面、切走标签页、节点卸载：还没落盘的那一截立刻写掉。
  React.useEffect(() => {
    const flush = () => {
      if (timerRef.current !== undefined) persistNow();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, [persistNow]);

  /** 把正文整份换掉，不重建视图：撤销栈与滚动位置都留着。 */
  const replaceDoc = React.useCallback(
    (content: string) => {
      const view = refs.viewRef.current;
      if (!view || refs.viewIdentityRef.current !== identity) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    },
    [identity],
  );

  /** 打开合并视图；`theirs` 是磁盘上的正文，`theirsVersion` 是它的内容版本。 */
  const openMerge = React.useCallback(
    (theirs: string, theirsVersion: string | undefined) => {
      const view = refs.viewRef.current;
      if (!view || refs.viewIdentityRef.current !== identity) return;
      const ours = view.state.sliceDoc();
      useMergeStore.getState().beginDraft({
        path,
        regions: merge3(refs.baselineRef.current, ours, theirs),
        trailingNewline: ours.endsWith("\n") || theirs.endsWith("\n"),
        apply: (merged) => {
          if (refs.identityRef.current !== identity) return;
          // 合并结果仍是草稿；磁盘那一版成了它新的起点，下一次保存就带着
          // 这个版本提交，磁盘再变仍然 409。
          refs.baselineRef.current = theirs;
          refs.versionRef.current = theirsVersion;
          refs.recreateRef.current = false;
          replaceDoc(merged);
          setDirty(merged !== theirs);
          setExternal(null);
          setDiskContent(null);
          onDiskSynced();
          persistNow();
        },
      });
    },
    [identity, onDiskSynced, path, persistNow, replaceDoc],
  );

  const mergeWithDisk = React.useCallback(() => {
    if (!workspaceId || !path) return;
    void runtimeApi
      .readFile(workspaceId, path)
      .then((file) => {
        if (refs.identityRef.current !== identity) return;
        openMerge(file.content, file.sha256);
      })
      .catch(() => toast.error(t("editor.failed")));
  }, [identity, openMerge, path, t, workspaceId]);

  // 视图建好后问一次本机副本。
  React.useEffect(() => {
    if (!workspaceId || !path) return;
    if (state.kind !== "text" || state.identity !== identity) return;
    if (refs.viewIdentityRef.current !== identity || !refs.viewRef.current)
      return;
    if (restoredRef.current === identity) return;
    restoredRef.current = identity;

    const stored = readDraft(workspaceId, path);
    if (state.orphan) {
      // 文件已经不在了，编辑器里放的就是这份草稿：按新建保存，或者另存为。
      refs.baselineRef.current = "";
      refs.versionRef.current = undefined;
      refs.recreateRef.current = true;
      refs.dirtyRef.current = true;
      setDirty(true);
      setExternal({ kind: "removed" });
      return;
    }
    if (!stored) return;
    if (stored.draft === state.content) {
      clearDraft(workspaceId, path);
      return;
    }
    if (stored.baseVersion && stored.baseVersion === state.sha256) {
      // 磁盘还是草稿改起时那一版：原样放回。脏标记同步写进引用：监听注册
      // 的回答可能在下一次渲染之前到，它要看得出这里已经有草稿，不能当成
      // 干净的编辑器去自动重载。
      refs.dirtyRef.current = true;
      replaceDoc(stored.draft);
      toast(t("editor.draft.restored"), {
        action: {
          label: t("editor.draft.discard"),
          onClick: () => {
            if (refs.identityRef.current !== identity) return;
            replaceDoc(refs.baselineRef.current);
            clearDraft(workspaceId, path);
          },
        },
      });
      return;
    }
    // 磁盘在草稿期间变了。草稿照样放回来，但保存凭据退回草稿改起时那一
    // 版——直接保存会 409，而不是悄悄盖掉别人的修改；提示条给出合并。
    refs.baselineRef.current = stored.base;
    refs.versionRef.current = stored.baseVersion;
    refs.recreateRef.current = false;
    refs.dirtyRef.current = true;
    replaceDoc(stored.draft);
    setDirty(stored.draft !== stored.base);
    setExternal({ kind: "modified", sha256: state.sha256 });
    toast(t("editor.draft.restoredStale"));
  }, [identity, path, state, viewGeneration, workspaceId]);

  return { noteChange, persistNow, mergeWithDisk };
}
