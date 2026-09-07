/**
 * 复选框 ↔ 索引。
 *
 * 勾选就是 `git add`，取消就是 `git restore --staged`：界面上不再有第二个
 * 「暂存区」概念（Git 工具窗口设计 §2.3）。勾一下要立刻有反应，所以先改本地
 * 那一份状态快照；**失败就整份换回去**——一个停在错误位置的复选框，会让人以为
 * 一个文件已经在这次提交里了。
 */
import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { GitStatusBatch } from "@armadra/shared";
import { gitGateway } from "../../../git/gateway";
import { gitTarget } from "../../../git/target";
import { useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { invalidateGitQueries } from "../queries";
import { pendingKey, type ChangeToggle } from "./build-change-tree";

/**
 * 勾选之后那份状态快照应该长什么样。
 *
 * 只走 Git 自己的规则，不猜：`git add` 一个未跟踪文件之后它是 `A`，
 * `git restore --staged` 一个 `A` 之后它回到未跟踪——这两条互为逆，所以来回勾
 * 选不会把一行变成别的东西。冲突行不在这里处理（见 `useStaging`）。
 */
export function stageOptimistically(
  batch: GitStatusBatch,
  toggle: ChangeToggle,
): GitStatusBatch {
  const paths = new Set(toggle.paths);
  return {
    ...batch,
    repositories: batch.repositories.map((entry) =>
      entry.path !== toggle.repositoryPath || !entry.status
        ? entry
        : {
            ...entry,
            status: {
              ...entry.status,
              files: entry.status.files.map((file) =>
                !paths.has(file.path)
                  ? file
                  : toggle.stage
                    ? {
                        ...file,
                        staged: true,
                        unstaged: false,
                        status:
                          file.status === "?" ? ("A" as const) : file.status,
                      }
                    : {
                        ...file,
                        staged: false,
                        unstaged: true,
                        status:
                          file.status === "A" ? ("?" as const) : file.status,
                      },
              ),
            },
          },
    ),
  };
}

export interface Staging {
  toggle: (input: ChangeToggle) => void;
  /** 还没落定的行，键是 `pendingKey()`。 */
  pending: ReadonlySet<string>;
}

export function useStaging(workspaceId: string, statusKey: QueryKey): Staging {
  const t = useT();
  const client = useQueryClient();
  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const update = (input: ChangeToggle, add: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      for (const path of input.paths) {
        const key = pendingKey(input.repositoryPath, path);
        if (add) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  const mutation = useMutation<
    unknown,
    Error,
    ChangeToggle,
    { previous: GitStatusBatch | undefined }
  >({
    mutationFn: (input) => {
      const target = gitTarget(
        workspaceId,
        workspaceRoot,
        input.repositoryPath,
      );
      const seed = `${input.stage ? "stage" : "unstage"}/${input.repositoryPath}/${crypto.randomUUID()}`;
      if (!input.stage)
        return gitGateway.unstage(
          target,
          input.paths,
          seed,
        ) as Promise<unknown>;
      // 冲突文件进索引就是「标记已解决」，而那件事服务端要重读文件才敢做：
      // 还留着冲突标记时它会拒，并把行号带回来。
      if (input.group === "conflicts")
        return gitGateway.markResolved(
          target,
          input.paths,
          seed,
        ) as Promise<unknown>;
      return gitGateway.stage(target, input.paths, seed) as Promise<unknown>;
    },
    retry: false,
    onMutate: async (input) => {
      update(input, true);
      await client.cancelQueries({ queryKey: statusKey });
      const previous = client.getQueryData<GitStatusBatch>(statusKey);
      // 冲突行不做乐观更新：它进索引之前要通过一次服务端复核，先把它画成
      // 「已解决」等于替那次复核回答。
      if (previous && input.group !== "conflicts")
        client.setQueryData<GitStatusBatch>(
          statusKey,
          stageOptimistically(previous, input),
        );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous !== undefined)
        client.setQueryData(statusKey, context.previous);
      toast.error(error instanceof Error ? error.message : t("scm.failed"));
    },
    onSettled: (_data, _error, input) => {
      update(input, false);
      invalidateGitQueries(client, workspaceId);
    },
  });
  return { toggle: mutation.mutate, pending };
}
