import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GitBranchSnapshot, GitRepositoryAction } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { Button } from "../../../../ui/button";
import { Input } from "../../../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../ui/dialog";
import { Check, Field, ReadError, selectClass } from "../../forms";
import { createWorktreeAction, localBranch } from "../../worktree";
import {
  EMPTY_WORKTREE_FORM,
  worktreeFormReady,
  worktreeFrameIntent,
  type WorktreeFormValue,
  type WorktreeFrameIntent,
} from "../worktree-frame";

/**
 * 「新建 Worktree…」（分支树上 Worktree 组的右键项）。
 *
 * 这个对话框只收输入并造一个 `createWorktree` 动作，交回日志页——写路径仍然
 * 只有那一条（确认门 + `gitGateway.operate`）。画布上要不要跟着出一个 Frame
 * 也在这里决定，但**不在这里兑现**：兑现的凭据是 `git worktree list` 里真的
 * 多出了这条 checkout，那件事只有页面看得到（`worktree-frame.ts`）。
 *
 * 分支列表单独读一次这个仓库：`createWorktreeAction()` 检出已有分支时要带上
 * 这一次读到的 OID，而分支树的快照里没有 `fullRef` / `remote` 这两维，凑不出
 * `localBranch()` 认得的记录。
 */
export function WorktreeCreateDialog({
  repositoryPath,
  workspaceId,
  busy,
  loadBranches,
  onClose,
  onSubmit,
}: {
  /** 非 `null` 就是打开；值是这次要在哪个仓库里建。 */
  repositoryPath: string | null;
  workspaceId: string;
  busy: boolean;
  loadBranches: (
    repositoryPath: string,
    signal: AbortSignal,
  ) => Promise<GitBranchSnapshot>;
  onClose: () => void;
  onSubmit: (input: {
    repositoryPath: string;
    action: GitRepositoryAction;
    intent: WorktreeFrameIntent | null;
  }) => void;
}) {
  const t = useT();
  const [value, setValue] = useState<WorktreeFormValue>(EMPTY_WORKTREE_FORM);
  // 换一个仓库就换一组输入：上一次填了一半的路径不该出现在下一个仓库的框里。
  useEffect(() => setValue(EMPTY_WORKTREE_FORM), [repositoryPath]);

  const snapshot = useQuery({
    queryKey: ["git-log-worktree-branches", workspaceId, repositoryPath],
    queryFn: ({ signal }) => loadBranches(repositoryPath!, signal),
    enabled: repositoryPath !== null,
    retry: false,
  });
  const branches = snapshot.data?.branches ?? [];
  const local = branches.filter((record) => !record.remote);
  const selected = localBranch(branches, value.branch);
  const ready = worktreeFormReady(value, branches);

  const patch = (next: Partial<WorktreeFormValue>) =>
    setValue((previous) => ({ ...previous, ...next }));

  const submit = () => {
    if (!repositoryPath || busy || !ready) return;
    const action = createWorktreeAction({
      path: value.path,
      branch: value.branch,
      createBranch: value.createBranch,
      startPoint: value.startPoint,
      existing: selected,
    });
    if (!action) return;
    onSubmit({
      repositoryPath,
      action,
      intent: worktreeFrameIntent(value),
    });
  };

  return (
    <Dialog
      open={repositoryPath !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("gitRepo.createWorktree")}</DialogTitle>
          {repositoryPath && (
            <DialogDescription className="break-all font-mono">
              {repositoryPath}
            </DialogDescription>
          )}
        </DialogHeader>
        <form
          className="min-w-0 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={busy} className="min-w-0 space-y-2">
            <Field label={t("gitRepo.worktreePath")}>
              <Input
                value={value.path}
                autoFocus
                required
                onChange={(event) => patch({ path: event.target.value })}
              />
            </Field>
            <Field label={t("gitRepo.branchName")}>
              {value.createBranch ? (
                <Input
                  value={value.branch}
                  required
                  onChange={(event) => patch({ branch: event.target.value })}
                />
              ) : (
                <select
                  className={selectClass}
                  value={selected?.name ?? ""}
                  required
                  onChange={(event) => patch({ branch: event.target.value })}
                >
                  <option value="">{t("gitRepo.chooseBranch")}</option>
                  {local.map((record) => (
                    <option key={record.fullRef} value={record.name}>
                      {record.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Check
              label={t("gitRepo.newWorktreeBranch")}
              checked={value.createBranch}
              onChange={(next) => patch({ createBranch: next })}
            />
            {value.createBranch && (
              <Field label={t("gitRepo.startPoint")}>
                <Input
                  value={value.startPoint}
                  onChange={(event) =>
                    patch({ startPoint: event.target.value })
                  }
                />
              </Field>
            )}
            <Check
              label={t("frameBinding.createFrame")}
              checked={value.createFrame}
              onChange={(next) => patch({ createFrame: next })}
            />
            {value.createFrame && (
              <Field label={t("frameBinding.initScript")}>
                <Input
                  value={value.initScript}
                  onChange={(event) =>
                    patch({ initScript: event.target.value })
                  }
                />
              </Field>
            )}
          </fieldset>
          {snapshot.isPending && repositoryPath && (
            <p role="status" className="text-xs">
              {t("gitRepo.loading")}
            </p>
          )}
          {snapshot.error && (
            <ReadError
              error={snapshot.error}
              retry={() => void snapshot.refetch()}
            />
          )}
          <p className="text-xs text-muted-foreground">
            {t("gitRepo.worktreeSafety")}
          </p>
          <DialogFooter>
            <Button type="submit" disabled={busy || !ready}>
              {t("gitRepo.createWorktree")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
