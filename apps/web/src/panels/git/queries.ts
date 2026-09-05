import type { QueryClient } from "@tanstack/react-query";

/** Every Git write can change both the repository view and AI draft input. */
export function invalidateGitQueries(
  client: QueryClient,
  workspaceId: string | null,
) {
  if (!workspaceId) return;
  for (const name of [
    "git-status",
    "git-head-commit",
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
  ])
    void client.invalidateQueries({ queryKey: [name, workspaceId] });
}
