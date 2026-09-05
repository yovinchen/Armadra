/**
 * 文件操作的一处入口（E01/M4）：新建、重命名/移动、删除到回收站。
 *
 * 三件事在这里一起做完，免得每个调用点各写一遍：
 *
 *  1. 调 Runtime——权限、越界、符号链接、同名冲突全在那边判，这里只把
 *     错误消息原样 toast 出来。
 *  2. 让文件树重新拉取受影响的目录。
 *  3. 重命名后让画布上的编辑器/文件节点跟着改路径（`followRename`）。
 *     删除**不动**节点：编辑器正监听这个文件，`file.changed` 的 `removed`
 *     分支会把它转成 create-only 草稿，草稿不能因为一次删除消失。
 *
 * 删除给一次「撤销」：回收站在工作区 `.armadra/trash/` 下，`restoreTrash`
 * 把它放回原处；原处已经被别的东西占了就是 409，如实报错，不覆盖。
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FileEntryKind } from "@armadra/shared";
import { toast } from "sonner";

import { runtimeApi } from "@/api/client";
import { t } from "@/app/preferences-store";

import { followRename } from "./file-operations";

/** `a/b/c.ts` → `a/b`；顶层文件是 `.`。 */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : ".";
}

/** 把 `parent` 与一个名称接成工作区内路径。 */
export function joinPath(parent: string, name: string): string {
  const base = parent === "." || parent === "" ? "" : `${parent}/`;
  return `${base}${name}`;
}

export interface FileActions {
  createEntry: (parent: string, name: string, kind: FileEntryKind) => void;
  renameEntry: (from: string, to: string) => void;
  trashEntry: (path: string, name: string) => void;
}

export function useFileActions(workspaceId: string | undefined): FileActions {
  const queryClient = useQueryClient();

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["files", workspaceId] });
    void queryClient.invalidateQueries({
      queryKey: ["file-index", workspaceId],
    });
  }, [queryClient, workspaceId]);

  const fail = useCallback((error: unknown) => {
    toast.error(error instanceof Error ? error.message : t("fileOps.failed"));
  }, []);

  const createEntry = useCallback(
    (parent: string, name: string, kind: FileEntryKind) => {
      if (!workspaceId) return;
      void runtimeApi
        .createFileEntry(workspaceId, joinPath(parent, name), kind)
        .then(refresh, fail);
    },
    [fail, refresh, workspaceId],
  );

  const renameEntry = useCallback(
    (from: string, to: string) => {
      if (!workspaceId || from === to) return;
      void runtimeApi.renameFileEntry(workspaceId, from, to).then((result) => {
        followRename(from, result.path);
        refresh();
        if (parentOf(from) !== parentOf(result.path))
          toast(t("fileOps.moved", { path: result.path }));
      }, fail);
    },
    [fail, refresh, workspaceId],
  );

  const trashEntry = useCallback(
    (path: string, name: string) => {
      if (!workspaceId) return;
      void runtimeApi.trashFileEntry(workspaceId, path).then((entry) => {
        refresh();
        toast(t("fileOps.deleted"), {
          description: name,
          action: {
            label: t("fileOps.undo"),
            onClick: () => {
              void runtimeApi
                .restoreTrash(workspaceId, entry.id)
                .then((restored) => {
                  refresh();
                  toast(t("fileOps.restored", { path: restored.path }));
                }, fail);
            },
          },
        });
      }, fail);
    },
    [fail, refresh, workspaceId],
  );

  return { createEntry, renameEntry, trashEntry };
}
