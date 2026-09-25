import * as React from "react";
import { QueryClientContext } from "@tanstack/react-query";

import { runtimeApi } from "@/api/client";
import type { EditorRefs } from "./refs";
import { headLines, type FileDiffs } from "./git-gutter";

/**
 * 给编辑器装上 Git 行边标记的数据：取 `git/diff` 两个作用域里这个文件的
 * patch，倒推出 HEAD 的行交给 CodeMirror，之后的实时重算在编辑器里做。
 *
 * 什么时候重新取：视图重建、磁盘版本变了（保存、重载、外部修改被接受）、
 * 窗口重新拿到焦点，以及 Git 面板做完一次写操作——那一刻它会让所有
 * `git-status` 查询失效，这里跟着那一下走，而不是自己轮询。
 *
 * 读不到（不在仓库里、没有执行权限、旧 Runtime）就没有标记，不报错：
 * 行边标记是锦上添花，不是编辑器能不能用的前提。
 */
export function useGitGutter(
  refs: EditorRefs,
  options: {
    workspaceId: string | undefined;
    path: string;
    identity: string;
    /** 编辑器已经起来、而且是一个文本文件。 */
    active: boolean;
    viewGeneration: number;
    /** 保存或重载一次就加一；变了就重取。 */
    diskRevision: number;
  },
): void {
  const { workspaceId, path, identity, active, viewGeneration, diskRevision } =
    options;
  const [tick, setTick] = React.useState(0);
  const queryClient = React.useContext(QueryClientContext);

  React.useEffect(() => {
    if (!active || !workspaceId) return;
    const refresh = () => setTick((value) => value + 1);
    window.addEventListener("focus", refresh);
    const off = queryClient?.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "invalidate" &&
        event.query.queryKey[0] === "git-status" &&
        event.query.queryKey[1] === workspaceId
      )
        refresh();
    });
    return () => {
      window.removeEventListener("focus", refresh);
      off?.();
    };
  }, [active, queryClient, workspaceId]);

  React.useEffect(() => {
    if (!active || !workspaceId || !path) return;
    let cancelled = false;
    void (async () => {
      try {
        const [worktree, staged] = await Promise.all([
          runtimeApi.gitDiff(workspaceId, { scope: "worktree", paths: [path] }),
          runtimeApi.gitDiff(workspaceId, { scope: "staged", paths: [path] }),
        ]);
        if (cancelled || refs.identityRef.current !== identity) return;
        const pick = (files: typeof worktree.files) =>
          files.find((file) => file.path === path) ??
          (files.length === 1 ? files[0] : undefined);
        const diffs: FileDiffs = {
          worktree: pick(worktree.files),
          staged: pick(staged.files),
        };
        const head =
          worktree.repository && !refs.recreateRef.current
            ? headLines(refs.baselineRef.current, diffs)
            : null;
        apply(head);
      } catch {
        if (!cancelled) apply(null);
      }
    })();

    function apply(head: string[] | null) {
      const view = refs.viewRef.current;
      const core = refs.coreRef.current;
      if (!view || !core || refs.viewIdentityRef.current !== identity) return;
      core.setGitHead(view, head);
    }

    return () => {
      cancelled = true;
    };
  }, [active, diskRevision, identity, path, tick, viewGeneration, workspaceId]);
}
