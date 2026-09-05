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
    "git-repository-worktrees",
    "git-repository-operations",
    "git-repository-integration",
    "git-repository-stashes",
    "git-repository-stash-detail",
    "git-repository-tags",
    "git-repository-remotes",
    "git-repository-rebase-todo",
  ])
    void client.invalidateQueries({ queryKey: [name, workspaceId] });
}
