import * as React from "react";
import { toast } from "sonner";

import { isConflict, runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import type { EditorRefs } from "./refs";
import type { ExternalChange } from "./types";

export interface SaveActions {
  save: () => Promise<void>;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * 保存：内容版本是唯一的凭据，冲突时把磁盘版本取回来重新挂提示条。
 * `⌘S` / `Ctrl+S` 与头部按钮走的是同一条路。
 */
export function useFileSave(
  refs: EditorRefs,
  options: {
    path: string;
    workspaceId: string | undefined;
    identity: string;
    writable: boolean;
    setDirty: React.Dispatch<React.SetStateAction<boolean>>;
    setSaving: React.Dispatch<React.SetStateAction<boolean>>;
    setExternal: React.Dispatch<React.SetStateAction<ExternalChange | null>>;
  },
): SaveActions {
  const {
    path,
    workspaceId,
    identity,
    writable,
    setDirty,
    setSaving,
    setExternal,
  } = options;
  const t = useT();

  const save = React.useCallback(async () => {
    const view = refs.viewRef.current;
    if (
      !view ||
      !workspaceId ||
      !writable ||
      refs.pendingSaveRef.current ||
      refs.viewIdentityRef.current !== identity ||
      // 没有内容版本只有一种情况可以保存：文件被外部删除后用户选了保留草稿，
      // 这一次按「新建」提交，别的写者抢先建了同名文件仍然会 409。
      (!refs.versionRef.current && !refs.recreateRef.current)
    )
      return;
    const submitted = view.state.sliceDoc();
    const token = {};
    refs.pendingSaveRef.current = token;
    setSaving(true);
    try {
      const result = await runtimeApi.writeFile(
        workspaceId,
        path,
        submitted,
        refs.sizeRef.current,
        refs.versionRef.current,
        // 文件本来带 BOM 就写回去；不带就绝不新增一个。
        refs.bomRef.current,
      );
      if (
        refs.identityRef.current !== identity ||
        refs.viewRef.current !== view
      )
        return;
      // 只更新基准大小，不重建编辑器：重建会丢光标和撤销栈。
      refs.sizeRef.current = result.size;
      refs.versionRef.current = result.sha256;
      refs.recreateRef.current = false;
      refs.baselineRef.current = submitted;
      setDirty(view.state.sliceDoc() !== submitted);
      setExternal(null);
    } catch (error) {
      if (refs.identityRef.current !== identity) return;
      toast.error(
        isConflict(error) ? t("editor.conflict") : t("editor.saveFailed"),
      );
      // 冲突就是「磁盘上又变了」：把当前版本取回来，重新挂提示条。
      if (isConflict(error) && workspaceId)
        void runtimeApi
          .fileVersion(workspaceId, path)
          .then((version) => {
            if (refs.identityRef.current !== identity) return;
            setExternal({
              kind: version.exists ? "modified" : "removed",
              sha256: version.sha256 ?? undefined,
            });
          })
          .catch(() => undefined);
    } finally {
      if (refs.pendingSaveRef.current === token) {
        refs.pendingSaveRef.current = null;
        if (refs.identityRef.current === identity) setSaving(false);
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

  return { save, onKeyDown };
}
