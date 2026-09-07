import { z } from "zod";
import { gitStatusSchema } from "./api/git.js";

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const count = z.number().int().nonnegative().safe();
export const gitExpectedStateSchema = z.object({
  headOid: oid.nullable(),
  branch: z.string().nullable(),
});
export const gitBranchRecordSchema = z.object({
  name: z.string(),
  fullRef: z.string(),
  oid,
  remote: z.boolean(),
  current: z.boolean(),
  upstream: z.string().nullable(),
  ahead: count.nullable(),
  behind: count.nullable(),
  upstreamMissing: z.boolean(),
  symbolicTarget: z.string().nullable(),
});
export const gitBranchSnapshotSchema = z.object({
  repositoryId: z.string().min(1),
  repositoryPath: z.string(),
  head: gitExpectedStateSchema,
  branches: z.array(gitBranchRecordSchema),
  remotes: z.array(z.string()),
  observedAt: z.string(),
});
export const gitCommitRecordSchema = z.object({
  oid,
  parents: z.array(oid),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authorTime: z.string(),
  committerTime: z.string(),
  refs: z.array(z.string()),
});
export const gitHistoryPageSchema = z.object({
  reference: z.string(),
  anchorOid: oid.nullable(),
  commits: z.array(gitCommitRecordSchema),
  nextCursor: z.string().nullable(),
  shallow: z.boolean(),
});
export const gitWorktreeRecordSchema = z.object({
  path: z.string(),
  headOid: oid.nullable(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  bare: z.boolean(),
  isMain: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().nullable(),
  prunable: z.boolean(),
  pruneReason: z.string().nullable(),
  accessible: z.boolean(),
  dirty: z.boolean().nullable(),
});
export const gitWorktreesSchema = z.array(gitWorktreeRecordSchema);

/**
 * How a checkout under the workspace came to be a repository (roadmap §4.1).
 * `root` is the workspace directory itself, `nested` an independent repository
 * in a subdirectory, `submodule` a `.git` file pointing into a superproject's
 * `.git/modules`, and `worktree` a linked checkout of another repository here.
 */
export const gitRepositoryKindSchema = z.enum([
  "root",
  "nested",
  "submodule",
  "worktree",
]);
export const gitRepositoryRecordSchema = z.object({
  /**
   * Derived from the canonical common directory, so it matches the
   * `repositoryId` on every snapshot the repository service returns. Linked
   * worktrees of one repository therefore share an id — they are the same
   * repository — and `repositoryPath` is what identifies a checkout.
   */
  repositoryId: z.string().min(1),
  /** Workspace-relative, `.` for the root; the `path` every Git request takes. */
  repositoryPath: z.string().min(1),
  name: z.string().min(1),
  kind: gitRepositoryKindSchema,
  /** The enclosing repository, or the main checkout of a linked worktree. */
  parentRepositoryId: z.string().min(1).nullable(),
  /** Null on a detached HEAD. */
  headBranch: z.string().nullable(),
  /**
   * Null when the workspace has no execution grant: counting changes runs
   * `git status`, which may invoke repository filters. Unknown, never zero.
   */
  dirtyCount: count.nullable(),
});
export const gitRepositoryListSchema = z.object({
  workspaceRoot: z.string(),
  maxDepth: count,
  repositories: z.array(gitRepositoryRecordSchema),
  /** The scan hit a ceiling, so the list may be incomplete. */
  truncated: z.boolean(),
  observedAt: z.string(),
});
/**
 * What one commit changed. The file list and a file's patch are separate reads:
 * a commit can touch thousands of files and one file can be megabytes, so
 * selecting a row in the graph must not be an unbounded operation.
 */
export const gitCommitFileSchema = z.object({
  status: z.string().min(1).max(4),
  path: z.string().min(1),
  /** Null for a binary file, which has no line counts — never a false zero. */
  additions: count.nullable(),
  deletions: count.nullable(),
});
export const gitCommitDetailSchema = z.object({
  oid,
  /** Null for a root commit compared with its first parent. */
  baseOid: oid.nullable(),
  commit: gitCommitRecordSchema,
  files: z.array(gitCommitFileSchema),
  truncated: z.boolean(),
});
export const gitCommitFileDiffSchema = z.object({
  oid,
  baseOid: oid.nullable(),
  path: z.string().min(1),
  patch: z.string(),
  truncated: z.boolean(),
});
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>;
export type GitCommitFileDiff = z.infer<typeof gitCommitFileDiffSchema>;
export type GitRepositoryKind = z.infer<typeof gitRepositoryKindSchema>;
export type GitRepositoryRecord = z.infer<typeof gitRepositoryRecordSchema>;
export type GitRepositoryList = z.infer<typeof gitRepositoryListSchema>;

/* ------------------ the Git window's workspace-level reads ---------------- */

/**
 * Which refs the merged log walks (Git 工具窗口设计 §3.1).
 *
 * `head` is each repository's own HEAD — the default view. `all` is every ref
 * in every repository. `named` is the branch tree's selection, and a name only
 * one repository has narrows the graph to that repository rather than failing
 * the others' reads.
 */
export const gitLogRefKindSchema = z.enum(["head", "all", "named"]);
export const gitLogRefsSchema = z.object({
  kind: gitLogRefKindSchema,
  names: z.array(z.string().min(1)).max(64).optional(),
});
/** The search box and its two switches, applied by Git rather than by the client. */
export const gitLogTextSchema = z.object({
  query: z.string(),
  regex: z.boolean().optional(),
  matchCase: z.boolean().optional(),
});
/**
 * One page of the merged commit log.
 *
 * `repositories` absent means every discovered checkout; naming some narrows
 * the merge to those, and they must be checkouts discovery found, because the
 * colour a row is drawn with is a position in that list.
 *
 * `cursor` belongs to the filters it was taken under: `--skip` counts commits
 * that passed the filter, so a cursor offered back under different filters is
 * refused with `invalid_cursor` rather than answered with a window over neither
 * set. Reload from the first page when that happens.
 */
export const gitLogRequestSchema = z.object({
  repositories: z.array(z.string().min(1)).max(64).optional(),
  refs: gitLogRefsSchema.optional(),
  authors: z.array(z.string().min(1)).max(64).optional(),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  /** Repository-relative pathspecs, applied in every repository the merge walks. */
  paths: z.array(z.string().min(1)).optional(),
  text: gitLogTextSchema.optional(),
  cursor: z.string().nullable().optional(),
  /** 1–200; the service defaults to 100. */
  limit: z.number().int().min(1).max(200).optional(),
});
/** One row of the merged graph: the commit record, plus the checkout it is from. */
export const gitLogCommitSchema = gitCommitRecordSchema.extend({
  /** Workspace-relative, `.` for the root. */
  repositoryPath: z.string().min(1),
});
export const gitLogRepositorySchema = z.object({
  path: z.string().min(1),
  /**
   * The checkout's position in the workspace's discovery list — the index the
   * row stripe takes its colour from. Unchanged when the log is narrowed, so a
   * repository keeps its colour whether or not the others are shown.
   */
  color: count,
});
export const gitLogPageSchema = z.object({
  commits: z.array(gitLogCommitSchema),
  nextCursor: z.string().nullable(),
  repositories: z.array(gitLogRepositorySchema),
  /** The workspace has more repositories than one merge walks. */
  truncated: z.boolean(),
});

export const gitRefsHeadSchema = z.object({
  /** Null on an unborn branch, which has no commit yet. */
  oid: oid.nullable(),
  /** Null on a detached HEAD. */
  branch: z.string().nullable(),
});
export const gitRefsBranchSchema = z.object({
  name: z.string().min(1),
  oid,
  /** The upstream's short name (`origin/main`), or null when there is none. */
  upstream: z.string().nullable(),
  /**
   * Only meaningful with an upstream. Null says "not tracking", never zero:
   * "nothing to push" and "nowhere to push" are different answers.
   */
  ahead: count.nullable(),
  behind: count.nullable(),
  current: z.boolean(),
});
export const gitRefsRemoteSchema = z.object({
  name: z.string().min(1),
  /** Names inside the remote, without the remote's own prefix. */
  branches: z.array(z.object({ name: z.string().min(1), oid })),
});
export const gitRefsTagSchema = z.object({
  name: z.string().min(1),
  /** The commit the tag names — an annotated tag reports its peeled object. */
  oid,
  annotated: z.boolean(),
});
export const gitRefsWorktreeSchema = z.object({
  /** Absolute, as Git reports it. */
  path: z.string().min(1),
  /** Null on a detached or bare checkout. */
  branch: z.string().nullable(),
  oid: oid.nullable(),
  locked: z.boolean(),
});
/**
 * One entry of a checkout's stash stack.
 *
 * The tree needs entries and not only a count: the stash node's context menu
 * applies, pops, drops or shows *one* stash, and each of those names it by the
 * object that was observed — the `stash@{n}` selector moves the moment another
 * stash is pushed or dropped.
 */
export const gitRefsStashSchema = z.object({
  index: count,
  oid,
  message: z.string(),
  createdAt: z.string(),
});
/**
 * One discovered checkout's whole branch tree (Git 工具窗口设计 §3.1).
 *
 * The whole workspace comes back in one answer, so the window's left column is
 * one request rather than five per repository. A checkout that cannot be read
 * is left out rather than failing the request: a branch tree that vanishes
 * because one vendored clone is broken is worse than one missing that clone.
 */
export const gitRefsSnapshotSchema = z.array(
  z.object({
    repositoryPath: z.string().min(1),
    repositoryId: z.string().min(1),
    kind: gitRepositoryKindSchema,
    name: z.string().min(1),
    head: gitRefsHeadSchema,
    branches: z.array(gitRefsBranchSchema),
    remotes: z.array(gitRefsRemoteSchema),
    tags: z.array(gitRefsTagSchema),
    worktrees: z.array(gitRefsWorktreeSchema),
    /** What the group's heading draws, without counting the list. */
    stashCount: count,
    stashes: z.array(gitRefsStashSchema),
  }),
);

/**
 * Who a commit from this checkout would be attributed to.
 *
 * Both fields are null on a machine that has configured no identity, which is
 * a normal machine — the log's "mine" filter simply has nothing to filter by.
 */
export const gitIdentitySchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
});
/**
 * What an interactive rebase does with one replayed commit. Deliberately small:
 * no `edit`, no `exec`, and no `reword` — each would need an interactive editor
 * this service cannot drive. A squash keeps Git's own prefilled combined
 * message rather than one the app invents.
 */
/**
 * What an interactive rebase does with one replayed commit.
 *
 * `exec` is deliberately absent: it is the one verb whose meaning is an
 * arbitrary command supplied by the caller, and nothing here runs one.
 */
export const gitRebaseTodoCommandSchema = z.enum([
  "pick",
  /** Replay it and use the message the entry carries. */
  "reword",
  /** Replay it and stop, so a person can amend and continue. */
  "edit",
  /** Combine into the previous entry, keeping both messages. */
  "squash",
  /** Combine into the previous entry, discarding this one's message. */
  "fixup",
  "drop",
]);
export const gitRebaseTodoEntrySchema = z
  .object({
    oid,
    command: gitRebaseTodoCommandSchema,
    /**
     * The replacement message, for `reword` only. It is refused on every other
     * verb rather than ignored: a caller that sent one believed it would be
     * used, and dropping it silently would rewrite history with the old message
     * and report success.
     */
    message: z.string().min(1).max(10_000).optional(),
  })
  .strict()
  .refine(
    (entry) => (entry.command === "reword") === (entry.message !== undefined),
    { message: "Only a reword carries a message, and it always carries one" },
  );
export const gitRebaseTodoPreviewSchema = z.object({
  onto: oid,
  /** The merge base the replay starts from. */
  base: oid,
  head: gitExpectedStateSchema,
  /** Oldest first — the order the todo list itself uses. */
  commits: z.array(gitCommitRecordSchema),
  /** A merge commit in the range; the todo editor is not offered for it. */
  hasMerges: z.boolean(),
});

export const gitTagRecordSchema = z.object({
  name: z.string(),
  fullRef: z.string(),
  /** The tag object for an annotated tag, the commit for a lightweight one. */
  oid,
  /** The commit the tag ultimately names. */
  targetOid: oid,
  annotated: z.boolean(),
  subject: z.string().nullable(),
  taggerName: z.string().nullable(),
  taggerTime: z.string().nullable(),
});
export const gitTagSnapshotSchema = z.object({
  repositoryId: z.string().min(1),
  repositoryPath: z.string(),
  head: gitExpectedStateSchema,
  tags: z.array(gitTagRecordSchema),
  observedAt: z.string(),
});
export const gitRemoteRecordSchema = z.object({
  name: z.string(),
  /**
   * Credentials embedded in a stored URL are replaced before the value leaves
   * the Runtime, so a redacted value is a display string and must never be
   * sent back as an update.
   */
  fetchUrl: z.string(),
  pushUrl: z.string(),
  redacted: z.boolean(),
});
export const gitRemotesSchema = z.array(gitRemoteRecordSchema);
export const gitStashRecordSchema = z.object({
  oid,
  selector: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authorTime: z.string(),
});
export const gitStashSnapshotSchema = z.object({
  repositoryId: z.string().min(1),
  repositoryPath: z.string(),
  head: gitExpectedStateSchema,
  stateToken: z.string().regex(/^[a-f0-9]{64}$/),
  dirty: z.boolean(),
  hasConflicts: z.boolean(),
  stashes: z.array(gitStashRecordSchema),
});
export const gitStashDetailSchema = z.object({
  oid,
  parents: z.array(oid).min(2).max(3),
  patch: z.string(),
  stagedPatch: z.string(),
  untrackedPatch: z.string(),
});
export type GitStashRecord = z.infer<typeof gitStashRecordSchema>;
export type GitStashSnapshot = z.infer<typeof gitStashSnapshotSchema>;
export type GitStashDetail = z.infer<typeof gitStashDetailSchema>;
const stashStateToken = z.string().regex(/^[a-f0-9]{64}$/);
export const gitRepositoryActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("startCherryPick"),
      targetOid: oid,
      mainline: z.number().int().min(1).max(4294967295).nullable(),
      recordOrigin: z.boolean(),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      // Applies the inverse of a reviewed commit. The original commit stays in
      // history; a conflict becomes the same owned integration a cherry-pick
      // does, recovered through continue/abort. There is no skip: dropping a
      // revert would silently leave the change it was meant to undo in place.
      kind: z.literal("revert"),
      targetOid: oid,
      mainline: z.number().int().min(1).max(4294967295).nullable(),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      // Detaches HEAD at a reviewed commit. The branch does not move, and
      // later commits belong to no branch until one is created.
      kind: z.literal("checkoutCommit"),
      targetOid: oid,
    })
    .strict(),
  z
    .object({
      // Moves the current ref to a reviewed commit. `soft` keeps index and
      // worktree, `mixed` also resets the index, `hard` replaces both — and
      // `hard` is the only one that can lose uncommitted work, so it needs
      // `discardChanges` whenever anything is uncommitted and always records
      // a stash snapshot first as the way back.
      kind: z.literal("reset"),
      mode: z.enum(["soft", "mixed", "hard"]),
      targetOid: oid,
      expectedStateToken: stashStateToken,
      discardChanges: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("skipIntegration"),
      sessionId: z.string().uuid(),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("startMerge"),
      targetOid: oid,
      message: z.string().max(4096),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("startRebase"),
      // A branch name or an object ID; the service resolves and confirms it.
      onto: z.string().min(1).max(1024),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      // The todo must name every commit the rebase would replay: a commit can
      // only be dropped by saying `drop`, never by being left out of the list.
      kind: z.literal("startInteractiveRebase"),
      onto: z.string().min(1).max(1024),
      todo: z.array(gitRebaseTodoEntrySchema).min(1).max(1000),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("continueIntegration"),
      sessionId: z.string().uuid(),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("abortIntegration"),
      sessionId: z.string().uuid(),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("createStash"),
      message: z.string().max(4096),
      includeUntracked: z.boolean(),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("applyStash"),
      oid,
      reinstateIndex: z.boolean(),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("popStash"),
      oid,
      reinstateIndex: z.boolean(),
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dropStash"),
      oid,
      expectedStateToken: stashStateToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("createBranch"),
      name: z.string().min(1),
      startPoint: z.string().nullable(),
      switch: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("switchBranch"),
      name: z.string().min(1),
      expectedOid: oid,
    })
    .strict(),
  z
    .object({
      kind: z.literal("deleteBranch"),
      name: z.string().min(1),
      expectedOid: oid,
    })
    .strict(),
  /**
   * `git branch -m`, and nothing else: no force, so a name something already
   * holds is Git's own refusal rather than a silent overwrite. The upstream
   * follows the branch because Git moves it, and `expectedOid` is the commit
   * the tree drew — a branch that advanced since then is a conflict.
   */
  z
    .object({
      kind: z.literal("renameBranch"),
      name: z.string().min(1),
      newName: z.string().min(1),
      expectedOid: oid,
    })
    .strict()
    .refine((action) => action.name !== action.newName, {
      path: ["newName"],
      message: "The new branch name is the current one",
    }),
  z
    .object({
      kind: z.literal("fetch"),
      remote: z.string().min(1),
      prune: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull"),
      remote: z.string().min(1),
      branch: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("push"),
      remote: z.string().min(1),
      branch: z.string().min(1),
      setUpstream: z.boolean(),
      // Rewriting remote history always names the remote OID the user
      // reviewed; there is deliberately no lease-free force.
      forceWithLease: z.object({ expectedRemoteOid: oid }).strict().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sync"),
      remote: z.string().min(1),
      branch: z.string().min(1),
      // Null means the branch has no remote-tracking ref yet.
      expectedRemoteOid: oid.nullable(),
    })
    .strict(),
  z
    .object({
      // `message` present makes it an annotated tag. There is no force:
      // replacing a tag is an explicit delete followed by a create.
      kind: z.literal("createTag"),
      name: z.string().min(1).max(255),
      targetOid: oid,
      message: z.string().max(4096).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deleteTag"),
      name: z.string().min(1).max(255),
      // The tag object the caller reviewed, not the commit behind it.
      expectedOid: oid,
    })
    .strict(),
  z
    .object({
      // Publishing one tag, never forced: an object already published under
      // that name is refused rather than overwritten.
      kind: z.literal("pushTag"),
      remote: z.string().min(1),
      name: z.string().min(1).max(255),
      expectedOid: oid,
    })
    .strict(),
  z
    .object({
      kind: z.literal("addRemote"),
      name: z.string().min(1).max(255),
      // Same allow-list as clone: https, ssh, or scp-like only.
      url: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      kind: z.literal("renameRemote"),
      name: z.string().min(1).max(255),
      newName: z.string().min(1).max(255),
    })
    .strict(),
  z
    .object({
      kind: z.literal("setRemoteUrl"),
      name: z.string().min(1).max(255),
      url: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      kind: z.literal("removeRemote"),
      name: z.string().min(1).max(255),
    })
    .strict(),
  z
    .object({
      kind: z.literal("createWorktree"),
      expectedOid: oid.nullable(),
      path: z.string().min(1),
      branch: z.string().min(1),
      createBranch: z.boolean(),
      startPoint: z.string().nullable(),
    })
    .strict()
    .refine(
      (action) =>
        action.createBranch
          ? action.expectedOid === null
          : action.expectedOid !== null,
      {
        path: ["expectedOid"],
        message: "Existing worktree branches require their observed object ID",
      },
    ),
  z
    .object({
      kind: z.literal("removeWorktree"),
      path: z.string().min(1),
      expectedOid: oid,
      allowUnpublished: z.boolean(),
    })
    .strict(),
]);
export const gitRepositoryOperationSchema = z.object({
  id: z.string().min(1),
  repositoryId: z.string().min(1),
  workspaceRoot: z.string(),
  repositoryPath: z.string(),
  action: gitRepositoryActionSchema,
  state: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknownOutcome",
    "awaitingResolution",
  ]),
  cancellationRequested: z.boolean(),
  /**
   * 0–100, as the running `git --progress` reported it. Only the network
   * commands produce one; it can stall, and a finished operation reports 100
   * whether or not `git` ever printed it.
   */
  progress: count.max(100).default(0),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string().nullable(),
});

/**
 * One reference-log entry (Git 设计 §3 "Reflog").
 *
 * The reflog is the only record of where a ref *used to* point, so it is the
 * one place a commit that a reset or a rebase left unreachable can still be
 * found. `selector` rather than `oid` is the identity a recovery is built
 * from: `HEAD@{3}` is what Git resolves back to that moment, and several
 * entries can share one OID.
 */
export const gitReflogEntrySchema = z.object({
  index: count,
  selector: z.string().min(1),
  oid,
  /** The ref's value before this entry, when the previous one is on this page. */
  previousOid: oid.nullable(),
  /** `commit`, `checkout`, `reset`, `rebase` — Git's own verb, possibly empty. */
  action: z.string(),
  message: z.string(),
  committerName: z.string(),
  committerEmail: z.string(),
  /** When the entry was written, which is not the commit's own date. */
  loggedAt: z.string(),
});
export const gitReflogPageSchema = z.object({
  reference: z.string(),
  entries: z.array(gitReflogEntrySchema),
  nextCursor: z.string().nullable(),
});

/**
 * Several checkouts' status in one answer (Git 设计 §4.1 全部仓库聚合).
 *
 * Each repository carries its own failure. One broken checkout in a workspace
 * of twelve must not blank the other eleven, and a row that could not be read
 * is a different thing to draw from one that is clean.
 */
export const gitStatusBatchEntrySchema = z.object({
  path: z.string(),
  status: gitStatusSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const gitStatusBatchSchema = z.object({
  repositories: z.array(gitStatusBatchEntrySchema),
  /**
   * When the batch was taken. One timestamp for the whole answer, which is the
   * honest thing to say: the checkouts were read in sequence, so it is "not
   * older than", never "at this instant".
   */
  observedAt: z.string(),
});

/**
 * Whether a Frame's worktree binding still names a checkout of the repository
 * it claims (Git 设计 §5.1, §5.3).
 *
 * `code` rather than a bare boolean because the repairs differ: a checkout that
 * was removed, a branch somebody switched and a repository that was re-cloned
 * elsewhere are three different things for a person to fix.
 */
export const gitWorktreeBindingCodeSchema = z.enum([
  "ok",
  "pathMissing",
  "notAWorktree",
  "repositoryMismatch",
  "branchChanged",
]);
export const gitWorktreeBindingVerdictSchema = z.object({
  valid: z.boolean(),
  code: gitWorktreeBindingCodeSchema,
  /** The path as the execution host resolved it, workspace-relative. */
  worktreePath: z.string(),
  /** The same path, absolute — what a terminal's `cwd` needs. */
  absolutePath: z.string(),
  repositoryId: z.string(),
  branch: z.string().nullable(),
  headOid: oid.nullable(),
  isMain: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
});
export type GitLogRefKind = z.infer<typeof gitLogRefKindSchema>;
export type GitLogRefs = z.infer<typeof gitLogRefsSchema>;
export type GitLogText = z.infer<typeof gitLogTextSchema>;
export type GitLogRequest = z.infer<typeof gitLogRequestSchema>;
export type GitLogCommit = z.infer<typeof gitLogCommitSchema>;
export type GitLogRepository = z.infer<typeof gitLogRepositorySchema>;
export type GitLogPage = z.infer<typeof gitLogPageSchema>;
export type GitRefsHead = z.infer<typeof gitRefsHeadSchema>;
export type GitRefsBranch = z.infer<typeof gitRefsBranchSchema>;
export type GitRefsRemote = z.infer<typeof gitRefsRemoteSchema>;
export type GitRefsTag = z.infer<typeof gitRefsTagSchema>;
export type GitRefsWorktree = z.infer<typeof gitRefsWorktreeSchema>;
export type GitRefsStash = z.infer<typeof gitRefsStashSchema>;
export type GitIdentity = z.infer<typeof gitIdentitySchema>;
export type GitRefsSnapshot = z.infer<typeof gitRefsSnapshotSchema>;
/** One repository's row in the branch tree, which is what a tree node draws. */
export type GitRefsRepository = GitRefsSnapshot[number];
export type GitExpectedState = z.infer<typeof gitExpectedStateSchema>;
export type GitBranchSnapshot = z.infer<typeof gitBranchSnapshotSchema>;
export type GitBranchRecord = z.infer<typeof gitBranchRecordSchema>;
export type GitCommitRecord = z.infer<typeof gitCommitRecordSchema>;
export type GitHistoryPage = z.infer<typeof gitHistoryPageSchema>;
export type GitWorktreeRecord = z.infer<typeof gitWorktreeRecordSchema>;
export type GitRebaseTodoCommand = z.infer<typeof gitRebaseTodoCommandSchema>;
export type GitRebaseTodoEntry = z.infer<typeof gitRebaseTodoEntrySchema>;
export type GitRebaseTodoPreview = z.infer<typeof gitRebaseTodoPreviewSchema>;
export type GitTagRecord = z.infer<typeof gitTagRecordSchema>;
export type GitTagSnapshot = z.infer<typeof gitTagSnapshotSchema>;
export type GitRemoteRecord = z.infer<typeof gitRemoteRecordSchema>;
export type GitRepositoryAction = z.infer<typeof gitRepositoryActionSchema>;
export type GitForceWithLease = NonNullable<
  Extract<GitRepositoryAction, { kind: "push" }>["forceWithLease"]
>;
export type GitRepositoryOperation = z.infer<
  typeof gitRepositoryOperationSchema
>;
export type GitReflogEntry = z.infer<typeof gitReflogEntrySchema>;
export type GitReflogPage = z.infer<typeof gitReflogPageSchema>;
export type GitStatusBatchEntry = z.infer<typeof gitStatusBatchEntrySchema>;
export type GitStatusBatch = z.infer<typeof gitStatusBatchSchema>;
export type GitWorktreeBindingCode = z.infer<
  typeof gitWorktreeBindingCodeSchema
>;
export type GitWorktreeBindingVerdict = z.infer<
  typeof gitWorktreeBindingVerdictSchema
>;
