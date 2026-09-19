import { conflict, malformed } from "../support";
import {
  type Operation,
  RepositoryService,
  type RepositoryContext,
} from "./service";
import type { ExpectedState, ForceWithLease } from "./types";

/**
 * The network traffic: fetch, fast-forward pull, push and the Sync that is all
 * three in one owned sequence.
 *
 * A port of `apps/runtime/src/git/repository/remotes.rs`. Two rules run through
 * all of it: a diverged branch stops the sequence and is reported — nothing is
 * merged, rebased or force-pushed to make three steps "succeed" — and a force
 * push exists only as `--force-with-lease` against the exact remote OID the
 * caller reviewed.
 */

/**
 * `--no-force` stays on every push; it disables the blanket force flag without
 * cancelling an explicit lease, so a rewrite can only happen against the OID
 * the caller reviewed. There is no code path that omits both.
 */
export function pushArguments(
  remote: string,
  branch: string,
  oid: string,
  lease: ForceWithLease | null,
): string[] {
  // `--progress` because stderr is a pipe here, not a terminal, and Git only
  // reports counters when it believes somebody is watching.
  const args = [
    "push",
    "--porcelain",
    "--progress",
    "--no-force",
    "--no-mirror",
    "--no-follow-tags",
  ];
  if (lease !== null) {
    args.push(
      `--force-with-lease=refs/heads/${branch}:${lease.expectedRemoteOid}`,
    );
  }
  args.push("--", remote, `${oid}:refs/heads/${branch}`);
  return args;
}

/**
 * Fetch, fast-forward pull, push — in that order, in one owned operation.
 */
export async function sync(
  service: RepositoryService,
  context: RepositoryContext,
  remote: string,
  branch: string,
  expectedRemoteOid: string | null,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  await service.validateRemote(context.repository, remote, signal);
  if (expected.branch !== branch) {
    throw conflict("Sync must target the observed current local branch");
  }
  if (expected.headOid === null) {
    throw conflict("Sync requires at least one local commit");
  }
  const observed = await service.remoteTrackingOid(
    context.repository,
    remote,
    branch,
    signal,
  );
  if (observed !== expectedRemoteOid) {
    throw conflict(
      `Remote tracking ref changed before Sync started: refs/remotes/${remote}/${branch} is ${observed ?? "absent"}, not the reviewed ${expectedRemoteOid ?? "absent"}`,
    );
  }
  try {
    await service.mutate(
      context,
      [
        "fetch",
        "--atomic",
        "--progress",
        "--no-recurse-submodules",
        "--no-prune",
        "--no-prune-tags",
        "--",
        remote,
      ],
      operation,
    );
  } catch (error) {
    throw await syncStop(service, context, remote, branch, "fetch", error);
  }
  try {
    await fastForwardPull(
      service,
      context,
      remote,
      branch,
      expected,
      operation,
    );
  } catch (error) {
    throw await syncStop(service, context, remote, branch, "pull", error);
  }
  const head = await service.head(context.repository, signal);
  if (head.branch !== branch) {
    throw conflict("The local branch changed during Sync; nothing was pushed");
  }
  if (head.headOid === null) {
    throw conflict("Sync found no commit to push");
  }
  try {
    await service.mutate(
      context,
      pushArguments(remote, branch, head.headOid, null),
      operation,
    );
  } catch (error) {
    throw await syncStop(service, context, remote, branch, "push", error);
  }
}

/**
 * Name the step that stopped and the state the user has to act on. A read that
 * itself fails is reported as unknown rather than as a clean value.
 */
async function syncStop(
  service: RepositoryService,
  context: RepositoryContext,
  remote: string,
  branch: string,
  step: string,
  error: unknown,
): Promise<Error> {
  let position = "unreadable";
  try {
    const state = await service.head(context.repository);
    position = `${state.headOid ?? "no commit"} on ${
      state.branch === null ? "a detached HEAD" : `branch ${state.branch}`
    }`;
  } catch {
    position = "unreadable";
  }
  let remoteOid = "unreadable";
  try {
    remoteOid =
      (await service.remoteTrackingOid(context.repository, remote, branch)) ??
      "absent";
  } catch {
    remoteOid = "unreadable";
  }
  const message = error instanceof Error ? error.message : String(error);
  return conflict(
    `Sync stopped at the ${step} step and merged, rebased, or forced nothing: ${message}. HEAD is ${position}; refs/remotes/${remote}/${branch} is ${remoteOid}`,
  );
}

/**
 * Fetch the remote branch into a uniquely named temporary ref, fast-forward
 * onto it, then delete that ref.
 *
 * The temporary ref is what makes this a *fast-forward only* pull: nothing
 * merges, nothing autostashes, and a cancelled operation may retain the ref
 * for inspection rather than being retried or force-deleted.
 */
export async function fastForwardPull(
  service: RepositoryService,
  context: RepositoryContext,
  remote: string,
  branch: string,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  const fetchedRef = `refs/armadra/pull/${operation.snapshot.id}`;
  const existing = await service.output(
    context.repository,
    ["show-ref", "--verify", "--quiet", fetchedRef],
    15_000,
    signal,
  );
  if (existing.status !== 1) {
    throw conflict("Temporary pull reference is already in use");
  }
  await service.mutate(
    context,
    [
      "fetch",
      "--atomic",
      "--progress",
      "--no-prune",
      "--no-prune-tags",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      remote,
      `refs/heads/${branch}:${fetchedRef}`,
    ],
    operation,
  );
  const oid = await service.resolve(context.repository, fetchedRef, signal);
  let merged: unknown;
  const head = await service.head(context.repository, signal);
  if (head.headOid !== expected.headOid || head.branch !== expected.branch) {
    merged = conflict(
      "HEAD changed during fetch; no fast-forward was attempted",
    );
  } else {
    try {
      await service.mutate(
        context,
        [
          "merge",
          "--ff-only",
          "--no-autostash",
          "--no-overwrite-ignore",
          "--",
          oid,
        ],
        operation,
      );
    } catch (error) {
      merged = error;
    }
  }
  let cleanup: unknown;
  try {
    await service.mutate(
      context,
      ["update-ref", "-d", fetchedRef, oid],
      operation,
    );
  } catch (error) {
    cleanup = error;
  }
  if (merged !== undefined) throw merged;
  if (cleanup !== undefined) throw cleanup;
}

export { malformed };
