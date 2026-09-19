import { openSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import {
  badRequest,
  conflict,
  hasControlCharacter,
  internalError,
  malformed,
  oneLine,
  validOid,
} from "../support";
import {
  gitIntegration,
  integrationSnapshot,
  ownsIntegration,
} from "./integration";
import { safely } from "./merge";
import { parseHistory, splitNul } from "./parse";
import {
  type Operation,
  RepositoryService,
  type RepositoryContext,
  commandError,
} from "./service";
import { protectLocalPaths, sameHead } from "./stash";
import {
  type CommitRecord,
  type ExpectedState,
  type IntegrationSnapshot,
  type RebaseTodoEntry,
  type RebaseTodoPreview,
  type RepositoryAction,
  keepsCommit,
  todoKeyword,
} from "./types";

/**
 * Rebase replays the current branch onto a reviewed commit.
 *
 * A port of `apps/runtime/src/git/repository/integration/rebase.rs`. Unlike
 * merge and cherry-pick it detaches HEAD for the whole sequence, so ownership
 * is bound to Git's own `rebase-merge` records rather than to a motionless
 * HEAD.
 */

export async function rebaseTodoPreview(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
  onto: string,
): Promise<RebaseTodoPreview> {
  const context = await service.context(workspaceRoot, requested);
  const head = await service.head(context.repository);
  const ontoOid = await service.resolve(context.repository, onto);
  if (head.headOid === null) {
    throw conflict("There are no commits to replay");
  }
  const { base, commits } = await replayRange(
    service,
    context,
    ontoOid,
    head.headOid,
  );
  return {
    onto: ontoOid,
    base,
    hasMerges: commits.some((commit) => commit.parents.length > 1),
    commits,
    head,
  };
}

/** `(merge base, commits to replay oldest first)`. */
async function replayRange(
  service: RepositoryService,
  context: RepositoryContext,
  ontoOid: string,
  headOid: string,
  signal?: AbortSignal,
): Promise<{ base: string; commits: CommitRecord[] }> {
  const merged = await service.output(
    context.repository,
    ["merge-base", ontoOid, headOid],
    15_000,
    signal,
  );
  if (merged.status !== 0) {
    throw conflict("The rebase target and the current branch share no history");
  }
  const base = oneLine(merged.stdout);
  if (!validOid(base)) throw malformed();
  const output = await service.read(
    context.repository,
    [
      "log",
      "--reverse",
      "--topo-order",
      "--no-show-signature",
      "--no-decorate",
      "-z",
      "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s",
      "--max-count=1001",
      `${base}..${headOid}`,
      "--",
    ],
    signal,
  );
  const commits = parseHistory(output, new Map());
  if (commits.length > 1_000) {
    throw badRequest(
      "This range has more commits than the todo editor supports",
    );
  }
  return { base, commits };
}

export async function startRebase(
  service: RepositoryService,
  context: RepositoryContext,
  onto: string,
  expectedToken: string,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  await runRebase(service, context, expected, operation, {
    onto,
    expectedToken,
    todo: undefined,
  });
}

export async function startInteractiveRebase(
  service: RepositoryService,
  context: RepositoryContext,
  action: RepositoryAction,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  if (action.kind !== "startInteractiveRebase") throw malformed();
  await runRebase(service, context, expected, operation, {
    onto: action.onto,
    expectedToken: action.expectedStateToken,
    todo: action.todo,
  });
}

/**
 * The two rebases, which differ only in whether a reviewed todo list is handed
 * to Git through `GIT_SEQUENCE_EDITOR`.
 *
 * Everything else — the preconditions, the path protection, the ownership
 * binding and the verification — is identical, and writing it twice is how the
 * two would drift.
 */
async function runRebase(
  service: RepositoryService,
  context: RepositoryContext,
  expected: ExpectedState,
  operation: Operation,
  request: {
    readonly onto: string;
    readonly expectedToken: string;
    readonly todo: readonly RebaseTodoEntry[] | undefined;
  },
): Promise<void> {
  const signal = operation.controller.signal;
  const state = await integrationSnapshot(service, context, signal);
  if (state.kind !== "none") {
    throw conflict("An existing Git operation must be completed first");
  }
  if (
    !sameHead(state.head, expected) ||
    state.stateToken !== request.expectedToken
  ) {
    throw conflict(
      "Repository state changed; refresh and confirm the rebase again",
    );
  }
  if (state.dirty || state.conflicts.length > 0) {
    throw conflict(
      "Rebase requires a clean worktree and index on a committed local branch",
    );
  }
  const headOid = expected.headOid;
  const branch = expected.branch;
  if (headOid === null || branch === null) {
    throw conflict(
      "Rebase requires a clean worktree and index on a committed local branch",
    );
  }
  const ontoOid = await service.resolve(
    context.repository,
    request.onto,
    signal,
  );
  const { base, commits } = await replayRange(
    service,
    context,
    ontoOid,
    headOid,
    signal,
  );
  if (request.todo !== undefined) {
    checkTodo(request.todo, commits);
  }

  // The replay first checks out the target and then reapplies the local
  // commits, so both halves of the range can touch the worktree.
  const touched = new Set<string>();
  for (const other of [headOid, ontoOid]) {
    const names = await service.read(
      context.repository,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--no-renames",
        "-z",
        base,
        other,
        "--",
      ],
      signal,
    );
    for (const path of splitNul(names)) {
      if (path.length > 0) touched.add(path.toString("utf8"));
    }
  }
  await protectLocalPaths(service, context, touched, signal);

  const sessionId = operation.snapshot.id;
  const script =
    request.todo === undefined
      ? undefined
      : writeTodoScript(context.commonDir, sessionId, request.todo);
  service.integrations.set(context.repository, {
    sessionId,
    kind: "rebase",
    mainline: null,
    original: expected,
    targetOid: ontoOid,
    marker: null,
  });
  const command =
    request.todo === undefined
      ? [
          "-c",
          "core.editor=:",
          "-c",
          "rerere.enabled=false",
          "rebase",
          "--no-autostash",
          "--no-rerere-autoupdate",
          "--no-update-refs",
          "--no-fork-point",
          ontoOid,
        ]
      : [
          "-c",
          "core.editor=:",
          "-c",
          "rerere.enabled=false",
          "rebase",
          "--interactive",
          "--no-autosquash",
          "--no-autostash",
          "--no-rerere-autoupdate",
          "--no-update-refs",
          "--no-fork-point",
          ontoOid,
        ];

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
        ...(script === undefined
          ? {}
          : { environment: { GIT_SEQUENCE_EDITOR: script.editor } }),
      },
    );
  } catch (error) {
    failure = error;
  } finally {
    script?.remove();
  }
  // Read with a fresh token after a cancelled child has been reaped, so a
  // stopped sequence can still be bound for explicit recovery.
  const actual = await safely(() => gitIntegration(service, context));
  const actualHead = await safely(() => service.head(context.repository));
  let owns = false;
  if (actual.ok && actualHead.ok) {
    const owner = service.integrations.get(context.repository);
    if (owner !== undefined) {
      if (
        actual.value.kind === "rebase" &&
        actual.value.targetOid === ontoOid &&
        actual.value.originalHead === headOid
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
  if (actual.value.kind !== "none") {
    throw conflict(
      "Rebase left an unverified Git sequence; inspect it before another action",
    );
  }
  await verifyRebaseResult(
    service,
    context,
    branch,
    ontoOid,
    actualHead.value,
    signal,
  );
}

/**
 * The reviewed todo must be a permutation of the range: a commit can only be
 * dropped by saying so, never by being left out of the list.
 */
function checkTodo(
  todo: readonly RebaseTodoEntry[],
  commits: readonly CommitRecord[],
): void {
  if (commits.some((commit) => commit.parents.length > 1)) {
    throw conflict(
      "This range contains a merge commit, which the todo editor does not replay",
    );
  }
  const expected = new Set(commits.map((commit) => commit.oid));
  const submitted = new Set(todo.map((entry) => entry.oid));
  if (
    submitted.size !== todo.length ||
    submitted.size !== expected.size ||
    [...submitted].some((oid) => !expected.has(oid))
  ) {
    throw conflict(
      "The reviewed todo does not list exactly the commits this rebase would replay; refresh it",
    );
  }
  if (todo.every((entry) => entry.command === "drop")) {
    throw badRequest(
      "A todo that drops every commit would leave nothing to replay",
    );
  }
  // A squash or a fixup needs a kept entry before it, after any reordering.
  let previousKept = false;
  for (const entry of todo) {
    if (
      (entry.command === "squash" || entry.command === "fixup") &&
      !previousKept
    ) {
      throw badRequest(
        "A squash or fixup needs a kept commit before it in the reviewed order",
      );
    }
    if (keepsCommit(entry.command)) previousKept = true;
  }
}

export async function verifyRebase(
  service: RepositoryService,
  context: RepositoryContext,
  state: IntegrationSnapshot,
  head: ExpectedState,
  signal?: AbortSignal,
): Promise<void> {
  if (state.originalBranch === null || state.targetOid === null) {
    throw malformed();
  }
  await verifyRebaseResult(
    service,
    context,
    state.originalBranch,
    state.targetOid,
    head,
    signal,
  );
}

/**
 * A finished rebase must be back on its own branch with the confirmed target
 * reachable. Nothing about the replayed commits is assumed.
 */
async function verifyRebaseResult(
  service: RepositoryService,
  context: RepositoryContext,
  branch: string,
  onto: string,
  head: ExpectedState,
  signal?: AbortSignal,
): Promise<void> {
  const current = head.headOid;
  if (current === null) throw malformed();
  if (head.branch !== branch) {
    throw conflict(
      "The rebase did not return to its original branch; inspect HEAD before another action",
    );
  }
  const reachable = await service.output(
    context.repository,
    ["merge-base", "--is-ancestor", onto, current],
    15_000,
    signal,
  );
  if (reachable.status !== 0) {
    throw conflict(
      "The rebased branch does not contain the confirmed target commit; inspect HEAD",
    );
  }
}

/**
 * The reviewed todo list on disk plus the `GIT_SEQUENCE_EDITOR` command that
 * copies it over Git's generated one.
 *
 * The command is `cp -- '<path>'`; Git runs it as `sh -c "$editor \"$@\"" --
 * <todo>`, so the reviewed file lands verbatim and no interactive editor ever
 * starts. A repository path that could break out of the single quotes is
 * refused rather than escaped: escaping is where this kind of check goes wrong.
 */
interface TodoScript {
  readonly editor: string;
  remove(): void;
}

function writeTodoScript(
  commonDir: string,
  sessionId: string,
  todo: readonly RebaseTodoEntry[],
): TodoScript {
  const path = join(commonDir, `armadra-rebase-todo-${sessionId}`);
  const editor = `cp -- '${shellSafe(path, "todo")}'`;
  const created: string[] = [];
  const remove = (): void => {
    for (const file of created) {
      try {
        unlinkSync(file);
      } catch {
        // Already gone: the operation ended before the file was written, or
        // somebody removed it. Either way there is nothing left to clean up.
      }
    }
  };
  try {
    // Every OID was validated as hex and every keyword comes from a closed
    // set, so no line can carry a Git directive of its own. A `reword` is
    // written as its `pick` plus one generated `exec`, whose whole text is
    // produced here from a path this service created — the message it reads is
    // a file rather than an argument, so nothing a caller typed ever becomes
    // part of a command line.
    let contents = "";
    todo.forEach((entry, index) => {
      contents += `${todoKeyword(entry.command)} ${entry.oid}\n`;
      if (entry.command !== "reword") return;
      const message = entry.message;
      if (message === undefined) {
        throw internalError("A reword reached execution without its message");
      }
      const messagePath = join(
        commonDir,
        `armadra-rebase-message-${sessionId}-${index}`,
      );
      const quoted = shellSafe(messagePath, "message");
      writeNew(messagePath, message, "message");
      created.push(messagePath);
      contents += `exec git commit --amend --allow-empty --file '${quoted}'\n`;
    });
    writeNew(path, contents, "todo");
    created.push(path);
  } catch (error) {
    remove();
    throw error;
  }
  return { editor, remove };
}

function shellSafe(path: string, what: string): string {
  if (path.includes("'") || hasControlCharacter(path)) {
    throw internalError(`Rebase ${what} path cannot be passed to Git safely`);
  }
  return path;
}

/** Creates one 0600 file with exactly these bytes, refusing to reuse one. */
function writeNew(path: string, contents: string, what: string): void {
  let handle: number;
  try {
    handle = openSync(path, "wx", 0o600);
  } catch {
    throw internalError(`Could not stage the rebase ${what}`);
  }
  try {
    writeSync(handle, contents);
  } catch {
    throw internalError(`Could not stage the rebase ${what}`);
  } finally {
    closeSync(handle);
  }
}
