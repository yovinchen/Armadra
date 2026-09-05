import * as React from "react";
import { toast } from "sonner";

import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import type { EditorRefs } from "./refs";
import type { ExternalChange } from "./types";

export interface ExternalChangeActions {
  reload: () => Promise<void>;
  compare: () => void;
  keepDraft: () => void;
}

/**
 * 外部改动的那一半：注册监听、退化路径的按需检查、重载 / 比较 / 保留草稿。
 * 「我们自己刚写下去的内容不是外部改动」这条判断也在这里，只此一处。
 */
export function useExternalChanges(
  refs: EditorRefs,
  options: {
    id: string;
    path: string;
    workspaceId: string | undefined;
    identity: string;
    watching: boolean;
    degraded: boolean;
    external: ExternalChange | null;
    setDirty: React.Dispatch<React.SetStateAction<boolean>>;
    setExternal: React.Dispatch<React.SetStateAction<ExternalChange | null>>;
    setDiskContent: React.Dispatch<React.SetStateAction<string | null>>;
    setDegraded: React.Dispatch<React.SetStateAction<boolean>>;
  },
): ExternalChangeActions {
  const {
    id,
    path,
    workspaceId,
    identity,
    watching,
    degraded,
    external,
    setDirty,
    setExternal,
    setDiskContent,
    setDegraded,
  } = options;
  const t = useT();

  /** 用磁盘上的正文替换编辑器内容；不重建视图，撤销栈和滚动位置都保留。 */
  const reload = React.useCallback(async () => {
    if (!workspaceId || !path) return;
    const file = await runtimeApi.readFile(workspaceId, path);
    if (refs.identityRef.current !== identity) return;
    refs.baselineRef.current = file.content;
    refs.sizeRef.current = file.size;
    refs.versionRef.current = file.sha256;
    refs.bomRef.current = file.bom === true;
    refs.recreateRef.current = false;
    const view = refs.viewRef.current;
    if (view && refs.viewIdentityRef.current === identity)
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
      if (change.sha256 && change.sha256 === refs.versionRef.current) return;
      if (change.kind === "removed" || refs.dirtyRef.current) {
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
          version.sha256 !== refs.versionRef.current
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
          if (refs.identityRef.current !== identity) return;
          if (!version.exists) {
            if (refs.versionRef.current !== undefined)
              applyExternal({ kind: "removed" });
          } else if (
            version.sha256 &&
            version.sha256 !== refs.versionRef.current
          )
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
        if (refs.identityRef.current === identity) setDiskContent(file.content);
      })
      // 文件已经不在了：拿空正文比，整份草稿显示为新增。
      .catch(() => {
        if (refs.identityRef.current === identity) setDiskContent("");
      });
  }, [identity, path, workspaceId]);

  /**
   * 保留草稿：把最新的磁盘版本当作保存令牌，下一次保存就覆盖这次外部改动；
   * 文件已被删除时改成「新建」提交。之后磁盘再变，Runtime 仍会 409 再提示。
   */
  const keepDraft = React.useCallback(() => {
    if (!external) return;
    if (external.kind === "removed") {
      refs.versionRef.current = undefined;
      refs.recreateRef.current = true;
    } else if (external.sha256) {
      refs.versionRef.current = external.sha256;
      refs.recreateRef.current = false;
    }
    setExternal(null);
    setDiskContent(null);
  }, [external]);

  return { reload, compare, keepDraft };
}
