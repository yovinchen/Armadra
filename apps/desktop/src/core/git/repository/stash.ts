import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  constants as fsConstants,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { canonicalize } from "../../workspaces/roots";
import {
  badRequest,
  conflict,
  hashField,
  isDigest,
  malformed,
  nowRfc3339,
  oneLine,
  requireOid,
  shuttingDown,
  validOid,
} from "../support";
import { splitNul } from "./parse";
import {
  type Operation,
  RepositoryService,
  type RepositoryContext,
  repositoryId,
} from "./service";
import type {
  ExpectedState,
  RepositoryAction,
  StashDetail,
  StashRecord,
  StashSnapshot,
} from "./types";

/**
 * The stash list, the state token every write is confirmed against, and the
 * reset that uses both.
 *
 * A port of the pre-merge implementation. The state token is the
 * important export: it is a digest over HEAD, the stash reflog, the porcelain
 * status, the full binary staged and unstaged diffs and every untracked file's
 * content, and every stash, reset, merge, rebase and cherry-pick names the one
 * it observed. Status alone cannot notice a second edit to an already dirty
 * file, which is why the binary diffs are in the hash at all.
 */

const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024;
const MAX_STASHES = 1000;

export function validateMessage(message: unknown): void {
  if (
    typeof message !== "string" ||
    Buffer.byteLength(message, "utf8") > 4096 ||
    message.includes("\0") ||
    message.includes("\r")
  ) {
    throw badRequest("Stash message is invalid or too long");
  }
}

export function validateStateToken(token: unknown): void {
  if (!isDigest(token)) {
    throw badRequest("Stash requires an observed repository state token");
  }
}

export async function stashes(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
): Promise<StashSnapshot> {
  service.requireExecutionGrant("Git stash worktree state");
  const context = await service.context(workspaceRoot, requested);
  return (await stashSnapshot(service, context)).snapshot;
}

/**
 * Detail reads are anchored to an immutable OID still present in the stash
 * list. Index / worktree and optional untracked snapshots are displayed apart.
 */
export async function stashDetail(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
  oid: string,
): Promise<StashDetail> {
  requireOid(oid);
  const context = await service.context(workspaceRoot, requested);
  const { records } = await stashRecords(service, context);
  selectedStash(records, oid);
  const parentLine = oneLine(
    await service.read(context.repository, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      oid,
      "--",
    ]),
  );
  const parents = parentLine
    .split(/\s+/)
    .slice(1)
    .filter((v) => v !== "");
  if (
    parents.length < 2 ||
    parents.length > 3 ||
    !parents.every((parent) => validOid(parent))
  ) {
    throw malformed();
  }
  const patch = await service.read(context.repository, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    parents[0] as string,
    oid,
    "--",
  ]);
  const staged = await service.read(context.repository, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    parents[0] as string,
    parents[1] as string,
    "--",
  ]);
  const untracked =
    parents[2] === undefined
      ? Buffer.alloc(0)
      : await service.read(context.repository, [
          "show",
          "--format=",
          "--root",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          parents[2],
          "--",
        ]);
  return {
    oid,
    parents,
    patch: patch.toString("utf8"),
    stagedPatch: staged.toString("utf8"),
    untrackedPatch: untracked.toString("utf8"),
  };
}

export async function stashRecords(
  service: RepositoryService,
  context: RepositoryContext,
  signal?: AbortSignal,
): Promise<{ raw: Buffer; records: StashRecord[] }> {
  const raw = await service.read(
    context.repository,
    ["stash", "list", "-z", "--format=%H%x00%gd%x00%gs%x00%an%x00%aI"],
    signal,
  );
  const fields = splitNul(raw);
  if (fields.length % 5 !== 0 || fields.length / 5 > MAX_STASHES) {
    throw badRequest("Stash list exceeds the supported limit or is malformed");
  }
  const records: StashRecord[] = [];
  for (let index = 0; index * 5 < fields.length; index += 1) {
    const chunk = fields
      .slice(index * 5, index * 5 + 5)
      .map((value) => value.toString("utf8"));
    const oid = chunk[0] as string;
    const selector = chunk[1] as string;
    requireOid(oid);
    if (selector !== `stash@{${index}}`) throw malformed();
    records.push({
      oid,
      selector,
      subject: chunk[2] as string,
      authorName: chunk[3] as string,
      authorTime: chunk[4] as string,
    });
  }
  return { raw, records };
}

export async function stashSnapshot(
  service: RepositoryService,
  context: RepositoryContext,
  signal?: AbortSignal,
): Promise<{ snapshot: StashSnapshot; stashRaw: Buffer }> {
  const head = await service.head(context.repository, signal);
  const { raw: stashRaw, records } = await stashRecords(
    service,
    context,
    signal,
  );
  const status = await service.read(
    context.repository,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal,
  );
  const conflicts = await service.read(
    context.repository,
    ["diff", "--name-only", "--diff-filter=U", "-z", "--"],
    signal,
  );
  const digest = createHash("sha256");
  hashField(digest, context.repository);
  hashField(digest, JSON.stringify(head));
  hashField(digest, stashRaw);
  hashField(digest, status);
  for (const staged of [false, true]) {
    const command = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--no-renames",
    ];
    if (staged) command.push("--cached");
    command.push("--");
    hashField(digest, await service.read(context.repository, command, signal));
  }
  const untracked = await service.read(
    context.repository,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    signal,
  );
  hashField(digest, untracked);
  if (untracked.filter((byte) => byte === 0).length > 4096) {
    throw badRequest("Too many untracked files for stash confirmation");
  }
  let budget = MAX_UNTRACKED_BYTES;
  for (const bytes of splitNul(untracked)) {
    if (bytes.length === 0) continue;
    if (signal?.aborted === true || service.isShuttingDown()) {
      throw shuttingDown();
    }
    budget = hashUntracked(
      context.repository,
      bytes.toString("utf8"),
      digest,
      budget,
    );
  }
  const after = await service.head(context.repository, signal);
  if (after.headOid !== head.headOid || after.branch !== head.branch) {
    throw conflict("HEAD changed while observing stash state; refresh first");
  }
  return {
    snapshot: {
      repositoryId: repositoryId(context),
      repositoryPath: context.repository,
      head,
      stateToken: digest.digest("hex"),
      dirty: status.length > 0,
      hasConflicts: conflicts.length > 0,
      stashes: records,
    },
    stashRaw,
  };
}

/**
 * Move the current ref to a reviewed commit.
 *
 * `hard` is the only mode that can lose uncommitted work, so it needs an
 * explicit acknowledgement whenever anything is uncommitted, and it always
 * records a stash snapshot first — the same stash backend the Stashes tab
 * lists, so the discarded state has a named way back. A snapshot Git does not
 * actually create stops the reset instead of proceeding without it.
 */
export async function reset(
  service: RepositoryService,
  context: RepositoryContext,
  action: Extract<RepositoryAction, { kind: "reset" }>,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  const { snapshot, stashRaw: before } = await stashSnapshot(
    service,
    context,
    signal,
  );
  if (
    !sameHead(snapshot.head, expected) ||
    snapshot.stateToken !== action.expectedStateToken
  ) {
    throw conflict(
      "Repository state changed; refresh and confirm the reset again",
    );
  }
  if (snapshot.hasConflicts) {
    throw conflict("Resolve the conflicted index before resetting");
  }
  if (
    (await service.resolve(context.repository, action.targetOid, signal)) !==
    action.targetOid
  ) {
    throw badRequest("Reset target must be a commit object ID");
  }
  if (action.mode === "hard" && snapshot.dirty && !action.discardChanges) {
    throw conflict(
      "A hard reset replaces uncommitted work; confirm discarding it explicitly",
    );
  }
  if (action.mode === "hard" && snapshot.dirty) {
    await service.mutate(
      context,
      [
        "stash",
        "push",
        "--include-untracked",
        "--message",
        `armadra: before hard reset to ${action.targetOid}`,
        "--",
      ],
      operation,
    );
    const after = await stashRecords(service, context, signal);
    if (after.raw.equals(before)) {
      throw conflict(
        "No recovery stash was created; the hard reset was not started",
      );
    }
    // The stash already restored the worktree to HEAD, so the reset that
    // follows only has to move the ref.
  }
  await service.mutate(
    context,
    ["reset", resetFlagFor(action.mode), action.targetOid],
    operation,
  );
  const head = await service.head(context.repository, signal);
  if (head.headOid !== action.targetOid || head.branch !== expected.branch) {
    throw conflict(
      "HEAD does not point at the confirmed commit after the reset; inspect the repository",
    );
  }
}

function resetFlagFor(mode: "soft" | "mixed" | "hard"): string {
  return mode === "soft" ? "--soft" : mode === "mixed" ? "--mixed" : "--hard";
}

export async function executeStash(
  service: RepositoryService,
  context: RepositoryContext,
  action: RepositoryAction,
  expected: ExpectedState,
  operation: Operation,
): Promise<void> {
  const signal = operation.controller.signal;
  if (
    action.kind !== "createStash" &&
    action.kind !== "applyStash" &&
    action.kind !== "popStash" &&
    action.kind !== "dropStash"
  ) {
    throw malformed();
  }
  const { snapshot, stashRaw: before } = await stashSnapshot(
    service,
    context,
    signal,
  );
  if (
    !sameHead(snapshot.head, expected) ||
    snapshot.stateToken !== action.expectedStateToken
  ) {
    throw conflict(
      "Repository or stash list changed; refresh and confirm again",
    );
  }
  if (snapshot.hasConflicts && action.kind !== "dropStash") {
    throw conflict("Resolve existing index conflicts before changing stashes");
  }
  if (action.kind === "createStash") {
    if (!snapshot.dirty || snapshot.head.headOid === null) {
      throw conflict("Stash requires an initial commit and local changes");
    }
    const command = ["stash", "push", "--message", action.message];
    if (action.includeUntracked) command.push("--include-untracked");
    command.push("--");
    await service.mutate(context, command, operation);
    const after = await stashRecords(service, context, signal);
    if (after.raw.equals(before)) {
      throw conflict(
        "No stash was created; untracked files require the explicit include option",
      );
    }
    return;
  }
  if (action.kind === "dropStash") {
    await dropStash(service, context, action.oid, before, operation);
    return;
  }
  selectedStash(snapshot.stashes, action.oid);
  await protectStashPaths(service, context, action.oid, signal);
  const command = ["stash", "apply"];
  if (action.reinstateIndex) command.push("--index");
  command.push("--", action.oid);
  // Apply the selected immutable object, never an index that can shift. Any
  // conflict or cancellation retains the stash.
  await service.mutate(context, command, operation);
  if (action.kind === "popStash") {
    await dropStash(service, context, action.oid, before, operation);
  }
}

/**
 * `git stash apply` can overwrite ignored files. Inspect only paths touched by
 * this immutable stash, including staged and untracked snapshots, before
 * letting Git perform the merge. Never follow an untracked symlink.
 */
async function protectStashPaths(
  service: RepositoryService,
  context: RepositoryContext,
  oid: string,
  signal?: AbortSignal,
): Promise<void> {
  const parentLine = oneLine(
    await service.read(
      context.repository,
      ["rev-list", "--parents", "-n", "1", oid, "--"],
      signal,
    ),
  );
  const parents = parentLine
    .split(/\s+/)
    .slice(1)
    .filter((v) => v !== "");
  if (parents.length < 2 || parents.length > 3) throw malformed();
  const touched = new Set<string>();
  for (const tree of [oid, parents[1] as string]) {
    const names = await service.read(
      context.repository,
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        parents[0] as string,
        tree,
        "--",
      ],
      signal,
    );
    for (const path of splitNul(names)) {
      if (path.length > 0) touched.add(path.toString("utf8"));
    }
  }
  if (parents[2] !== undefined) {
    const names = await service.read(
      context.repository,
      ["ls-tree", "-r", "-z", "--name-only", parents[2], "--"],
      signal,
    );
    for (const path of splitNul(names)) {
      if (path.length > 0) touched.add(path.toString("utf8"));
    }
  }
  await protectLocalPaths(service, context, touched, signal);
}

/**
 * Refuse an incoming change that would land on top of a local untracked or
 * ignored file, or collide with a local directory.
 */
export async function protectLocalPaths(
  service: RepositoryService,
  context: RepositoryContext,
  touched: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<void> {
  if (touched.size > 4096) {
    throw badRequest("Operation touches too many paths for safe confirmation");
  }
  const inspect = new Set<string>();
  for (const name of [...touched].sort()) {
    const parts = segments(name);
    if (
      isAbsolute(name) ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw malformed();
    }
    let prefix = "";
    for (const part of parts) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      const info = lstatSync(join(context.repository, prefix), {
        throwIfNoEntry: false,
      });
      if (info === undefined) break;
      if (!info.isDirectory()) {
        if (prefix !== name) {
          throw conflict(
            "An incoming parent path is a local file or symlink; resolve the collision before applying",
          );
        }
        inspect.add(prefix);
        // A symlink or regular parent cannot be traversed safely.
        break;
      }
      if (prefix === name) {
        throw conflict(
          "An incoming file collides with a local directory; move it before applying",
        );
      }
    }
  }
  if (inspect.size === 0) return;
  // Chunk argv so a large but valid set cannot exceed platform limits.
  const names = [...inspect];
  for (let index = 0; index < names.length; index += 64) {
    const chunk = names.slice(index, index + 64);
    const tracked = await service.read(
      context.repository,
      ["ls-files", "-z", "--", ...chunk.map((name) => `:(literal)${name}`)],
      signal,
    );
    const known = new Set(
      splitNul(tracked)
        .filter((part) => part.length > 0)
        .map((part) => part.toString("utf8")),
    );
    if (chunk.some((name) => !known.has(name))) {
      throw conflict(
        "Operation would overwrite a local untracked or ignored path; preserve that file before applying",
      );
    }
  }
}

async function dropStash(
  service: RepositoryService,
  context: RepositoryContext,
  oid: string,
  expected: Buffer,
  operation: Operation,
): Promise<void> {
  const { raw, records } = await stashRecords(
    service,
    context,
    operation.controller.signal,
  );
  if (!raw.equals(expected)) {
    throw conflict(
      "Stash list changed; selected stash was retained. Refresh before another action",
    );
  }
  const selected = selectedStash(records, oid);
  // Git has no OID-CAS reflog deletion API. The complete reflog is rechecked
  // immediately under the common-directory queue; Git's own reflog files are
  // never edited here.
  await service.mutate(
    context,
    ["stash", "drop", "--", selected.selector],
    operation,
  );
}

export function selectedStash(
  records: readonly StashRecord[],
  oid: string,
): StashRecord {
  const matches = records.filter((record) => record.oid === oid);
  const found = matches[0];
  if (found === undefined) {
    throw conflict("Selected stash no longer exists; refresh first");
  }
  if (matches.length > 1) {
    throw conflict(
      "This object appears more than once in the stash list; select it with Git before continuing",
    );
  }
  return found;
}

export function sameHead(left: ExpectedState, right: ExpectedState): boolean {
  return left.headOid === right.headOid && left.branch === right.branch;
}

/**
 * A relative path's segments, the way Rust's `Path::components` yields them.
 *
 * The trailing slash matters here: `git ls-files --others` reports an
 * untracked *directory* as `apps/inner/`, and reading that as a four-segment
 * path with an empty last one would turn "this is a directory" — which has its
 * own refusal below — into "this output is malformed".
 */
function segments(name: string): string[] {
  return name.replace(/\/+$/, "").split("/");
}

function hashUntracked(
  root: string,
  name: string,
  digest: ReturnType<typeof createHash>,
  budget: number,
): number {
  const parts = segments(name);
  if (
    isAbsolute(name) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw malformed();
  }
  const path = join(root, name);
  const parent = canonicalize(dirname(path));
  if (parent !== root && !parent.startsWith(`${root}/`)) {
    throw badRequest("Untracked path escapes the repository");
  }
  const resolved = join(parent, basename(name));
  const info = lstatSync(resolved);
  if (info.isSymbolicLink()) {
    hashField(digest, "symlink");
    hashField(digest, readlinkSync(resolved));
    return budget;
  }
  if (!info.isFile()) {
    throw badRequest(
      "Untracked directories or special files cannot be safely confirmed for stash",
    );
  }
  if (info.size > budget) {
    throw badRequest(
      "Untracked content exceeds the 32 MiB stash confirmation limit",
    );
  }
  const handle = openSync(
    resolved,
    fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
  );
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size !== info.size) {
      throw conflict("Untracked file changed during confirmation");
    }
    const contents = Buffer.alloc(info.size);
    const read = readSync(handle, contents, 0, info.size, 0);
    if (read !== info.size) {
      throw conflict("Untracked file changed during confirmation");
    }
    hashField(digest, "file");
    if (process.platform !== "win32") {
      const mode = Buffer.alloc(4);
      mode.writeUInt32BE(opened.mode & 0o111);
      hashField(digest, mode);
    }
    hashField(digest, contents);
  } finally {
    closeSync(handle);
  }
  return budget - info.size;
}

export { nowRfc3339, relative };
