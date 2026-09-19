import {
  badRequest,
  conflict,
  malformed,
  nowRfc3339,
  oneLine,
  requireOid,
} from "../support";
import {
  gitIntegration,
  integrationSnapshot,
  ownsIntegration,
} from "./integration";
import { safely } from "./merge";
import { splitNul } from "./parse";
import {
  type Operation,
  RepositoryService,
  type RepositoryContext,
  commandError,
} from "./service";
import { protectLocalPaths, sameHead } from "./stash";
import type {
  CherryPickPreview,
  ExpectedState,
  RepositoryAction,
} from "./types";

/**
 * Cherry-pick and revert: the same owned single-commit sequence with the patch
 * applied in opposite directions.
 *
 * A port of `apps/runtime/src/git/repository/integration/cherry_pick.rs`. They
 * share every precondition, every ownership binding and every recovery path,
 * so they share an implementation; what differs is one Git verb and one
 * verification.
 */

interface CommitData {
  readonly parents: string[];
  readonly subject: string;
  /** The raw `author …` header line, compared byte for byte after a pick. */
  readonly authorHeader: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTime: string;
}

export async function cherryPickPreview(
  service: RepositoryService,
  root: string,
  requested: string,
  rawOid: string,
  mainline: number | undefined,
): Promise<CherryPickPreview> {
  const oid = rawOid.toLowerCase();
  requireOid(oid);
  const context = await service.context(root, requested);
  const commit = await pickCommit(service, context, oid);
  const parent = pickParent(commit.parents, mainline, false);
  const patch =
    commit.parents.length > 1 && mainline === undefined
      ? null
      : (
          await service.read(context.repository, pickDiff(oid, parent, true))
        ).toString("utf8");
  return {
    targetOid: oid,
    parents: commit.parents,
    subject: commit.subject,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authorTime: commit.authorTime,
    mainline: mainline ?? null,
    patch,
  };
}

export async function startCherryPick(
  service: RepositoryService,
  context: RepositoryContext,
  action: RepositoryAction,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  let targetOid: string;
  let mainline: number | null;
  let recordOrigin = false;
  let expectedStateToken: string;
  let reverting: boolean;
  if (action.kind === "startCherryPick") {
    targetOid = action.targetOid;
    mainline = action.mainline;
    recordOrigin = action.recordOrigin;
    expectedStateToken = action.expectedStateToken;
    reverting = false;
  } else if (action.kind === "revert") {
    targetOid = action.targetOid;
    mainline = action.mainline;
    expectedStateToken = action.expectedStateToken;
    reverting = true;
  } else {
    throw malformed();
  }
  targetOid = targetOid.toLowerCase();
  const signal = operation.controller.signal;
  const state = await integrationSnapshot(service, context, signal);
  if (
    state.kind !== "none" ||
    !sameHead(state.head, expected) ||
    state.stateToken !== expectedStateToken
  ) {
    throw conflict(
      "Git state changed or an integration is already active; refresh and confirm again",
    );
  }
  if (
    state.dirty ||
    state.conflicts.length > 0 ||
    state.head.headOid === null ||
    state.head.branch === null
  ) {
    throw conflict(
      reverting
        ? "Revert requires a clean index and worktree on a committed local branch"
        : "Cherry-pick requires a clean index and worktree on a committed local branch",
    );
  }
  const commit = await pickCommit(service, context, targetOid, signal);
  const parent = pickParent(commit.parents, mainline ?? undefined, true);
  const paths = await service.read(
    context.repository,
    pickDiff(targetOid, parent, false),
    signal,
  );
  const touched = new Set(
    splitNul(paths)
      .filter((path) => path.length > 0)
      .map((path) => path.toString("utf8")),
  );
  await protectLocalPaths(service, context, touched, signal);

  const kind = reverting ? "revert" : "cherryPick";
  service.integrations.set(context.repository, {
    sessionId: operation.snapshot.id,
    kind,
    mainline,
    original: expected,
    targetOid,
    marker: null,
  });
  const command = [
    "-c",
    "core.editor=:",
    "-c",
    "rerere.enabled=false",
    reverting ? "revert" : "cherry-pick",
    "--no-rerere-autoupdate",
  ];
  // The recorded message is Git's own; nothing here opens an editor.
  if (reverting) command.push("--no-edit");
  if (mainline !== null) command.push("--mainline", String(mainline));
  if (recordOrigin) command.push("-x");
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
  const actual = await safely(() => gitIntegration(service, context));
  const head = await safely(() => service.head(context.repository));
  let owned = false;
  if (actual.ok && head.ok) {
    const owner = service.integrations.get(context.repository);
    if (owner !== undefined) {
      if (
        actual.value.kind === kind &&
        actual.value.targetOid === targetOid &&
        sameHead(head.value, expected)
      ) {
        owner.marker = actual.value.marker;
        owned = ownsIntegration(owner, actual.value, head.value);
      } else if (actual.value.kind === "none") {
        service.integrations.delete(context.repository);
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (!actual.ok) throw actual.error;
  if (!head.ok) throw head.error;
  if (output === undefined) throw malformed();
  if (owned && (output.status === 0 || output.status === 1)) {
    operation.awaitingResolution = true;
    return;
  }
  if (output.status !== 0) throw commandError(output);
  if (actual.value.kind !== "none") {
    throw conflict(
      `${kind} left an unverified Git sequence; inspect it before another action`,
    );
  }
  if (reverting) {
    await verifyRevert(
      service,
      context,
      targetOid,
      expected,
      head.value,
      signal,
    );
  } else {
    await verifyCherryPick(
      service,
      context,
      targetOid,
      expected,
      head.value,
      signal,
    );
  }
}

/**
 * A finished revert is one new commit on the same branch whose parent is the
 * confirmed original head, and whose tree undoes the target's patch. The author
 * is the current user, so nothing is checked against the source.
 */
export async function verifyRevert(
  service: RepositoryService,
  context: RepositoryContext,
  target: string,
  expected: ExpectedState,
  head: ExpectedState,
  signal?: AbortSignal,
): Promise<void> {
  const original = expected.headOid;
  const current = head.headOid;
  if (original === null || current === null) throw malformed();
  const produced = await pickCommit(service, context, current, signal);
  if (
    head.branch !== expected.branch ||
    current === original ||
    produced.parents.length !== 1 ||
    produced.parents[0] !== original
  ) {
    throw conflict(
      "The resulting revert commit does not sit on the confirmed parent and branch; inspect HEAD before another action",
    );
  }
  // The target must still be an ancestor: a revert that no longer relates to
  // the commit it claims to undo is not a result we accept.
  const reachable = await service.output(
    context.repository,
    ["merge-base", "--is-ancestor", target, current],
    15_000,
    signal,
  );
  if (reachable.status !== 0) {
    throw conflict(
      "The reverted commit is not reachable from the new HEAD; inspect the repository",
    );
  }
}

export async function verifyCherryPick(
  service: RepositoryService,
  context: RepositoryContext,
  target: string,
  expected: ExpectedState,
  head: ExpectedState,
  signal?: AbortSignal,
): Promise<void> {
  const original = expected.headOid;
  const current = head.headOid;
  if (original === null || current === null) throw malformed();
  const source = await pickCommit(service, context, target, signal);
  const produced = await pickCommit(service, context, current, signal);
  if (
    head.branch !== expected.branch ||
    current === original ||
    produced.parents.length !== 1 ||
    produced.parents[0] !== original ||
    produced.authorHeader !== source.authorHeader
  ) {
    throw conflict(
      "Resulting cherry-pick commit does not match its confirmed parent and source author; inspect HEAD before another action",
    );
  }
}

/**
 * The commit header, parsed rather than walked.
 *
 * `cat-file commit` is read instead of `git log` so shallow boundary rewriting
 * cannot misrepresent a non-root commit as a root.
 */
async function pickCommit(
  service: RepositoryService,
  context: RepositoryContext,
  oid: string,
  signal?: AbortSignal,
): Promise<CommitData> {
  requireOid(oid);
  const kind = oneLine(
    await service.read(context.repository, ["cat-file", "-t", oid], signal),
  );
  if (kind !== "commit") {
    throw badRequest(
      "Cherry-pick target must be a commit object ID, not a tag or tree",
    );
  }
  const bytes = await service.read(
    context.repository,
    ["cat-file", "commit", oid],
    signal,
  );
  if (bytes.length > 128 * 1024) {
    throw badRequest("Commit metadata exceeds the 128 KiB preview limit");
  }
  const separator = bytes.indexOf("\n\n");
  if (separator < 0) throw malformed();
  const header = bytes.subarray(0, separator).toString("utf8");
  const parents: string[] = [];
  let authorHeader: string | undefined;
  for (const line of header.split("\n")) {
    if (line.startsWith("parent ")) {
      const parent = line.slice("parent ".length);
      requireOid(parent);
      parents.push(parent);
    } else if (line.startsWith("author ")) {
      if (authorHeader !== undefined) throw malformed();
      authorHeader = line.slice("author ".length);
    }
  }
  if (authorHeader === undefined) throw malformed();
  const lastSpace = authorHeader.lastIndexOf(" ");
  const secondLast = authorHeader.lastIndexOf(" ", lastSpace - 1);
  if (lastSpace < 0 || secondLast < 0) throw malformed();
  const seconds = Number.parseInt(
    authorHeader.slice(secondLast + 1, lastSpace),
    10,
  );
  if (Number.isNaN(seconds)) throw malformed();
  const identity = authorHeader.slice(0, secondLast);
  const open = identity.lastIndexOf("<");
  if (open < 0 || !identity.endsWith(">")) throw malformed();
  const authorName = identity.slice(0, open).trimEnd();
  const authorEmail = identity.slice(open + 1, -1);
  const authorTime = `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
  const subject = [
    ...(bytes
      .subarray(separator + 2)
      .toString("utf8")
      .split("\n")[0] ?? ""),
  ]
    .slice(0, 4096)
    .join("");
  return {
    parents,
    subject,
    authorHeader,
    authorName,
    authorEmail,
    authorTime,
  };
}

function pickParent(
  parents: readonly string[],
  mainline: number | undefined,
  required: boolean,
): string | undefined {
  if (parents.length > 1) {
    if (mainline !== undefined && mainline > 0 && mainline <= parents.length) {
      return parents[mainline - 1];
    }
    if (mainline === undefined && !required) return undefined;
    throw badRequest(
      "A merge commit requires an explicitly selected existing mainline parent",
    );
  }
  if (mainline !== undefined) {
    throw badRequest("Mainline is only used when picking a merge commit");
  }
  return parents[0];
}

function pickDiff(
  oid: string,
  parent: string | undefined,
  patch: boolean,
): string[] {
  const command =
    parent === undefined
      ? [
          "diff-tree",
          "--root",
          "-r",
          "--no-commit-id",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          oid,
        ]
      : ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", parent, oid];
  command.push(...(patch ? ["--binary", "-p"] : ["--name-only", "-z"]), "--");
  return command;
}

export { nowRfc3339 };
