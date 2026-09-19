import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  constants as fsConstants,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  badRequest,
  conflict,
  malformed,
  nowRfc3339,
  oneLine,
  sha256Hex,
  validOid,
} from "../support";
import { splitNul } from "./parse";
import {
  type IntegrationOwner,
  type MarkerIdentity,
  type Operation,
  RepositoryService,
  type RepositoryContext,
  repositoryId,
} from "./service";
import { protectLocalPaths, sameHead, stashSnapshot } from "./stash";
import type {
  ConflictFile,
  ConflictSide,
  ExpectedState,
  IntegrationSnapshot,
  OperationState,
} from "./types";
import { isTerminal } from "./types";

/**
 * Explicit integration state: which merge, cherry-pick, revert or rebase this
 * service started, and whether it is still the one Git has in progress.
 *
 * A port of `apps/runtime/src/git/repository/integration/{mod,snapshot}.rs`.
 * Ownership is deliberately local to this process's lifetime: a restarted core
 * never claims an external Git sequence, because it has no way to know what
 * started it or what the person doing it intended.
 */

export type Recovery = "continue" | "abort" | "skip";

const MAX_PREVIEW = 64 * 1024;

export interface GitIntegration {
  readonly kind: string;
  readonly message: string | null;
  readonly metadataDigest: string;
  readonly targetOid: string | null;
  readonly originalHead: string | null;
  /** `refs/heads/<branch>` recorded by an in-progress rebase; null otherwise. */
  readonly headName: string | null;
  readonly marker: MarkerIdentity | null;
}

export async function integrationStatus(
  service: RepositoryService,
  root: string,
  requested: string,
): Promise<IntegrationSnapshot> {
  service.requireExecutionGrant("Git integration worktree state");
  // Read and reconcile only after queued mutations have fully finished; a
  // commit briefly removes MERGE_HEAD before its post-commit work ends.
  return service.withGuard(root, requested, (guard) =>
    integrationSnapshot(service, guard.context),
  );
}

export async function ensureIntegrationIdle(
  service: RepositoryService,
  context: RepositoryContext,
  signal?: AbortSignal,
): Promise<void> {
  if ((await gitIntegration(service, context, signal)).kind !== "none") {
    throw conflict(
      "A Git integration is already in progress; resolve it before another repository operation",
    );
  }
}

export async function integrationSnapshot(
  service: RepositoryService,
  context: RepositoryContext,
  signal?: AbortSignal,
): Promise<IntegrationSnapshot> {
  const { snapshot: state } = await stashSnapshot(service, context, signal);
  const actual = await gitIntegration(service, context, signal);
  const conflicts = await conflictFiles(service, context, signal);
  const owner = service.integrations.get(context.repository);
  const owned =
    owner !== undefined && ownsIntegration(owner, actual, state.head);
  if (owner !== undefined && owner.marker !== null && !owned) {
    releaseIntegrationOwner(
      service,
      context,
      owner.sessionId,
      "unknownOutcome",
      "Recorded Git integration state was completed or replaced outside this operation; ownership was released. Inspect current HEAD before another action",
    );
  }
  const digest = createHash("sha256");
  digest.update(state.stateToken);
  digest.update(actual.kind);
  digest.update(Buffer.from(actual.metadataDigest, "hex"));
  if (actual.marker !== null) {
    digest.update(Buffer.from(actual.marker.digest, "hex"));
  }
  if (actual.originalHead !== null) digest.update(actual.originalHead);

  const unstaged = await service.output(
    context.repository,
    ["diff", "--no-ext-diff", "--quiet", "--"],
    15_000,
    signal,
  );
  if (unstaged.status !== 0 && unstaged.status !== 1) {
    throw commandRefusal(unstaged.stderr);
  }
  const staged = await service.output(
    context.repository,
    ["diff", "--cached", "--no-ext-diff", "--quiet", "--"],
    15_000,
    signal,
  );
  if (staged.status !== 0 && staged.status !== 1) {
    throw commandRefusal(staged.stderr);
  }
  // A paused single-commit sequence with nothing left to commit produced no
  // change at all. Continuing it can only fail, so the state is reported
  // instead of being offered as a continuation.
  const empty =
    (actual.kind === "cherryPick" || actual.kind === "revert") &&
    conflicts.length === 0 &&
    staged.status === 0 &&
    unstaged.status === 0;
  const rebase = actual.kind === "rebase";
  // Skip drops the pick outright; for a revert that would silently leave the
  // change it was meant to undo in place, so only Abort is offered there. A
  // paused rebase may be skipped — what makes that safe is not that it is
  // harmless but that it is explicit.
  const canSkip = owned && ((empty && actual.kind === "cherryPick") || rebase);
  return {
    repositoryId: state.repositoryId,
    repositoryPath: state.repositoryPath,
    head: state.head,
    stateToken: digest.digest("hex"),
    kind: actual.kind,
    owned,
    sessionId: owned ? (owner?.sessionId ?? null) : null,
    originalHead: owned
      ? (owner?.original.headOid ?? null)
      : actual.originalHead,
    originalBranch: owned
      ? (owner?.original.branch ?? null)
      : actual.headName !== null && actual.headName.startsWith("refs/heads/")
        ? actual.headName.slice("refs/heads/".length)
        : null,
    targetOid: actual.targetOid,
    // A rebase writes its own step message; the gate that matters is that no
    // conflict and no unstaged edit is left behind.
    canContinue:
      owned &&
      conflicts.length === 0 &&
      unstaged.status === 0 &&
      (rebase || actual.message !== null) &&
      !empty,
    mainline: owned ? (owner?.mainline ?? null) : null,
    empty,
    canSkip,
    message: actual.message,
    dirty: state.dirty,
    conflicts,
  };
}

/**
 * A rebase deliberately moves HEAD between steps, so ownership is bound to the
 * recorded start point and branch instead of the live head. Every other kind
 * keeps the stricter "HEAD has not moved at all" rule.
 */
export function ownsIntegration(
  owner: IntegrationOwner,
  actual: GitIntegration,
  head: ExpectedState,
): boolean {
  const rebase = owner.kind === "rebase";
  return (
    actual.kind === owner.kind &&
    (rebase || sameHead(owner.original, head)) &&
    actual.targetOid === owner.targetOid &&
    (!(owner.kind === "merge" || owner.kind === "rebase") ||
      actual.originalHead === owner.original.headOid) &&
    (!rebase ||
      actual.headName ===
        (owner.original.branch === null
          ? null
          : `refs/heads/${owner.original.branch}`)) &&
    owner.marker !== null &&
    sameMarker(owner.marker, actual.marker)
  );
}

export function releaseIntegrationOwner(
  service: RepositoryService,
  context: RepositoryContext,
  sessionId: string,
  state: OperationState,
  message: string,
): void {
  const owner = service.integrations.get(context.repository);
  if (owner === undefined || owner.sessionId !== sessionId) return;
  service.integrations.delete(context.repository);
  const operation = service.entry(sessionId);
  if (operation === undefined) return;
  if (
    operation.snapshot.state === "awaitingResolution" ||
    operation.snapshot.state === "unknownOutcome"
  ) {
    operation.snapshot = {
      ...operation.snapshot,
      state,
      finishedAt: nowRfc3339(),
      message,
    };
  }
}

/** Read the live integration state out of the Git directory. */
export async function gitIntegration(
  service: RepositoryService,
  context: RepositoryContext,
  signal?: AbortSignal,
): Promise<GitIntegration> {
  const gitDir = oneLine(
    await service.read(
      context.repository,
      ["rev-parse", "--absolute-git-dir"],
      signal,
    ),
  );
  const active: string[] = [];
  let rebaseDirectory: string | undefined;
  for (const [name, kind] of [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["MERGE_HEAD", "merge"],
    ["MERGE_AUTOSTASH", "unknown"],
    ["CHERRY_PICK_HEAD", "cherryPick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_START", "bisect"],
  ] as const) {
    const info = lstatSync(join(gitDir, name), { throwIfNoEntry: false });
    if (info === undefined) continue;
    if (info.isSymbolicLink()) {
      throw conflict(
        "Git integration metadata is a symlink; inspect it with Git before continuing",
      );
    }
    if (kind === "rebase") rebaseDirectory = join(gitDir, name);
    active.push(kind);
  }
  if (
    lstatSync(join(gitDir, "sequencer"), { throwIfNoEntry: false }) !==
    undefined
  ) {
    // Only single-commit picks are owned; an external sequence is never run.
    active.push("unknown");
  }
  const kind =
    active.length === 0
      ? "none"
      : active.length === 1
        ? (active[0] as string)
        : "unknown";
  // A rebase moves HEAD while it runs, so its identity comes from the sequence
  // directory Git itself writes, never from the current HEAD.
  const rebase = kind === "rebase" ? rebaseDirectory : undefined;

  let targetOid: string | null = null;
  let marker: MarkerIdentity | null = null;
  if (kind === "merge" || kind === "cherryPick" || kind === "revert") {
    const file =
      kind === "merge"
        ? "MERGE_HEAD"
        : kind === "revert"
          ? "REVERT_HEAD"
          : "CHERRY_PICK_HEAD";
    const read = readMarker(join(gitDir, file));
    targetOid = markerOid(read.bytes);
    marker = read.marker;
  } else if (kind === "rebase" && rebase !== undefined) {
    // The identity file is orig-head: it is written once when the sequence
    // starts and survives every step of the replay.
    const onto = optionalMarker(join(rebase, "onto"));
    if (onto !== undefined) {
      targetOid = markerOid(onto.bytes);
      marker = optionalMarker(join(rebase, "orig-head"))?.marker ?? null;
    }
  }

  let originalHead: string | null = null;
  if (kind === "rebase" && rebase !== undefined) {
    const orig = optionalMarker(join(rebase, "orig-head"));
    originalHead = orig === undefined ? null : markerOid(orig.bytes);
  } else if (kind !== "none" && kind !== "cherryPick" && kind !== "revert") {
    // Neither cherry-pick nor revert writes ORIG_HEAD, so reading one would
    // attribute an unrelated operation's start point to them.
    const orig = optionalMarker(join(gitDir, "ORIG_HEAD"));
    originalHead = orig === undefined ? null : markerOid(orig.bytes);
  }

  let headName: string | null = null;
  if (rebase !== undefined) {
    const read = optionalMarker(join(rebase, "head-name"));
    if (read !== undefined) {
      const name = oneLine(read.bytes);
      if (
        name.startsWith("refs/heads/") &&
        name.length > "refs/heads/".length
      ) {
        headName = name;
      }
    }
  }

  let message: string | null = null;
  const metadata = createHash("sha256");
  const files: [string, string][] =
    kind === "merge"
      ? [
          ["MERGE_MSG", join(gitDir, "MERGE_MSG")],
          ["MERGE_MODE", join(gitDir, "MERGE_MODE")],
        ]
      : kind === "cherryPick" || kind === "revert"
        ? [["MERGE_MSG", join(gitDir, "MERGE_MSG")]]
        : kind === "rebase" && rebase !== undefined
          ? // msgnum/end make each replayed step its own confirmable state.
            (["message", "msgnum", "end", "head-name", "onto"] as const).map(
              (name) => [name, join(rebase, name)] as [string, string],
            )
          : [];
  for (const [name, path] of files) {
    metadata.update(name);
    const read = optionalMarker(path);
    if (read === undefined) {
      metadata.update("absent");
      continue;
    }
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(read.bytes.byteLength));
    metadata.update(length);
    metadata.update(read.bytes);
    if (name === "MERGE_MSG" || name === "message") {
      message = read.bytes.toString("utf8");
    }
  }
  return {
    kind,
    message,
    metadataDigest: metadata.digest("hex"),
    targetOid,
    originalHead,
    headName,
    marker,
  };
}

export async function conflictFiles(
  service: RepositoryService,
  context: RepositoryContext,
  signal?: AbortSignal,
): Promise<ConflictFile[]> {
  const raw = await service.read(
    context.repository,
    ["ls-files", "--unmerged", "-z", "--"],
    signal,
  );
  const files = new Map<
    string,
    {
      path: string;
      base: ConflictSide | null;
      ours: ConflictSide | null;
      theirs: ConflictSide | null;
    }
  >();
  let previewBudget = 1024 * 1024;
  for (const record of splitNul(raw)) {
    if (record.length === 0) continue;
    const split = record.indexOf(0x09);
    if (split < 0) throw malformed();
    const header = record
      .subarray(0, split)
      .toString("utf8")
      .split(/\s+/)
      .filter((part) => part !== "");
    if (header.length !== 3 || !validOid(header[1] as string))
      throw malformed();
    const name = record.subarray(split + 1).toString("utf8");
    if (
      isAbsolute(name) ||
      name
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw malformed();
    }
    if (files.size >= 200 && !files.has(name)) {
      throw badRequest(
        "Too many conflict files for this view; inspect remaining conflicts with Git",
      );
    }
    const side = await conflictSide(
      service,
      context,
      header[0] as string,
      header[1] as string,
      previewBudget,
      signal,
    );
    previewBudget = side.budget;
    const file = files.get(name) ?? {
      path: name,
      base: null,
      ours: null,
      theirs: null,
    };
    files.set(name, file);
    const stage = header[2] as string;
    if (stage === "1") {
      if (file.base !== null) throw malformed();
      file.base = side.side;
    } else if (stage === "2") {
      if (file.ours !== null) throw malformed();
      file.ours = side.side;
    } else if (stage === "3") {
      if (file.theirs !== null) throw malformed();
      file.theirs = side.side;
    } else {
      throw malformed();
    }
  }
  return [...files.keys()]
    .sort()
    .map((name) => files.get(name) as ConflictFile);
}

async function conflictSide(
  service: RepositoryService,
  context: RepositoryContext,
  mode: string,
  oid: string,
  budget: number,
  signal?: AbortSignal,
): Promise<{ side: ConflictSide; budget: number }> {
  if (!["100644", "100755", "120000", "160000"].includes(mode)) {
    throw malformed();
  }
  const size = Number.parseInt(
    oneLine(
      await service.read(context.repository, ["cat-file", "-s", oid], signal),
    ),
    10,
  );
  if (Number.isNaN(size)) throw malformed();
  const truncated = size > MAX_PREVIEW || size > budget;
  if (truncated || mode === "160000") {
    return {
      side: { oid, mode, size, preview: "", binary: null, truncated },
      budget,
    };
  }
  const bytes = await service.read(
    context.repository,
    ["cat-file", "blob", oid],
    signal,
  );
  const binary = bytes.includes(0) || !isUtf8(bytes);
  return {
    side: {
      oid,
      mode,
      size,
      preview: binary ? "" : bytes.toString("utf8"),
      binary,
      truncated: false,
    },
    budget: budget - size,
  };
}

/**
 * A file deleted by the merge may have been recreated as ignored local
 * content. Abort must not overwrite it while restoring the old tree.
 */
export async function protectAbortPaths(
  service: RepositoryService,
  context: RepositoryContext,
  original: string,
  signal?: AbortSignal,
): Promise<void> {
  const changed = await service.read(
    context.repository,
    ["diff", "--cached", "--name-only", "--no-renames", "-z", original, "--"],
    signal,
  );
  for (const field of splitNul(changed)) {
    if (field.length === 0) continue;
    const name = field.toString("utf8");
    const parts = name.split("/");
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
      if (info.isDirectory() && prefix !== name) continue;
      if (!info.isDirectory() && prefix === name) {
        const tracked = await service.read(
          context.repository,
          ["ls-files", "-z", "--", `:(literal)${prefix}`],
          signal,
        );
        const known = splitNul(tracked).some(
          (entry) => entry.toString("utf8") === prefix,
        );
        if (!known) {
          throw conflict(
            "Abort would overwrite a local untracked or ignored file; preserve it first",
          );
        }
        break;
      }
      throw conflict(
        "A local directory or parent path blocks safe merge recovery",
      );
    }
  }
}

/* --------------------------------- markers -------------------------------- */

interface ReadMarker {
  readonly bytes: Buffer;
  readonly marker: MarkerIdentity;
}

function optionalMarker(path: string): ReadMarker | undefined {
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined)
    return undefined;
  return readMarker(path);
}

/**
 * One integration marker file, read without following a link and with its
 * identity captured: the digest plus the timestamps and inode that say it is
 * the *same* file and not a new one with the same contents.
 */
function readMarker(path: string): ReadMarker {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 64 * 1024) {
    throw conflict("Git integration marker is not a bounded regular file");
  }
  const handle = openSync(
    path,
    fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
  );
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size !== info.size) {
      throw conflict("Git integration marker changed while reading");
    }
    const bytes = Buffer.alloc(opened.size);
    const read = readSync(handle, bytes, 0, opened.size, 0);
    if (read !== opened.size) {
      throw conflict("Git integration marker changed while reading");
    }
    return {
      bytes,
      marker: {
        digest: sha256Hex(bytes),
        createdMs: opened.birthtimeMs,
        modifiedMs: opened.mtimeMs,
        deviceInode: `${opened.dev}:${opened.ino}`,
      },
    };
  } finally {
    closeSync(handle);
  }
}

function markerOid(bytes: Buffer): string | null {
  const ids = bytes
    .toString("utf8")
    .split(/\s+/)
    .filter((v) => v !== "");
  const only = ids[0];
  return ids.length === 1 && only !== undefined && validOid(only) ? only : null;
}

function sameMarker(
  left: MarkerIdentity | null,
  right: MarkerIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.digest === right.digest &&
    left.createdMs === right.createdMs &&
    left.modifiedMs === right.modifiedMs &&
    left.deviceInode === right.deviceInode
  );
}

function isUtf8(bytes: Buffer): boolean {
  return (
    Buffer.compare(Buffer.from(bytes.toString("utf8"), "utf8"), bytes) === 0
  );
}

function commandRefusal(stderr: Buffer): Error {
  return conflict(stderr.toString("utf8").slice(0, 2000));
}

export { isTerminal, repositoryId };
export type { Operation };
