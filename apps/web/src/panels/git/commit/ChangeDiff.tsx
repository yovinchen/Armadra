/**
 * 选中一行之后右边（手机上是第二级）看到的差异。
 *
 * 工作空间根仓库走现有的 hunk 视图，所以差异里可以按 hunk 勾选；**别的检出走
 * 只读差异**，因为 `git/hunks` 这条路由是写死在工作空间根上的
 * （`git/api/mod.rs` 里那句 `read_hunks(workspace.root_path, …)`）：把一个嵌套
 * 仓库里的 `src/a.ts` 送进去，它会去根仓库找同名文件，然后暂存那一个。少一个
 * 按钮，好过暂存错一个文件。
 */
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { Badge } from "../../../ui/badge";
import { ChangesHunks } from "../ChangesHunks";
import { ReadError } from "../forms";
import { invalidateGitQueries } from "../queries";
import type { ChangeFileNode } from "./build-change-tree";

/** 差异读哪一侧：已暂存分区看索引与 HEAD 的差，其余看工作区与索引的差。 */
export function diffScope(node: ChangeFileNode): "staged" | "worktree" {
  return node.group === "staged" ? "staged" : "worktree";
}

function ReadOnlyDiff({
  workspaceId,
  node,
}: {
  workspaceId: string;
  node: ChangeFileNode;
}) {
  const t = useT();
  const scope = diffScope(node);
  const diff = useQuery({
    queryKey: ["git-diff", workspaceId, node.repositoryPath, node.path, scope],
    queryFn: () =>
      runtimeApi.gitDiff(workspaceId, {
        path: node.repositoryPath,
        scope,
        paths: [node.path],
      }),
    retry: false,
  });
  const file = diff.data?.files.find((entry) => entry.path === node.path);
  return (
    <div className="min-w-0 space-y-2 p-3 text-xs">
      {diff.isPending && <p role="status">{t("gitRepo.loading")}</p>}
      {diff.error && (
        <ReadError error={diff.error} retry={() => void diff.refetch()} />
      )}
      {diff.data && !file && (
        <p className="text-muted-foreground">{t("gitCommit.noDiff")}</p>
      )}
      {file && !file.previewable && (
        <p className="text-muted-foreground">{t("gitCommit.binary")}</p>
      )}
      {file?.previewable && (
        <pre
          className="max-h-full overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-5"
          tabIndex={0}
        >
          {file.patch || t("gitCommit.noDiff")}
        </pre>
      )}
      <p className="text-muted-foreground">{t("gitCommit.hunksRootOnly")}</p>
    </div>
  );
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
  const hunks = node.repositoryPath === ".";
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {/* hunk 视图自己就带文件名与 scope 徽标；两个一起显示就是同一行说两遍。 */}
      {!hunks && (
        <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs" title={node.path}>
            {node.path}
          </span>
          <Badge variant="outline" className="shrink-0">
            {t(
              diffScope(node) === "staged"
                ? "gitHunk.staged"
                : "gitHunk.worktree",
            )}
          </Badge>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {hunks ? (
          <ChangesHunks
            key={`${node.repositoryPath}:${diffScope(node)}:${node.path}`}
            workspaceId={workspaceId}
            file={node.path}
            scope={diffScope(node)}
            load={runtimeApi.gitHunks}
            apply={runtimeApi.gitApplyHunk}
            onChanged={(id) => invalidateGitQueries(client, id)}
          />
        ) : (
          <ReadOnlyDiff workspaceId={workspaceId} node={node} />
        )}
      </div>
    </div>
  );
}
