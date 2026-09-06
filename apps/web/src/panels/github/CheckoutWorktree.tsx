import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { GithubPullRequest } from "@armadra/host-client";

import { gitGateway } from "@/git/gateway";
import { useGitTarget } from "@/git/target";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useT } from "@/app/preferences-store";
import { Field } from "../git/forms";
import { invalidateGitQueries } from "../git/queries";
import { createWorktreeAction, localBranch } from "../git/worktree";
import { suggestedHeadRef } from "./model";

/**
 * Checking a pull request out locally, through the same Runtime operation the
 * Worktrees tab uses (`createWorktreeAction`). There is no second worktree
 * implementation here — only a form that pre-fills it from the pull request.
 *
 * A fork's head ref is not reused as the local branch name: the branch lives in
 * someone else's repository, and taking over a same-named local branch would
 * silently move the user's own work.
 */
export function CheckoutWorktree({
  workspaceId,
  pull,
  busy,
}: {
  workspaceId: string;
  pull: GithubPullRequest;
  busy: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const suggestion = suggestedHeadRef(pull);
  const [path, setPath] = React.useState("");
  const [branch, setBranch] = React.useState(suggestion);
  const [startPoint, setStartPoint] = React.useState("");
  // 本地检出永远作用于工作空间根那个仓库；读写走同一条归属判定。
  const target = useGitTarget(workspaceId, ".");

  const snapshot = useQuery({
    queryKey: ["git-repository-branches", workspaceId],
    queryFn: ({ signal }) =>
      gitGateway.branches(target, signal),
    retry: false,
  });

  // A same-repository head usually already has a remote-tracking ref; a fork's
  // does not, so nothing is guessed for it.
  React.useEffect(() => {
    const remote = snapshot.data?.remotes[0];
    setStartPoint(
      !pull.fromFork && remote && pull.headRef
        ? `${remote}/${pull.headRef}`
        : "",
    );
  }, [pull.fromFork, pull.headRef, snapshot.data?.remotes]);

  const existing = localBranch(snapshot.data?.branches ?? [], branch.trim());

  const create = useMutation({
    mutationFn: async () => {
      const head = snapshot.data?.head;
      const action = createWorktreeAction({
        path,
        branch,
        createBranch: !existing,
        startPoint,
        existing,
      });
      if (!action || !head) throw new Error(t("github.checkout.needsBranch"));
      return gitGateway.operate(
        target,
        action,
        head,
        `checkout/${crypto.randomUUID()}`,
      );
    },
    onSuccess: () => {
      toast.success(t("github.checkout.queued"));
      invalidateGitQueries(queryClient, workspaceId);
    },
    onError: (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : t("github.error.network"),
      ),
  });

  return (
    <form
      className="min-w-0 space-y-2 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !create.isPending && path.trim() && branch.trim())
          create.mutate();
      }}
    >
      <h4 className="text-[12px] font-medium text-muted-foreground">
        {t("github.checkout")}
      </h4>
      {pull.fromFork && (
        <p className="text-[11px] text-muted-foreground">
          {t("github.checkout.forkNote")}
          {pull.headRepoFullName ? ` · ${pull.headRepoFullName}` : ""}
        </p>
      )}
      <Field label={t("github.checkout.path")}>
        <Input
          value={path}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setPath(event.target.value)}
          className="h-9 min-w-0"
          required
        />
      </Field>
      <Field label={t("github.checkout.branch")}>
        <Input
          value={branch}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setBranch(event.target.value)}
          className="h-9 min-w-0"
          required
        />
      </Field>
      {!existing && (
        <Field label={t("gitRepo.startPoint")}>
          <Input
            value={startPoint}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setStartPoint(event.target.value)}
            className="h-9 min-w-0"
          />
        </Field>
      )}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="min-h-10"
        disabled={
          busy ||
          create.isPending ||
          !snapshot.data ||
          !path.trim() ||
          !branch.trim()
        }
      >
        {t("github.checkout.submit")}
      </Button>
    </form>
  );
}
