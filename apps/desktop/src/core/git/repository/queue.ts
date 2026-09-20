import { uuidV7 } from "../../workspaces/support";
import {
  badRequest,
  nowRfc3339,
  sanitizeRepository,
  validOid,
} from "../support";
import { execute } from "./execute";
import { type Operation, RepositoryService, repositoryId } from "./service";
import { validateAction } from "./validate";
import type {
  ExpectedState,
  OperationSnapshot,
  RepositoryAction,
} from "./types";

/**
 * Starting one repository mutation.
 *
 * A port of `RepositoryService::start` in
 * the pre-merge implementation. Three things happen in this order
 * and the order is the contract:
 *
 *   1. The action is validated and the reviewed state is checked — a request
 *      that cannot run is refused *now*, not after it has occupied the queue.
 *   2. The entry is registered and its **position in the repository's lock is
 *      reserved**, before this function returns. Reserving late would let a
 *      request that arrived second run first, which is the one thing a serial
 *      queue exists to prevent.
 *   3. The work runs detached. The caller polls
 *      `GET …/operations/{id}`; nothing here waits for `git`.
 *
 * Cancellation and failure are told apart by `mutationStarted`: once a
 * mutating child has existed the outcome is **unknown**, never "failed", and
 * the panel says so rather than offering a retry.
 */
export async function startOperation(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
  action: RepositoryAction,
  expected: ExpectedState,
): Promise<OperationSnapshot> {
  service.requireExecutionGrant("Git repository writes and synchronization");
  const context = await service.context(workspaceRoot, requested);
  await validateAction(service, context, action);
  if (expected.headOid !== null && !validOid(expected.headOid)) {
    throw badRequest("Expected HEAD must be an object ID");
  }
  if (expected.branch !== null) {
    await service.validateBranch(context.repository, expected.branch);
  }
  const snapshot: OperationSnapshot = {
    id: uuidV7(),
    repositoryId: repositoryId(context),
    workspaceRoot: context.workspaceRoot,
    repositoryPath: context.repository,
    action,
    state: "queued",
    cancellationRequested: false,
    progress: 0,
    createdAt: nowRfc3339(),
    finishedAt: null,
    message: null,
  };
  const operation: Operation = {
    snapshot,
    controller: new AbortController(),
    mutationStarted: false,
    awaitingResolution: false,
    progress: 0,
  };
  const recovery =
    (action.kind === "continueIntegration" ||
      action.kind === "abortIntegration" ||
      action.kind === "skipIntegration") &&
    service.integrations.get(context.repository)?.sessionId ===
      action.sessionId;
  service.register(operation, recovery);

  // The lock position is reserved here, synchronously with the registration,
  // so the queue is FIFO in the order requests arrived rather than in the
  // order their tasks happen to be scheduled.
  const acquired = service.acquire(context.commonDir);
  void (async () => {
    const release = await acquired;
    try {
      if (operation.controller.signal.aborted) {
        service.finish(
          operation,
          "cancelled",
          "Cancelled before any repository mutation",
        );
        return;
      }
      operation.snapshot = { ...operation.snapshot, state: "running" };
      try {
        await execute(service, context, action, expected, operation);
        if (operation.awaitingResolution) {
          service.finish(
            operation,
            "awaitingResolution",
            "Git integration is paused; inspect its state, then explicitly continue, abort, or skip an empty pick",
          );
        } else {
          service.finish(operation, "succeeded", null);
        }
      } catch (error) {
        const state = operation.mutationStarted
          ? "unknownOutcome"
          : operation.controller.signal.aborted
            ? "cancelled"
            : "failed";
        service.finish(
          operation,
          state,
          sanitizeRepository(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    } finally {
      release();
    }
  })();
  return snapshot;
}
