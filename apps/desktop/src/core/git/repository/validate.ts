import { resolveInRoot } from "../../workspaces/roots";
import { validateCloneUrl } from "../clone";
import { badRequest, requireOid } from "../support";
import { isUuid } from "../../workspaces/support";
import { RepositoryService, type RepositoryContext } from "./service";
import { validateMessage, validateStateToken } from "./stash";
import { newWorktreePath } from "./worktrees";
import type { RepositoryAction } from "./types";

/**
 * Everything one action has to pass before it is queued.
 *
 * A port of `RepositoryService::validate_action` in
 * `apps/runtime/src/git/repository/actions.rs`. It runs *before* the operation
 * takes the repository lock, which is the reason it exists as a separate step:
 * a request that cannot be run should be a refusal the caller sees now, not an
 * operation that occupies the queue and then fails.
 */
export async function validateAction(
  service: RepositoryService,
  context: RepositoryContext,
  action: RepositoryAction,
): Promise<void> {
  const repository = context.repository;
  switch (action.kind) {
    case "startCherryPick":
    case "revert":
      requireOid(action.targetOid);
      if (action.mainline === 0) {
        throw badRequest(
          action.kind === "revert"
            ? "Revert mainline starts at parent 1"
            : "Cherry-pick mainline starts at parent 1",
        );
      }
      validateStateToken(action.expectedStateToken);
      return;
    case "checkoutCommit":
      requireOid(action.targetOid);
      return;
    case "reset":
      requireOid(action.targetOid);
      validateStateToken(action.expectedStateToken);
      return;
    case "skipIntegration":
    case "continueIntegration":
    case "abortIntegration":
      if (!isUuid(action.sessionId)) {
        throw badRequest("Integration session ID is invalid");
      }
      validateStateToken(action.expectedStateToken);
      return;
    case "startMerge":
      requireOid(action.targetOid);
      validateMessage(action.message);
      validateStateToken(action.expectedStateToken);
      return;
    case "startRebase":
      await service.validateReference(repository, action.onto);
      validateStateToken(action.expectedStateToken);
      return;
    case "startInteractiveRebase": {
      await service.validateReference(repository, action.onto);
      validateStateToken(action.expectedStateToken);
      if (action.todo.length === 0 || action.todo.length > 1_000) {
        throw badRequest(
          "A rebase todo must list between one and 1000 commits",
        );
      }
      for (const entry of action.todo) {
        requireOid(entry.oid);
        if (entry.command === "reword") {
          if (entry.message === undefined) {
            throw badRequest(
              "A reword must carry the message it replaces the old one with",
            );
          }
          if (
            entry.message.trim() === "" ||
            Buffer.byteLength(entry.message, "utf8") > 10_000 ||
            entry.message.includes("\0")
          ) {
            throw badRequest("A reword needs a message of 1–10000 bytes");
          }
        } else if (entry.message !== undefined) {
          // Refused rather than ignored: a caller that sent a message with a
          // `pick` believed it would be used.
          throw badRequest("Only a reword may carry a message");
        }
      }
      const first = action.todo[0]?.command;
      if (first === "squash" || first === "fixup") {
        throw badRequest(
          "The first replayed commit has nothing to combine into",
        );
      }
      return;
    }
    case "createStash":
      validateMessage(action.message);
      validateStateToken(action.expectedStateToken);
      return;
    case "applyStash":
    case "popStash":
    case "dropStash":
      requireOid(action.oid);
      validateStateToken(action.expectedStateToken);
      return;
    case "createBranch":
      await service.validateBranch(repository, action.name);
      if (action.startPoint !== null) {
        await service.validateReference(repository, action.startPoint);
      }
      return;
    case "switchBranch":
    case "deleteBranch":
      await service.validateBranch(repository, action.name);
      requireOid(action.expectedOid);
      return;
    case "renameBranch":
      await service.validateBranch(repository, action.name);
      await service.validateBranch(repository, action.newName);
      if (action.name === action.newName) {
        throw badRequest("The new branch name is the current one");
      }
      requireOid(action.expectedOid);
      return;
    case "fetch":
      await service.validateRemote(repository, action.remote);
      return;
    case "pull":
      await service.validateRemote(repository, action.remote);
      await service.validateBranch(repository, action.branch);
      return;
    case "sync":
      await service.validateRemote(repository, action.remote);
      await service.validateBranch(repository, action.branch);
      if (action.expectedRemoteOid !== null) {
        requireOid(action.expectedRemoteOid);
      }
      return;
    case "push":
      await service.validateRemote(repository, action.remote);
      await service.validateBranch(repository, action.branch);
      if (action.forceWithLease !== null) {
        requireOid(action.forceWithLease.expectedRemoteOid);
      }
      return;
    case "createTag":
      await service.validateTagName(repository, action.name);
      requireOid(action.targetOid);
      if (action.message !== null) {
        validateMessage(action.message);
        if (action.message.trim() === "") {
          throw badRequest("An annotated tag needs a message");
        }
      }
      return;
    case "deleteTag":
      await service.validateTagName(repository, action.name);
      requireOid(action.expectedOid);
      return;
    case "pushTag":
      await service.validateRemote(repository, action.remote);
      await service.validateTagName(repository, action.name);
      requireOid(action.expectedOid);
      return;
    case "addRemote":
    case "setRemoteUrl":
      await service.validateRemoteName(repository, action.name);
      // The same allow-list clone uses: https, ssh and scp-like only. A local
      // path or a remote helper is refused.
      validateCloneUrl(action.url);
      return;
    case "renameRemote":
      await service.validateRemoteName(repository, action.name);
      await service.validateRemoteName(repository, action.newName);
      if (action.name === action.newName) {
        throw badRequest("The new remote name must differ");
      }
      return;
    case "removeRemote":
      await service.validateRemoteName(repository, action.name);
      return;
    case "createWorktree":
      newWorktreePath(context, action.path);
      await service.validateBranch(repository, action.branch);
      if (!action.createBranch) {
        if (action.expectedOid === null) {
          throw badRequest(
            "Existing worktree branch requires its observed object ID",
          );
        }
        requireOid(action.expectedOid);
      }
      if (action.startPoint !== null) {
        await service.validateReference(repository, action.startPoint);
      }
      return;
    case "removeWorktree":
      resolveInRoot(context.workspaceRoot, action.path);
      requireOid(action.expectedOid);
      return;
  }
}
