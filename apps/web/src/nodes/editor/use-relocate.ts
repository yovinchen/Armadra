import * as React from "react";

import { runtimeApi } from "@/api/client";
import { useMergeStore } from "@/editor/merge/merge-store";
import { merge3 } from "@/lib/merge3";
import { useCanvasStore } from "@/store/canvas-store";
import { clearDraft, readDraft, writeDraft } from "./drafts";
import type { EditorRefs } from "./refs";

export interface RelocateActions {
  /** 草稿与目标文件三方合并；合并结果作为目标文件的草稿放回。 */
  merge: (target: string) => Promise<void>;
  /** 用草稿直接覆盖目标文件（带着读到的那一版提交，期间被改就 409）。 */
  overwrite: (target: string) => Promise<void>;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * 重新定位（编辑器设计 §3）：文件被移走之后，把手里的草稿接到另一个**已经
 * 存在**的文件上。与另存为的区别在于目标有自己的内容，所以只有两条路——合并，
 * 或者确认后覆盖——都不会悄悄吃掉任何一边。
 *
 * 合并不在这里写盘：结果按目标文件的内容版本写成它的本机草稿，节点改指过去
 * 后由草稿保护原样放回，保存仍是人的决定。旧路径的草稿随即清掉；基准先换成
 * 当前正文，节点切走时那次最后的写入才不会把它又存回旧路径。
 */
export function useRelocate(
  refs: EditorRefs,
  options: {
    id: string;
    title: string;
    workspaceId: string | undefined;
    path: string;
    identity: string;
  },
): RelocateActions {
  const { id, title, workspaceId, path, identity } = options;

  const current = React.useCallback((): string | null => {
    const view = refs.viewRef.current;
    if (!view || refs.viewIdentityRef.current !== identity) return null;
    return view.state.sliceDoc();
  }, [identity, refs]);

  const pointTo = React.useCallback(
    (target: string, content: string) => {
      if (!workspaceId) return;
      refs.baselineRef.current = content;
      refs.recreateRef.current = false;
      clearDraft(workspaceId, path);
      const store = useCanvasStore.getState();
      store.updateNodeData(id, { path: target });
      if (title === basename(path)) {
        store.updateNode(id, { title: basename(target) });
      }
    },
    [id, path, refs, title, workspaceId],
  );

  const merge = React.useCallback(
    async (target: string) => {
      const ours = current();
      if (!workspaceId || ours === null) return;
      const file = await runtimeApi.readFile(workspaceId, target);
      // 草稿改起时的那一版：本机副本里记着就用它，没有就退回编辑器的基准。
      const base =
        readDraft(workspaceId, path)?.base || refs.baselineRef.current;
      useMergeStore.getState().beginDraft({
        path: target,
        regions: merge3(base, ours, file.content),
        trailingNewline: ours.endsWith("\n") || file.content.endsWith("\n"),
        apply: (merged) => {
          if (refs.identityRef.current !== identity) return;
          writeDraft(workspaceId, target, {
            base: file.content,
            draft: merged,
            ...(file.sha256 ? { baseVersion: file.sha256 } : {}),
          });
          pointTo(target, current() ?? ours);
        },
      });
    },
    [current, identity, path, pointTo, refs, workspaceId],
  );

  const overwrite = React.useCallback(
    async (target: string) => {
      const ours = current();
      if (!workspaceId || ours === null) return;
      const file = await runtimeApi.readFile(workspaceId, target);
      await runtimeApi.writeFile(
        workspaceId,
        target,
        ours,
        file.size,
        file.sha256,
        file.bom === true,
      );
      if (refs.identityRef.current !== identity) return;
      clearDraft(workspaceId, target);
      pointTo(target, ours);
    },
    [current, identity, pointTo, refs, workspaceId],
  );

  return { merge, overwrite };
}
