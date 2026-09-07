// Git 工具窗口的纯逻辑层：一次写在不在跑，以及确认框复述那次写时用的那一行
// 文字。这里不渲染任何东西，所以日志页、提交页与确认框共用它。
import type {
  GitExpectedState,
  GitRepositoryAction,
  GitRepositoryOperation,
} from "@armadra/shared";
import { redactRemoteUrl } from "./actions/refs";

export const running = (operation: GitRepositoryOperation | null | undefined) =>
  operation?.state === "queued" || operation?.state === "running";

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
    case "renameBranch":
      return `${action.name} → ${action.newName} (${action.expectedOid})`;
    case "createWorktree":
      return `${action.path} · ${action.branch} ← ${action.createBranch ? (action.startPoint ?? "HEAD") : action.expectedOid}`;
    case "removeWorktree":
      return `${action.path} (${action.expectedOid})`;
  }
}
