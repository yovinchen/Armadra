import type { GitBranchRecord, GitRepositoryAction } from "@armadra/shared";

/**
 * The one place a `createWorktree` action is built.
 *
 * `Worktrees.tsx` and the GitHub page's local checkout both go through here so
 * there is a single definition of what "create a worktree" means: creating a
 * branch carries no expected OID, and checking an existing one out must carry
 * the OID that was displayed, or the Runtime would move a branch nobody looked
 * at. The Runtime is still the only thing that runs Git — this builds a request
 * for `runtimeApi.gitRepositoryOperate`, it does not perform one.
 */
export interface WorktreeRequest {
  path: string;
  branch: string;
  createBranch: boolean;
  /** Where a newly created branch starts; ignored when checking one out. */
  startPoint?: string | null;
  /** The branch as it was displayed, when checking an existing one out. */
  existing?: GitBranchRecord | null;
}

export function createWorktreeAction(
  request: WorktreeRequest,
): GitRepositoryAction | null {
  const path = request.path.trim();
  const branch = request.branch.trim();
  if (!path || !branch) return null;
  if (!request.createBranch && !request.existing) return null;
  return {
    kind: "createWorktree",
    path,
    branch,
    createBranch: request.createBranch,
    expectedOid: request.createBranch ? null : request.existing!.oid,
    startPoint: request.createBranch
      ? (request.startPoint ?? "").trim() || null
      : null,
  };
}

/** The local branch of that name, if this repository has one. */
export function localBranch(
  branches: readonly GitBranchRecord[],
  name: string,
): GitBranchRecord | null {
  return (
    branches.find((record) => !record.remote && record.name === name) ?? null
  );
}
