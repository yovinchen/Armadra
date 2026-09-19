import { badRequest, conflict, malformed, oneLine } from "../support";
import { verifyCherryPick, verifyRevert } from "./cherrypick";
import {
  type Recovery,
  gitIntegration,
  integrationSnapshot,
  ownsIntegration,
  protectAbortPaths,
  releaseIntegrationOwner,
} from "./integration";
import { splitNul } from "./parse";
import { verifyRebase } from "./rebase";
import {
  type Operation,
  RepositoryService,
  type RepositoryContext,
  commandError,
} from "./service";
import { protectLocalPaths, sameHead } from "./stash";
import type { ExpectedState } from "./types";

/**
 * Starting a merge, and resuming any owned integration sequence.
 *
 * A port of `apps/runtime/src/git/repository/integration/merge.rs`. Resume is
 * here rather than beside each starter because the four kinds share one shape:
 * confirm ownership and state, run one Git verb, then prove the repository
 * ended up where the caller was told it would.
 */

export async function startMerge(
  service: RepositoryService,
  context: RepositoryContext,
  targetOid: string,
  message: string,
  expectedToken: string,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  const state = await integrationSnapshot(service, context, signal);
  if (state.kind !== "none") {
    throw conflict("An existing Git operation must be completed first");
  }
  if (!sameHead(state.head, expected) || state.stateToken !== expectedToken) {
    throw conflict(
      "Repository state changed; refresh and confirm the merge again",
    );
  }
  if (
    state.dirty ||
    state.conflicts.length > 0 ||
    state.head.headOid === null ||
    state.head.branch === null
  ) {
    throw conflict(
      "Merge requires a clean worktree and index on a committed local branch",
    );
  }
  if (
    (await service.resolve(context.repository, targetOid, signal)) !== targetOid
  ) {
    throw badRequest("Merge target must be a commit object ID");
  }
  const head = expected.headOid;
  if (head === null) throw malformed();
  const touchedRaw = await service.read(
    context.repository,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "--no-renames",
      "-z",
      head,
      targetOid,
      "--",
    ],
    signal,
  );
  const touched = new Set(
    splitNul(touchedRaw)
      .filter((path) => path.length > 0)
      .map((path) => path.toString("utf8")),
  );
  await protectLocalPaths(service, context, touched, signal);

  const sessionId = operation.snapshot.id;
  service.integrations.set(context.repository, {
    sessionId,
    kind: "merge",
    mainline: null,
    original: expected,
    targetOid,
    marker: null,
  });
  const command = [
    "-c",
    "rerere.enabled=false",
    "merge",
    "--no-ff",
    "--no-commit",
    "--no-autostash",
    "--no-overwrite-ignore",
    "--no-rerere-autoupdate",
  ];
  if (message !== "") command.push("-m", message);
  command.push("--", targetOid);

  let output;
  let failure: unknown;
  try {
    output = await service.output(
      context.repository,
      command,
      service.commandTimeoutMs,
      signal,
      {
        onMutationStarted: () => {
          operation.mutationStarted = true;
        },
      },
    );
  } catch (error) {
    failure = error;
  }
  // Read with a fresh token after a cancelled child has been reaped: this can
  // bind the marker that is actually left behind without retrying anything.
  const actual = await safely(() => gitIntegration(service, context));
  const actualHead = await safely(() => service.head(context.repository));
  let owns = false;
  if (actual.ok && actualHead.ok) {
    const owner = service.integrations.get(context.repository);
    if (owner !== undefined) {
      if (
        actual.value.kind === "merge" &&
        actual.value.targetOid === targetOid &&
        actual.value.originalHead === expected.headOid &&
        sameHead(actualHead.value, expected)
      ) {
        owner.marker = actual.value.marker;
        owns = ownsIntegration(owner, actual.value, actualHead.value);
      } else if (actual.value.kind === "none") {
        service.integrations.delete(context.repository);
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (!actual.ok) throw actual.error;
  if (!actualHead.ok) throw actualHead.error;
  if (output === undefined) throw malformed();
  if (owns && (output.status === 0 || output.status === 1)) {
    operation.awaitingResolution = true;
    return;
  }
  if (output.status !== 0) throw commandError(output);
  if (actual.value.kind !== "none" || !sameHead(actualHead.value, expected)) {
    throw conflict(
      "Merge ownership or HEAD could not be verified after Git exited; inspect current state",
    );
  }
  const ancestor = await service.output(
    context.repository,
    ["merge-base", "--is-ancestor", targetOid, head],
    15_000,
    signal,
  );
  if (ancestor.status !== 0) {
    throw conflict(
      "Git returned without a merge state or reachable target; inspect the repository",
    );
  }
}

export async function resumeIntegration(
  service: RepositoryService,
  context: RepositoryContext,
  sessionId: string,
  expectedToken: string,
  expected: ExpectedState,
  recovery: Recovery,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  const state = await integrationSnapshot(service, context, signal);
  if (
    !state.owned ||
    state.sessionId !== sessionId ||
    !sameHead(state.head, expected) ||
    state.stateToken !== expectedToken
  ) {
    throw conflict(
      "Integration ownership or repository state changed; refresh before continuing",
    );
  }
  if (recovery === "continue" && !state.canContinue) {
    throw conflict(
      "Resolve all conflicts and stage the saved results before continuing",
    );
  }
  if (recovery === "skip" && !state.canSkip) {
    throw conflict(
      "Only an owned empty cherry-pick or a paused rebase can be skipped; other work must be resolved or explicitly aborted",
    );
  }
  if (recovery !== "continue") {
    if (state.originalHead === null) throw malformed();
    await protectAbortPaths(service, context, state.originalHead, signal);
  }
  const command = recoveryCommand(state.kind, recovery);
  await service.mutate(context, command, operation);
  const after = await gitIntegration(service, context, signal);
  const head = await service.head(context.repository, signal);
  // Abort returns a rebase to its recorded branch, not to the detached head
  // the caller confirmed; every other kind leaves HEAD where it was.
  const restored: ExpectedState =
    state.kind === "rebase"
      ? { headOid: state.originalHead, branch: state.originalBranch }
      : expected;
  if (
    state.kind === "rebase" &&
    recovery !== "abort" &&
    after.kind === "rebase"
  ) {
    // A replay can stop again on the next commit — after a continue and
    // equally after a skip. That is still the same owned sequence.
    const owner = service.integrations.get(context.repository);
    if (owner !== undefined && ownsIntegration(owner, after, head)) {
      operation.awaitingResolution = true;
      return;
    }
  }
  // A finished abort has to land back where the sequence started, and so does
  // a skipped cherry-pick. A skipped rebase is the exception: dropping one
  // replayed commit and finishing the rest is *supposed* to move HEAD.
  const mustRestore =
    recovery === "abort" || (recovery === "skip" && state.kind !== "rebase");
  if (after.kind !== "none" || (mustRestore && !sameHead(head, restored))) {
    throw conflict(
      "Git did not finish the requested recovery; inspect the current state before another action",
    );
  }
  if (recovery === "continue" && state.kind === "cherryPick") {
    if (state.targetOid === null) throw malformed();
    await verifyCherryPick(
      service,
      context,
      state.targetOid,
      expected,
      head,
      signal,
    );
  }
  if (recovery === "continue" && state.kind === "revert") {
    if (state.targetOid === null) throw malformed();
    await verifyRevert(
      service,
      context,
      state.targetOid,
      expected,
      head,
      signal,
    );
  }
  // A rebase that finished is verified whether the last decision was a
  // continue or a skip: both end with the branch back on itself and the
  // confirmed target reachable.
  if (recovery !== "abort" && state.kind === "rebase") {
    await verifyRebase(service, context, state, head, signal);
  }
  if (recovery === "continue" && state.kind === "merge") {
    const commit = head.headOid;
    if (commit === null) throw malformed();
    const parentLine = oneLine(
      await service.read(
        context.repository,
        ["rev-list", "--parents", "-n", "1", commit, "--"],
        signal,
      ),
    );
    const parents = parentLine
      .split(/\s+/)
      .slice(1)
      .filter((v) => v !== "");
    if (expected.headOid === null || state.targetOid === null)
      throw malformed();
    if (
      head.branch !== expected.branch ||
      parents.length !== 2 ||
      parents[0] !== expected.headOid ||
      parents[1] !== state.targetOid
    ) {
      throw conflict(
        "The resulting commit does not match the confirmed merge parents; inspect HEAD",
      );
    }
  }
  releaseIntegrationOwner(
    service,
    context,
    sessionId,
    recovery === "abort" ? "cancelled" : "succeeded",
    recovery === "abort"
      ? "Git integration was explicitly aborted; its starting state was restored"
      : recovery === "continue"
        ? "Git integration was completed by a confirmed continuation"
        : state.kind === "rebase"
          ? "The replayed commit the rebase stopped on was explicitly skipped"
          : "The empty cherry-pick was explicitly skipped; HEAD was preserved",
  );
}

function recoveryCommand(kind: string, recovery: Recovery): string[] {
  if (kind === "merge" && recovery === "abort") return ["merge", "--abort"];
  if (kind === "merge" && recovery === "continue") {
    return ["-c", "core.editor=:", "commit", "--no-edit"];
  }
  if (kind === "cherryPick") {
    return [
      "-c",
      "core.editor=:",
      "cherry-pick",
      recovery === "continue"
        ? "--continue"
        : recovery === "abort"
          ? "--abort"
          : "--skip",
    ];
  }
  // Skip belongs to an empty cherry-pick only; dropping a revert silently
  // would leave the change it was meant to undo in place.
  if (kind === "revert" && recovery !== "skip") {
    return [
      "-c",
      "core.editor=:",
      "revert",
      recovery === "continue" ? "--continue" : "--abort",
    ];
  }
  if (kind === "rebase") {
    return [
      "-c",
      "core.editor=:",
      "-c",
      "rerere.enabled=false",
      "rebase",
      recovery === "continue"
        ? "--continue"
        : recovery === "abort"
          ? "--abort"
          : "--skip",
    ];
  }
  throw conflict("This Git operation is not managed by the current service");
}

/** Runs `work`, reporting the failure instead of throwing it. */
export async function safely<T>(
  work: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}
