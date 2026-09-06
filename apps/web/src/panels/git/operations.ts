// 仓库面板的纯逻辑层：标签集合、进行中判定、快照合并，以及确认框复述一次
// 动作时用的那一行文字。这里不渲染任何东西，所以可以被面板与确认框共用。
import type {
  GitExpectedState,
  GitRepositoryAction,
  GitRepositoryOperation,
} from "@armadra/shared";
import { redactRemoteUrl } from "./Remotes";

export type RepositoryTab =
  | "branches"
  | "history"
  | "worktrees"
  | "stashes"
  | "tags"
  | "remotes"
  | "integration";

export const running = (operation: GitRepositoryOperation | null | undefined) =>
  operation?.state === "queued" || operation?.state === "running";

// Merge network snapshots monotonically. An integration's initial command can
// progress from awaitingResolution/unknownOutcome to a reconciled final state;
// delayed polling and list responses must not bring that command back to life.
export function mergeOperation(
  current: GitRepositoryOperation | null | undefined,
  incoming: GitRepositoryOperation,
): GitRepositoryOperation {
  if (!current || current.id !== incoming.id) return incoming;
  const rank = {
    queued: 0,
    running: 1,
    awaitingResolution: 2,
    unknownOutcome: 3,
    succeeded: 4,
    failed: 4,
    cancelled: 4,
  };
  let result = incoming;
  if (
    rank[incoming.state] < rank[current.state] ||
    (rank[current.state] === 4 && incoming.state !== current.state)
  )
    result = current;
  else if (
    incoming.state === current.state &&
    current.finishedAt &&
    incoming.finishedAt &&
    Date.parse(incoming.finishedAt) < Date.parse(current.finishedAt)
  )
    result = current;
  const cancellationRequested =
    current.cancellationRequested || result.cancellationRequested;
  if (
    result.state === current.state &&
    result.finishedAt === current.finishedAt &&
    result.message === current.message &&
    cancellationRequested === current.cancellationRequested
  )
    return current;
  return cancellationRequested === result.cancellationRequested
    ? result
    : { ...result, cancellationRequested };
}

export type Tracking = {
  operation: GitRepositoryOperation | null;
  pending: boolean;
  uncertain: boolean;
  error: string | null;
};

export const emptyTracking: Tracking = {
  operation: null,
  pending: false,
  uncertain: false,
  error: null,
};

/** 一次等待确认的写操作：动作本身、它被比对的期望状态，以及要复述的提交。 */
export type Confirmation = {
  action: GitRepositoryAction;
  expected: GitExpectedState;
  review?: { oid: string; mainline: number | null; parentOid: string | null };
};

export function actionTarget(action: GitRepositoryAction): string {
  switch (action.kind) {
    case "startCherryPick":
    case "revert":
      return `${action.targetOid}${action.mainline ? ` · parent ${action.mainline}` : ""}`;
    case "checkoutCommit":
      return action.targetOid;
    case "reset":
      return `${action.mode} → ${action.targetOid}`;
    case "createTag":
      return `${action.name} → ${action.targetOid}`;
    case "deleteTag":
      return `${action.name} (${action.expectedOid})`;
    case "pushTag":
      return `${action.remote} / ${action.name} (${action.expectedOid})`;
    case "addRemote":
    case "setRemoteUrl":
      // Never echo a credential back, not even one just typed here.
      return `${action.name} → ${redactRemoteUrl(action.url)}`;
    case "renameRemote":
      return `${action.name} → ${action.newName}`;
    case "removeRemote":
      return action.name;
    case "startMerge":
      return `${action.targetOid}${action.message ? ` · ${action.message}` : ""}`;
    case "startRebase":
      return action.onto;
    case "startInteractiveRebase":
      return `${action.onto} · ${action.todo
        .map((entry) => `${entry.command} ${entry.oid.slice(0, 8)}`)
        .join(", ")}`;
    case "continueIntegration":
    case "abortIntegration":
    case "skipIntegration":
      return action.sessionId;
    case "createStash":
      return action.message || "Stash";
    case "applyStash":
    case "popStash":
    case "dropStash":
      return action.oid;
    case "fetch":
      return action.remote;
    case "pull":
      return `${action.remote} / ${action.branch}`;
    case "push":
      return `${action.remote} / ${action.branch}${action.forceWithLease ? ` ← ${action.forceWithLease.expectedRemoteOid}` : ""}`;
    case "sync":
      return `${action.remote} / ${action.branch} @ ${action.expectedRemoteOid ?? "—"}`;
    case "createBranch":
      return `${action.name} ← ${action.startPoint ?? "HEAD"}`;
    case "switchBranch":
    case "deleteBranch":
      return `${action.name} (${action.expectedOid})`;
    case "createWorktree":
      return `${action.path} · ${action.branch} ← ${action.createBranch ? (action.startPoint ?? "HEAD") : action.expectedOid}`;
    case "removeWorktree":
      return `${action.path} (${action.expectedOid})`;
  }
}
