import { canonicalDirectory, resolveInRoot } from "../../workspaces/roots";
import { type GitRepositoryRecord, repositories } from "../discovery";
import { badRequest, malformed, nonempty, validOid } from "../support";
import { fieldsWithLf, parseTracking, parseWorktrees, splitNul } from "./parse";
import { RepositoryService } from "./service";
import type {
  ExpectedState,
  RefsBranch,
  RefsRemote,
  RefsSnapshot,
  RefsStash,
  RefsTag,
  RefsWorktree,
} from "./types";

/**
 * The workspace's branch tree, in one read.
 *
 * A port of `apps/runtime/src/git/repository/tree.rs`. The Git window's left
 * column is not a repository picker: it lists every discovered checkout at
 * once, each with its branches, remotes, tags, linked worktrees and stashes.
 * Drawing that from the per-repository snapshots would be five requests per
 * repository, so this is one request for the whole workspace.
 *
 * Two costs are deliberately avoided:
 *
 *   * **No process per branch.** Branches, remote-tracking branches and tags
 *     all come out of a single `for-each-ref`, and ahead/behind comes with them
 *     as `%(upstream:track)` — Git computes it while it is already walking.
 *   * **No repository blanks the panel.** A checkout that cannot be read is
 *     left out of the answer instead of failing it.
 */

const MAX_TREE_REFS = 5_000;
const MAX_TREE_STASHES = 1_000;

export async function refsSnapshot(
  service: RepositoryService,
  workspaceRoot: string,
  discoveryKey: string,
  onSkipped: (path: string, error: unknown) => void = () => {},
): Promise<RefsSnapshot[]> {
  // Listing worktrees and stashes runs Git commands outside the metadata-only
  // set a workspace without the grant may use.
  service.requireExecutionGrant("Git branch tree inspection");
  const root = canonicalDirectory(workspaceRoot);
  const list = await repositories(discoveryKey, root, undefined, false);
  const snapshots: RefsSnapshot[] = [];
  for (const record of list.repositories) {
    let directory: string;
    try {
      directory = resolveInRoot(root, record.repositoryPath);
    } catch {
      continue;
    }
    try {
      snapshots.push(await repositoryRefs(service, record, directory));
    } catch (error) {
      // One checkout that cannot answer is that checkout's absence from the
      // tree, not the workspace's.
      onSkipped(record.repositoryPath, error);
    }
  }
  return snapshots;
}

async function repositoryRefs(
  service: RepositoryService,
  record: GitRepositoryRecord,
  directory: string,
): Promise<RefsSnapshot> {
  const head = await service.head(directory);
  const { branches, remotes, tags } = await treeRefs(service, directory, head);
  const stashes = await treeStashes(service, directory);
  return {
    repositoryPath: record.repositoryPath,
    repositoryId: record.repositoryId,
    kind: record.kind,
    name: record.name,
    head: { oid: head.headOid, branch: head.branch },
    branches,
    remotes,
    tags,
    worktrees: await treeWorktrees(service, directory),
    stashCount: stashes.length,
    stashes,
  };
}

async function treeRefs(
  service: RepositoryService,
  directory: string,
  head: ExpectedState,
): Promise<{
  branches: RefsBranch[];
  remotes: RefsRemote[];
  tags: RefsTag[];
}> {
  const output = await service.read(directory, [
    "for-each-ref",
    "--sort=refname",
    // `%(*objectname)` is the commit an annotated tag names;
    // `%(upstream:track,nobracket)` is Git's own ahead/behind, computed here
    // rather than by a `rev-list` per branch.
    "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(upstream:short)%00%(upstream:track,nobracket)%00",
    "refs/heads/",
    "refs/remotes/",
    "refs/tags/",
  ]);
  const records = fieldsWithLf(output, 6);
  if (records.length > MAX_TREE_REFS) {
    throw badRequest(
      "This repository has more references than the branch tree supports",
    );
  }
  const branches: RefsBranch[] = [];
  const remotes: RefsRemote[] = [];
  const tags: RefsTag[] = [];
  for (const record of records) {
    const fullRef = record[0] as string;
    if (!validOid(record[1] as string)) throw malformed();
    if (fullRef.startsWith("refs/heads/")) {
      const name = fullRef.slice("refs/heads/".length);
      const upstream = nonempty(record[4] as string);
      const [ahead, behind] = parseTracking(record[5] as string);
      branches.push({
        current: head.branch === name,
        name,
        oid: record[1] as string,
        ahead: upstream === null ? null : ahead,
        behind: upstream === null ? null : behind,
        upstream,
      });
      continue;
    }
    if (fullRef.startsWith("refs/remotes/")) {
      const name = fullRef.slice("refs/remotes/".length);
      const slash = name.indexOf("/");
      if (slash < 0) continue;
      const remote = name.slice(0, slash);
      const branch = name.slice(slash + 1);
      // `origin/HEAD` is a symbolic pointer, not a branch somebody checks out;
      // it would draw as a duplicate of the default.
      if (branch === "HEAD") continue;
      let entry = remotes.find((candidate) => candidate.name === remote);
      if (entry === undefined) {
        entry = { name: remote, branches: [] };
        remotes.push(entry);
      }
      entry.branches.push({ name: branch, oid: record[1] as string });
      continue;
    }
    if (fullRef.startsWith("refs/tags/")) {
      const oid =
        record[2] === "" ? (record[1] as string) : (record[2] as string);
      if (!validOid(oid)) throw malformed();
      tags.push({
        name: fullRef.slice("refs/tags/".length),
        oid,
        annotated: record[3] === "tag",
      });
    }
  }
  return { branches, remotes, tags };
}

async function treeWorktrees(
  service: RepositoryService,
  directory: string,
): Promise<RefsWorktree[]> {
  const output = await service.read(directory, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return parseWorktrees(output).map((record) => ({
    path: record.path,
    branch: record.branch,
    oid: record.headOid,
    locked: record.locked,
  }));
}

/**
 * The checkout's stash stack.
 *
 * `stash list` rather than a reflog count, because the tree draws entries and
 * not only a number, and because a checkout that never stashed has no
 * `refs/stash` at all — which `stash list` reports as an empty list rather than
 * as a failure. The index is the entry's position at this moment; it is *not*
 * what a write names, because pushing or dropping renumbers everything below.
 */
async function treeStashes(
  service: RepositoryService,
  directory: string,
): Promise<RefsStash[]> {
  const output = await service.read(directory, [
    "stash",
    "list",
    "-z",
    "--format=%H%x00%gs%x00%aI",
  ]);
  const fields = splitNul(output);
  if (fields.length % 3 !== 0 || fields.length / 3 > MAX_TREE_STASHES) {
    throw malformed();
  }
  const stashes: RefsStash[] = [];
  for (let index = 0; index * 3 < fields.length; index += 1) {
    const chunk = fields
      .slice(index * 3, index * 3 + 3)
      .map((value) => value.toString("utf8"));
    const oid = chunk[0] as string;
    if (!validOid(oid)) throw malformed();
    stashes.push({
      index,
      oid,
      message: chunk[1] as string,
      createdAt: chunk[2] as string,
    });
  }
  return stashes;
}
