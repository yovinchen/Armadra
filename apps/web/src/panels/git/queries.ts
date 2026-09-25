import type { QueryClient } from "@tanstack/react-query";

/** Every Git write can change both the repository view and AI draft input. */
export function invalidateGitQueries(
  client: QueryClient,
  workspaceId: string | null,
) {
  if (!workspaceId) return;
  for (const name of [
    // The repository set itself can change — a worktree added or removed — and
    // the aggregate Changes view reads every repository's status (§4.1).
    "git-repositories",
    "git-status-all",
    "git-status",
    "git-head-commit",
    "git-repository-commit",
    "git-repository-commit-file",
    "git-diff",
    "git-hunks",
    "git-message-source",
    "git-repository-branches",
    "git-repository-history",
    // 引用日志与绑定判定都会被一次写改变：reset 之后 reflog 多一条，
    // createWorktree / removeWorktree 之后绑定的结论可能翻过来。
    "git-repository-reflog",
    "git-worktree-binding",
    "git-repository-worktrees",
    "git-repository-operations",
    "git-repository-integration",
    "git-repository-stashes",
    "git-repository-stash-detail",
    "git-repository-tags",
    "git-repository-remotes",
    "git-repository-rebase-todo",
    // 日志页的历史表与分支树：提交页里提交、暂存页里 Stash 之后切过去，
    // 不重读就停在写之前。
    "git-log",
    "git-refs",
  ])
    void client.invalidateQueries({ queryKey: [name, workspaceId] });
}
