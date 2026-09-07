/**
 * 选中一行之后右边（手机上是第二级）看到的差异。
 *
 * 每个检出都走 hunk 视图，所以哪个仓库里的文件都能按 hunk 勾选：`git/hunks` 的
 * 读与写现在都接检出路径，一个嵌套仓库里的 `src/a.ts` 不会再被拿到根仓库的索引
 * 里去找同名文件。
 */
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "../../../app/preferences-store";
import { ChangesHunks } from "../ChangesHunks";
import { invalidateGitQueries } from "../queries";
import { runtimeApi } from "../../../api/client";
import type { ChangeFileNode } from "./build-change-tree";

/** 差异读哪一侧：已暂存分区看索引与 HEAD 的差，其余看工作区与索引的差。 */
export function diffScope(node: ChangeFileNode): "staged" | "worktree" {
  return node.group === "staged" ? "staged" : "worktree";
}

export function ChangeDiff({
  workspaceId,
  node,
}: {
  workspaceId: string;
  node: ChangeFileNode | null;
}) {
  const t = useT();
  const client = useQueryClient();
  if (!node)
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {t("gitCommit.selectFile")}
      </p>
    );
  return (
    // hunk 视图自己带文件名与 scope 徽标，这里不再重复一行标题。
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <ChangesHunks
          key={`${node.repositoryPath}:${diffScope(node)}:${node.path}`}
          workspaceId={workspaceId}
          repositoryPath={node.repositoryPath}
          file={node.path}
          scope={diffScope(node)}
          load={runtimeApi.gitHunks}
          apply={runtimeApi.gitApplyHunk}
          onChanged={(id) => invalidateGitQueries(client, id)}
        />
      </div>
    </div>
  );
}
