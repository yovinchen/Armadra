import { normalizeFileStatus } from "../status";
import {
  badRequest,
  malformed,
  notFound,
  oneLine,
  requireOid,
  validOid,
} from "../support";
import { parseHistory, parseNameStatus, parseNumstat } from "./parse";
import { RepositoryService, type RepositoryContext } from "./service";
import type {
  CommitDetail,
  CommitFile,
  CommitFileDiff,
  CommitRecord,
} from "./types";

/**
 * What one commit changed, for the commit graph's detail pane.
 *
 * A port of `apps/runtime/src/git/repository/commits.rs`. The file list and the
 * patch are deliberately separate requests: a commit can touch thousands of
 * files and a single file can be megabytes, so loading both at once would make
 * selecting a row in the graph an unbounded operation.
 *
 * `base` is what the commit is compared *against* — its first parent by
 * default, the working HEAD when the graph says "compare to current". Both
 * sides are resolved to object IDs before any diff runs, so the answer names
 * exactly the two commits it compared.
 */

const MAX_FILES = 2_000;
const MAX_PATCH_BYTES = 1024 * 1024;

export async function commitDetail(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
  oid: string,
  base: string | undefined,
): Promise<CommitDetail> {
  requireOid(oid);
  const context = await service.context(workspaceRoot, requested);
  const commit = await singleCommit(service, context, oid);
  const baseOid = await resolveBase(service, context, commit, base);
  const numstat = await service.read(
    context.repository,
    baseOid === null
      ? [
          "diff-tree",
          "--no-ext-diff",
          "--no-textconv",
          "--numstat",
          "-z",
          "--root",
          "-r",
          oid,
        ]
      : [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--numstat",
          "-z",
          baseOid,
          oid,
          "--",
        ],
  );
  const names = await service.read(
    context.repository,
    baseOid === null
      ? [
          "diff-tree",
          "--no-ext-diff",
          "--no-textconv",
          "--name-status",
          "-z",
          "--root",
          "-r",
          oid,
        ]
      : [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-status",
          "-z",
          baseOid,
          oid,
          "--",
        ],
  );
  const counts = parseNumstat(numstat.toString("utf8"));
  const files: CommitFile[] = [];
  let truncated = false;
  for (const [status, path] of parseNameStatus(
    names.toString("utf8"),
    normalizeFileStatus,
  )) {
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    const [additions, deletions] = counts.get(path) ?? [null, null];
    files.push({ status, path, additions, deletions });
  }
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { oid: commit.oid, baseOid, commit, files, truncated };
}

export async function commitFileDiff(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
  oid: string,
  base: string | undefined,
  file: string,
): Promise<CommitFileDiff> {
  requireOid(oid);
  if (file === "" || file.length > 4096 || file.includes("\0")) {
    throw badRequest("Requested path is invalid");
  }
  const context = await service.context(workspaceRoot, requested);
  const commit = await singleCommit(service, context, oid);
  const baseOid = await resolveBase(service, context, commit, base);
  const raw = await service.read(
    context.repository,
    baseOid === null
      ? [
          "diff-tree",
          "--no-ext-diff",
          "--no-textconv",
          "-p",
          "--root",
          "-r",
          oid,
          "--",
          file,
        ]
      : ["diff", "--no-ext-diff", "--no-textconv", baseOid, oid, "--", file],
  );
  const truncated = raw.length > MAX_PATCH_BYTES;
  let patch: string;
  if (truncated) {
    // The response is JSON, so the cut must land on a character boundary.
    let end = MAX_PATCH_BYTES;
    while (end > 0 && !onBoundary(raw, end)) end -= 1;
    patch = raw.subarray(0, end).toString("utf8");
  } else {
    patch = raw.toString("utf8");
  }
  return { oid: commit.oid, baseOid, path: file, patch, truncated };
}

/** Whether cutting `bytes` at `end` lands between two UTF-8 sequences. */
function onBoundary(bytes: Buffer, end: number): boolean {
  const byte = bytes[end];
  return byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000;
}

/**
 * The one commit `oid` names, with its parents, author and ref decorations.
 *
 * An object ID that is well-formed but not in this repository is a not-found
 * rather than an internal error: the graph may be showing a page from a
 * checkout that has since been pruned or rewritten.
 */
async function singleCommit(
  service: RepositoryService,
  context: RepositoryContext,
  oid: string,
): Promise<CommitRecord> {
  const exists = await service.output(
    context.repository,
    ["rev-parse", "--verify", "--quiet", `${oid}^{commit}`],
    service.commandTimeoutMs,
  );
  if (exists.status !== 0) {
    throw notFound("Commit not found in this repository");
  }
  const output = await service.read(context.repository, [
    "log",
    "-n",
    "1",
    "--no-walk",
    "--no-show-signature",
    "--no-decorate",
    "-z",
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s",
    oid,
    "--",
  ]);
  const refs = await service.commitRefs(context.repository);
  const commit = parseHistory(output, refs)[0];
  if (commit === undefined) {
    throw notFound("Commit not found in this repository");
  }
  return commit;
}

async function resolveBase(
  service: RepositoryService,
  context: RepositoryContext,
  commit: CommitRecord,
  base: string | undefined,
): Promise<string | null> {
  if (base === undefined) return commit.parents[0] ?? null;
  if (base === "" || base.length > 1024 || base.startsWith("-")) {
    throw badRequest("Comparison base is invalid");
  }
  const resolved = oneLine(
    await service.read(context.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${base}^{commit}`,
    ]),
  );
  if (!validOid(resolved)) {
    throw badRequest("Comparison base does not name a commit");
  }
  return resolved;
}

export { malformed };
