import { canonicalize, contains, resolveInRoot } from "../../workspaces/roots";
import {
  badRequest,
  conflict,
  forbidden,
  malformed,
  oneLine,
} from "../support";
import { tagRecord } from "./branches";
import { startCherryPick } from "./cherrypick";
import { ensureIntegrationIdle } from "./integration";
import { resumeIntegration, startMerge } from "./merge";
import { startInteractiveRebase, startRebase } from "./rebase";
import { fastForwardPull, pushArguments, sync } from "./remotes";
import {
  type Operation,
  RepositoryService,
  type RepositoryContext,
} from "./service";
import { executeStash, reset, sameHead } from "./stash";
import {
  createWorktreeParents,
  newWorktreePath,
  protectNestedWorktree,
  worktreeRecords,
} from "./worktrees";
import { type ExpectedState, type RepositoryAction, resetFlag } from "./types";

/**
 * Running one validated action to completion.
 *
 * A port of the pre-merge implementation, plus the tag and
 * remote writers that lived in the pre-merge implementation. The order at the top is the
 * important part and is unchanged: the repository is revalidated, HEAD is
 * compared with the state the caller reviewed, and — for everything that is
 * not itself an integration verb — an in-progress Git sequence is refused
 * before anything is written.
 */

export async function execute(
  service: RepositoryService,
  context: RepositoryContext,
  action: RepositoryAction,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  await service.revalidateContext(context, signal);
  const head = await service.head(context.repository, signal);
  if (!sameHead(head, expected)) {
    throw conflict("Repository HEAD changed; reload before retrying");
  }
  const integrationVerbs = [
    "startMerge",
    "startCherryPick",
    "revert",
    "startRebase",
    "startInteractiveRebase",
    "skipIntegration",
    "continueIntegration",
    "abortIntegration",
  ];
  if (!integrationVerbs.includes(action.kind)) {
    await ensureIntegrationIdle(service, context, signal);
  }

  switch (action.kind) {
    case "startCherryPick":
    case "revert":
      return startCherryPick(service, context, action, expected, operation);
    case "checkoutCommit": {
      // The OID is immutable, so confirming it resolves to a commit here is
      // the whole precondition; HEAD was already compared above.
      if (
        (await service.resolve(
          context.repository,
          action.targetOid,
          signal,
        )) !== action.targetOid
      ) {
        throw badRequest("Checkout target must be a commit object ID");
      }
      return service.mutate(
        context,
        ["switch", "--detach", "--no-overwrite-ignore", action.targetOid],
        operation,
      );
    }
    case "startRebase":
      return startRebase(
        service,
        context,
        action.onto,
        action.expectedStateToken,
        expected,
        operation,
      );
    case "startInteractiveRebase":
      return startInteractiveRebase(
        service,
        context,
        action,
        expected,
        operation,
      );
    case "skipIntegration":
      return resumeIntegration(
        service,
        context,
        action.sessionId,
        action.expectedStateToken,
        expected,
        "skip",
        operation,
      );
    case "startMerge":
      return startMerge(
        service,
        context,
        action.targetOid,
        action.message,
        action.expectedStateToken,
        expected,
        operation,
      );
    case "continueIntegration":
      return resumeIntegration(
        service,
        context,
        action.sessionId,
        action.expectedStateToken,
        expected,
        "continue",
        operation,
      );
    case "abortIntegration":
      return resumeIntegration(
        service,
        context,
        action.sessionId,
        action.expectedStateToken,
        expected,
        "abort",
        operation,
      );
    case "createStash":
    case "applyStash":
    case "popStash":
    case "dropStash":
      return executeStash(service, context, action, expected, operation);
    case "createTag":
    case "deleteTag":
    case "pushTag":
      return executeTag(service, context, action, operation);
    case "addRemote":
    case "renameRemote":
    case "setRemoteUrl":
    case "removeRemote":
      return executeRemote(service, context, action, operation);
    case "reset":
      return reset(service, context, action, expected, operation);
    case "createBranch": {
      const oid = await service.resolve(
        context.repository,
        action.startPoint ?? "HEAD",
        signal,
      );
      return service.mutate(
        context,
        action.switch
          ? [
              "switch",
              "--no-guess",
              "--no-overwrite-ignore",
              "--no-track",
              "-c",
              action.name,
              oid,
            ]
          : ["branch", "--no-track", "--", action.name, oid],
        operation,
      );
    }
    case "switchBranch":
    case "deleteBranch": {
      if (
        (await service.resolve(
          context.repository,
          `refs/heads/${action.name}`,
          signal,
        )) !== action.expectedOid
      ) {
        throw conflict("Selected branch changed; reload before retrying");
      }
      return service.mutate(
        context,
        action.kind === "switchBranch"
          ? ["switch", "--no-guess", "--no-overwrite-ignore", "--", action.name]
          : ["branch", "--delete", "--", action.name],
        operation,
      );
    }
    case "renameBranch": {
      if (
        (await service.resolve(
          context.repository,
          `refs/heads/${action.name}`,
          signal,
        )) !== action.expectedOid
      ) {
        throw conflict("Selected branch changed; reload before retrying");
      }
      // No `--force`: a destination that already exists is Git's refusal, not
      // an overwrite of somebody else's branch.
      await service.mutate(
        context,
        ["branch", "--move", "--", action.name, action.newName],
        operation,
      );
      if (
        (await service.resolve(
          context.repository,
          `refs/heads/${action.newName}`,
          signal,
        )) !== action.expectedOid
      ) {
        throw conflict(
          "The renamed branch does not name the reviewed commit; inspect it with Git",
        );
      }
      return;
    }
    case "fetch": {
      await service.validateRemote(context.repository, action.remote, signal);
      const args = [
        "fetch",
        "--atomic",
        "--progress",
        "--no-recurse-submodules",
        action.prune ? "--prune" : "--no-prune",
        "--no-prune-tags",
        "--",
        action.remote,
      ];
      return service.mutate(context, args, operation);
    }
    case "pull": {
      await service.validateRemote(context.repository, action.remote, signal);
      if (expected.branch === null) {
        throw conflict("Pull requires an attached local branch");
      }
      return fastForwardPull(
        service,
        context,
        action.remote,
        action.branch,
        expected,
        operation,
      );
    }
    case "sync":
      return sync(
        service,
        context,
        action.remote,
        action.branch,
        action.expectedRemoteOid,
        expected,
        operation,
      );
    case "push": {
      await service.validateRemote(context.repository, action.remote, signal);
      if (expected.branch !== action.branch) {
        throw conflict("Push must target the observed current local branch");
      }
      if (expected.headOid === null) {
        throw conflict("There are no commits to push");
      }
      await service.mutate(
        context,
        pushArguments(
          action.remote,
          action.branch,
          expected.headOid,
          action.forceWithLease,
        ),
        operation,
      );
      if (action.setUpstream) {
        await service.mutate(
          context,
          [
            "branch",
            `--set-upstream-to=${action.remote}/${action.branch}`,
            "--",
            action.branch,
          ],
          operation,
        );
      }
      return;
    }
    case "createWorktree": {
      const target = newWorktreePath(context, action.path);
      const args = ["worktree", "add"];
      if (action.createBranch) {
        const oid = await service.resolve(
          context.repository,
          action.startPoint ?? "HEAD",
          signal,
        );
        args.push("--no-track", "-b", action.branch, "--", target, oid);
      } else {
        if (action.startPoint !== null) {
          throw badRequest(
            "An existing worktree branch cannot have a different start point",
          );
        }
        const actual = await service.resolve(
          context.repository,
          `refs/heads/${action.branch}`,
          signal,
        );
        if (action.expectedOid !== actual) {
          throw conflict(
            "Worktree branch changed; reload before creating the checkout",
          );
        }
        args.push("--", target, action.branch);
      }
      // Register the exact nested checkout in private Git excludes, so a later
      // Stage All cannot stage a repository inside itself.
      for (const worktree of await worktreeRecords(service, context, signal)) {
        if (worktree.bare) continue;
        protectNestedWorktree(context, worktree.path, target, operation);
      }
      const parents = createWorktreeParents(context, target, operation);
      try {
        await service.mutate(context, args, operation);
      } catch (error) {
        parents.rollback();
        throw error;
      }
      return;
    }
    case "removeWorktree": {
      const target = resolveInRoot(context.workspaceRoot, action.path);
      if (contains(context.commonDir, target)) {
        throw forbidden(
          "Git administration directories cannot be removed as worktrees",
        );
      }
      const records = await worktreeRecords(service, context, signal);
      const record = records.find((entry) => sameDirectory(entry.path, target));
      if (record === undefined) {
        throw badRequest("Path is not a registered worktree");
      }
      if (
        record.isMain ||
        record.bare ||
        record.locked ||
        record.prunable ||
        record.dirty !== false
      ) {
        throw conflict(
          "Main, locked, missing, or dirty worktrees cannot be removed",
        );
      }
      if (record.headOid !== action.expectedOid) {
        throw conflict("Worktree HEAD changed; reload before removing");
      }
      if (!action.allowUnpublished) {
        const output = await service.read(
          target,
          ["rev-list", "--count", "HEAD", "--not", "--remotes"],
          signal,
        );
        const count = Number.parseInt(oneLine(output), 10);
        if (Number.isNaN(count)) throw malformed();
        if (count > 0) {
          throw conflict(
            "Worktree contains unpublished commits; review and explicitly acknowledge them first",
          );
        }
      }
      return service.mutate(
        context,
        ["worktree", "remove", "--", target],
        operation,
      );
    }
  }
}

async function executeTag(
  service: RepositoryService,
  context: RepositoryContext,
  action: RepositoryAction,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  if (action.kind === "createTag") {
    if (
      (await service.resolve(context.repository, action.targetOid, signal)) !==
      action.targetOid
    ) {
      throw badRequest("Tag target must be a commit object ID");
    }
    if (
      (await tagRecord(service, context.repository, action.name, signal)) !==
      undefined
    ) {
      throw conflict(
        "A tag with this name already exists; delete it explicitly first",
      );
    }
    // No `--force` anywhere: replacing a tag is delete plus create, both
    // confirmed against the object the caller reviewed.
    const command = ["tag"];
    if (action.message !== null) {
      command.push("--annotate", "--message", action.message);
    }
    command.push("--", action.name, action.targetOid);
    await service.mutate(context, command, operation);
    const created = await tagRecord(
      service,
      context.repository,
      action.name,
      signal,
    );
    if (created === undefined) throw conflict("The tag was not created");
    if (
      created.targetOid !== action.targetOid ||
      created.annotated !== (action.message !== null)
    ) {
      throw conflict(
        "The created tag does not match the confirmed commit; inspect it with Git",
      );
    }
    return;
  }
  if (action.kind === "deleteTag") {
    await expectedTag(
      service,
      context,
      action.name,
      action.expectedOid,
      signal,
    );
    await service.mutate(
      context,
      ["tag", "--delete", "--", action.name],
      operation,
    );
    if (
      (await tagRecord(service, context.repository, action.name, signal)) !==
      undefined
    ) {
      throw conflict(
        "The tag still exists after the delete; inspect it with Git",
      );
    }
    return;
  }
  if (action.kind === "pushTag") {
    await service.validateRemote(context.repository, action.remote, signal);
    await expectedTag(
      service,
      context,
      action.name,
      action.expectedOid,
      signal,
    );
    // `--no-force` and no lease: publishing a tag never overwrites a different
    // object already published under that name.
    await service.mutate(
      context,
      [
        "push",
        "--porcelain",
        "--progress",
        "--no-force",
        "--no-mirror",
        "--no-follow-tags",
        "--",
        action.remote,
        `${action.expectedOid}:refs/tags/${action.name}`,
      ],
      operation,
    );
    return;
  }
  throw malformed();
}

async function expectedTag(
  service: RepositoryService,
  context: RepositoryContext,
  name: string,
  expectedOid: string,
  signal?: AbortSignal,
): Promise<void> {
  const existing = await tagRecord(service, context.repository, name, signal);
  if (existing === undefined) {
    throw conflict("The tag no longer exists; refresh first");
  }
  if (existing.oid !== expectedOid) {
    throw conflict(
      "The tag now names a different object; refresh before retrying",
    );
  }
}

async function executeRemote(
  service: RepositoryService,
  context: RepositoryContext,
  action: RepositoryAction,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  if (action.kind === "addRemote") {
    if (
      (await service.remotes(context.repository, signal)).includes(action.name)
    ) {
      throw conflict("A remote with this name already exists");
    }
    await service.mutate(
      context,
      ["remote", "add", "--", action.name, action.url],
      operation,
    );
    return service.validateRemote(context.repository, action.name, signal);
  }
  if (action.kind === "renameRemote") {
    await service.validateRemote(context.repository, action.name, signal);
    if (
      (await service.remotes(context.repository, signal)).includes(
        action.newName,
      )
    ) {
      throw conflict("A remote with the new name already exists");
    }
    await service.mutate(
      context,
      ["remote", "rename", "--", action.name, action.newName],
      operation,
    );
    return service.validateRemote(context.repository, action.newName, signal);
  }
  if (action.kind === "setRemoteUrl") {
    await service.validateRemote(context.repository, action.name, signal);
    await service.mutate(
      context,
      ["remote", "set-url", "--", action.name, action.url],
      operation,
    );
    return service.validateRemote(context.repository, action.name, signal);
  }
  if (action.kind === "removeRemote") {
    await service.validateRemote(context.repository, action.name, signal);
    await service.mutate(
      context,
      ["remote", "remove", "--", action.name],
      operation,
    );
    if (
      (await service.remotes(context.repository, signal)).includes(action.name)
    ) {
      throw conflict("The remote still exists after the removal");
    }
    return;
  }
  throw malformed();
}

/**
 * Git prints absolute paths, and the target came through `resolveInRoot`;
 * both sides are canonicalised before they are compared, because a symlinked
 * root would otherwise make a registered worktree look unregistered.
 */
function sameDirectory(left: string, right: string): boolean {
  return canonicalOrSelf(left) === canonicalOrSelf(right);
}

function canonicalOrSelf(path: string): string {
  try {
    return canonicalize(path);
  } catch {
    return path;
  }
}

export { resetFlag };
