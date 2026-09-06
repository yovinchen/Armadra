import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  DeleteGithubBranchResponse,
  GithubPullRequest,
  GithubRepositoryRef,
  HostGithubClient,
} from "@armadra/host-client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { boundFrameForPath } from "@/canvas/frame-binding";
import { invalidateGitQueries } from "../git/queries";
import { failureKey, shortSha } from "./model";
import { githubKeys } from "./queries";

export interface MergeCleanupProps {
  client: HostGithubClient;
  workspaceId: string;
  repository: GithubRepositoryRef;
  pull: GithubPullRequest;
  canWrite: boolean;
  busy: boolean;
}

/**
 * 合并之后的清理（Git/GitHub 设计 §8「清理」）。
 *
 * 两件事，两个确认，互不牵连：删远端分支，和移除本地那份 checkout。合并本身
 * 一个都不做——「清理」是人的决定，而且一个悄悄删掉别人分支的合并按钮是这类
 * 工具最容易造成的不可逆伤害。
 *
 * 删远端分支带上页面上显示的那个 head SHA：分支在这期间前进过就说明上面有
 * 没被这次合并带走的提交，Host 会拒绝而不是照删。fork 的 head 分支在别人的
 * 仓库里，这里根本不提供删除。
 *
 * 移除本地 checkout 走的是 Worktrees 页那一条安全移除（脏文件、未推提交、
 * 主 worktree、锁定都会挡住），移除成功后才解绑 Frame——解绑只清画布上的
 * 绑定，不动磁盘，两者顺序反过来就会留下一个指不到东西的 Frame。运行中的
 * 会话一概不动。
 */
export function MergeCleanup({
  client,
  workspaceId,
  repository,
  pull,
  canWrite,
  busy,
}: MergeCleanupProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = React.useState<"branch" | "worktree" | null>(
    null,
  );
  const [branchOutcome, setBranchOutcome] =
    React.useState<DeleteGithubBranchResponse | null>(null);

  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  const nodes = useCanvasStore((state) => state.document?.nodes);

  // Cleanup is only a question once the pull request is merged, so the
  // worktree list is only read then: an unmerged pull request must not make
  // the panel walk the repository for a section nobody is going to see.
  const merged = canWrite && pull.state === 3;
  const worktrees = useQuery({
    queryKey: ["git-repository-worktrees", workspaceId, "."],
    queryFn: ({ signal }) =>
      runtimeApi.gitRepositoryWorktrees(workspaceId, signal),
    enabled: merged,
    retry: false,
  });

  // The local checkout of this pull request's head branch, if there is one.
  const checkout = worktrees.data?.find(
    (record) => record.branch === pull.headRef && !record.isMain,
  );
  const frame = checkout
    ? boundFrameForPath(nodes ?? [], checkout.path, { workspaceRoot })
    : null;
  const removable =
    checkout !== undefined &&
    checkout.accessible &&
    !checkout.bare &&
    !checkout.locked &&
    !checkout.prunable &&
    checkout.dirty === false &&
    Boolean(checkout.headOid);

  const deleteBranch = useMutation({
    mutationFn: () =>
      client.deleteBranch({
        repository,
        branch: pull.headRef,
        // The SHA the panel displayed. A branch that moved since then carries
        // commits this merge did not take, and the Host refuses.
        expectedSha: pull.headSha,
      }),
    onSuccess: (result) => {
      setBranchOutcome(result);
      void queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
    onError: (error: unknown) => toast.error(t(failureKey(error))),
  });

  const removeWorktree = useMutation({
    mutationFn: async () => {
      const snapshot = await runtimeApi.gitRepositoryBranches(workspaceId, ".");
      return runtimeApi.gitRepositoryOperate(
        workspaceId,
        {
          kind: "removeWorktree",
          path: checkout!.path,
          expectedOid: checkout!.headOid!,
          allowUnpublished: false,
        },
        snapshot.head,
      );
    },
    onSuccess: () => {
      // Only now: unbinding first would leave a Frame pointing at a checkout
      // the removal might still refuse to delete.
      if (frame)
        useCanvasStore.getState().updateNodeData(frame.id, { binding: null });
      toast.success(t("github.cleanup.worktreeQueued"));
      invalidateGitQueries(queryClient, workspaceId);
    },
    onError: (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : t("github.error.network"),
      ),
  });

  if (!merged) return null;

  return (
    <section
      className="min-w-0 space-y-2 border-t border-border pt-3"
      data-slot="github-cleanup"
    >
      <h4 className="text-[12px] font-medium text-muted-foreground">
        {t("github.cleanup")}
      </h4>
      <p className="text-[11px] text-muted-foreground">
        {t("github.cleanup.note")}
      </p>

      <div className="flex flex-wrap gap-2">
        {/* A fork's branch lives in somebody else's repository. */}
        {pull.fromFork ? (
          <p className="text-[11px] text-muted-foreground">
            {t("github.cleanup.forkBranch")}
          </p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="min-h-10"
            data-slot="github-delete-branch"
            disabled={busy || deleteBranch.isPending || !pull.headSha}
            onClick={() => setConfirm("branch")}
          >
            {t("github.cleanup.deleteBranch")} · {pull.headRef}
          </Button>
        )}

        {checkout ? (
          <Button
            size="sm"
            variant="outline"
            className="min-h-10"
            data-slot="github-remove-worktree"
            disabled={busy || removeWorktree.isPending || !removable}
            title={removable ? undefined : t("github.cleanup.worktreeBlocked")}
            onClick={() => setConfirm("worktree")}
          >
            {t("github.cleanup.removeWorktree")}
          </Button>
        ) : null}
      </div>

      {checkout && !removable && (
        <p className="text-[11px] text-muted-foreground">
          {t("github.cleanup.worktreeBlocked")}
        </p>
      )}

      {branchOutcome && (
        <p
          role="status"
          data-slot="github-delete-branch-outcome"
          className={
            branchOutcome.deleted
              ? "text-[11px] text-muted-foreground"
              : "text-[11px] text-destructive"
          }
        >
          {branchOutcome.deleted
            ? t("github.cleanup.branchDeleted")
            : `${t("github.cleanup.branchKept")} · ${branchOutcome.reasonCode}`}
        </p>
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                confirm === "worktree"
                  ? "github.cleanup.confirmWorktree"
                  : "github.cleanup.confirmBranch",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                confirm === "worktree"
                  ? "github.cleanup.confirmWorktreeNote"
                  : "github.cleanup.confirmBranchNote",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">{t("github.pull.head")}</dt>
            <dd className="min-w-0 truncate">{pull.headRef}</dd>
            {confirm === "branch" ? (
              <>
                <dt className="text-muted-foreground">
                  {t("github.pull.headSha")}
                </dt>
                <dd className="min-w-0 break-all font-mono select-text">
                  {shortSha(pull.headSha)}
                </dd>
              </>
            ) : (
              <>
                <dt className="text-muted-foreground">
                  {t("github.checkout.path")}
                </dt>
                <dd className="min-w-0 break-all font-mono select-text">
                  {checkout?.path}
                </dd>
                {frame ? (
                  <>
                    <dt className="text-muted-foreground">
                      {t("github.cleanup.frame")}
                    </dt>
                    <dd className="min-w-0 truncate">{frame.title}</dd>
                  </>
                ) : null}
              </>
            )}
          </dl>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-10">
              {t("github.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-10"
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action === "branch") {
                  setBranchOutcome(null);
                  deleteBranch.mutate();
                } else if (action === "worktree" && removable) {
                  removeWorktree.mutate();
                }
              }}
            >
              {t("github.cleanup.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
