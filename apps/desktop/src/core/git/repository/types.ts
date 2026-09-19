/**
 * The repository service's wire vocabulary: the mutation verbs it accepts and
 * the records it answers with.
 *
 * Ported field for field from `apps/runtime/src/git/repository/`. Every name
 * here is contractual — `packages/shared` has a zod schema for each, and
 * `apps/web` switches on the string values.
 */

export interface ExpectedState {
  /** `null` means an unborn HEAD, not "skip validation". */
  readonly headOid: string | null;
  /** `null` means a detached HEAD. */
  readonly branch: string | null;
}

export type OperationState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknownOutcome"
  | "awaitingResolution";

export function isTerminal(state: OperationState): boolean {
  return state !== "queued" && state !== "running";
}

export interface OperationSnapshot {
  readonly id: string;
  readonly repositoryId: string;
  readonly workspaceRoot: string;
  readonly repositoryPath: string;
  readonly action: RepositoryAction;
  readonly state: OperationState;
  readonly cancellationRequested: boolean;
  /** 0–100, as the running `git --progress` reported it. A display value. */
  readonly progress: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly message: string | null;
}

/** How far back a reset takes the repository. */
export type ResetMode = "soft" | "mixed" | "hard";

export function resetFlag(mode: ResetMode): string {
  return mode === "soft" ? "--soft" : mode === "mixed" ? "--mixed" : "--hard";
}

/**
 * What an interactive rebase does with one replayed commit.
 *
 * `exec` is deliberately absent: it is the one verb whose meaning is an
 * arbitrary command supplied by the caller, and this service never runs one.
 */
export type RebaseTodoCommand =
  | "pick"
  | "reword"
  | "edit"
  | "squash"
  | "fixup"
  | "drop";

export function todoKeyword(command: RebaseTodoCommand): string {
  // A reword is written as a pick plus a generated amend; Git's own `reword`
  // would open an editor, and there is no editor here to open.
  return command === "reword" ? "pick" : command;
}

/** Whether this verb leaves a commit behind for a later squash or fixup. */
export function keepsCommit(command: RebaseTodoCommand): boolean {
  return command !== "drop";
}

export interface RebaseTodoEntry {
  readonly oid: string;
  readonly command: RebaseTodoCommand;
  /** The replacement message, for `reword` only. */
  readonly message?: string;
}

export interface CommitRecord {
  readonly oid: string;
  readonly parents: string[];
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTime: string;
  readonly committerTime: string;
  readonly refs: string[];
}

export interface RebaseTodoPreview {
  readonly onto: string;
  /** The merge base the replay starts from. */
  readonly base: string;
  readonly head: ExpectedState;
  readonly commits: CommitRecord[];
  /** A merge commit in the range: the todo editor is not offered for it. */
  readonly hasMerges: boolean;
}

/**
 * The only way to overwrite remote history. There is deliberately no
 * lease-free force, and no lease against whatever a background fetch saw.
 */
export interface ForceWithLease {
  readonly expectedRemoteOid: string;
}

export type RepositoryAction =
  | {
      readonly kind: "startCherryPick";
      readonly targetOid: string;
      readonly mainline: number | null;
      readonly recordOrigin: boolean;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "revert";
      readonly targetOid: string;
      readonly mainline: number | null;
      readonly expectedStateToken: string;
    }
  | { readonly kind: "checkoutCommit"; readonly targetOid: string }
  | {
      readonly kind: "reset";
      readonly mode: ResetMode;
      readonly targetOid: string;
      readonly expectedStateToken: string;
      readonly discardChanges: boolean;
    }
  | {
      readonly kind: "skipIntegration";
      readonly sessionId: string;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "startMerge";
      readonly targetOid: string;
      readonly message: string;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "startRebase";
      readonly onto: string;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "startInteractiveRebase";
      readonly onto: string;
      readonly todo: RebaseTodoEntry[];
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "continueIntegration";
      readonly sessionId: string;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "abortIntegration";
      readonly sessionId: string;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "createStash";
      readonly message: string;
      readonly includeUntracked: boolean;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "applyStash";
      readonly oid: string;
      readonly reinstateIndex: boolean;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "popStash";
      readonly oid: string;
      readonly reinstateIndex: boolean;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "dropStash";
      readonly oid: string;
      readonly expectedStateToken: string;
    }
  | {
      readonly kind: "createBranch";
      readonly name: string;
      readonly startPoint: string | null;
      readonly switch: boolean;
    }
  | {
      readonly kind: "switchBranch";
      readonly name: string;
      readonly expectedOid: string;
    }
  | {
      readonly kind: "deleteBranch";
      readonly name: string;
      readonly expectedOid: string;
    }
  | {
      readonly kind: "renameBranch";
      readonly name: string;
      readonly newName: string;
      readonly expectedOid: string;
    }
  | { readonly kind: "fetch"; readonly remote: string; readonly prune: boolean }
  | { readonly kind: "pull"; readonly remote: string; readonly branch: string }
  | {
      readonly kind: "push";
      readonly remote: string;
      readonly branch: string;
      readonly setUpstream: boolean;
      readonly forceWithLease: ForceWithLease | null;
    }
  | {
      readonly kind: "sync";
      readonly remote: string;
      readonly branch: string;
      readonly expectedRemoteOid: string | null;
    }
  | {
      readonly kind: "createTag";
      readonly name: string;
      readonly targetOid: string;
      readonly message: string | null;
    }
  | {
      readonly kind: "deleteTag";
      readonly name: string;
      readonly expectedOid: string;
    }
  | {
      readonly kind: "pushTag";
      readonly remote: string;
      readonly name: string;
      readonly expectedOid: string;
    }
  | { readonly kind: "addRemote"; readonly name: string; readonly url: string }
  | {
      readonly kind: "renameRemote";
      readonly name: string;
      readonly newName: string;
    }
  | {
      readonly kind: "setRemoteUrl";
      readonly name: string;
      readonly url: string;
    }
  | { readonly kind: "removeRemote"; readonly name: string }
  | {
      readonly kind: "createWorktree";
      readonly path: string;
      readonly branch: string;
      readonly createBranch: boolean;
      readonly startPoint: string | null;
      readonly expectedOid: string | null;
    }
  | {
      readonly kind: "removeWorktree";
      readonly path: string;
      readonly expectedOid: string;
      readonly allowUnpublished: boolean;
    };

/* --------------------------------- records -------------------------------- */

export interface BranchRecord {
  readonly name: string;
  readonly fullRef: string;
  readonly oid: string;
  readonly remote: boolean;
  readonly current: boolean;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly upstreamMissing: boolean;
  readonly symbolicTarget: string | null;
}

export interface BranchSnapshot {
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly head: ExpectedState;
  readonly branches: BranchRecord[];
  readonly remotes: string[];
  readonly observedAt: string;
}

export interface HistoryRequest {
  readonly reference: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly paths: string[];
}

export interface HistoryPage {
  readonly reference: string;
  readonly anchorOid: string | null;
  readonly commits: CommitRecord[];
  readonly nextCursor: string | null;
  readonly shallow: boolean;
}

export interface ReflogRequest {
  readonly reference: string;
  readonly limit: number;
  readonly cursor: string | null;
}

export interface ReflogEntry {
  readonly index: number;
  readonly selector: string;
  readonly oid: string;
  readonly previousOid: string | null;
  readonly action: string;
  readonly message: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly loggedAt: string;
}

export interface ReflogPage {
  readonly reference: string;
  readonly entries: ReflogEntry[];
  readonly nextCursor: string | null;
}

export interface IdentityRecord {
  readonly name: string | null;
  readonly email: string | null;
}

export interface TagRecord {
  readonly name: string;
  readonly fullRef: string;
  readonly oid: string;
  readonly targetOid: string;
  readonly annotated: boolean;
  readonly subject: string | null;
  readonly taggerName: string | null;
  readonly taggerTime: string | null;
}

export interface TagSnapshot {
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly head: ExpectedState;
  readonly tags: TagRecord[];
  readonly observedAt: string;
}

export interface RemoteRecord {
  readonly name: string;
  readonly fetchUrl: string;
  readonly pushUrl: string;
  readonly redacted: boolean;
}

export interface StashRecord {
  readonly oid: string;
  readonly selector: string;
  readonly subject: string;
  readonly authorName: string;
  readonly authorTime: string;
}

export interface StashSnapshot {
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly head: ExpectedState;
  readonly stateToken: string;
  readonly dirty: boolean;
  readonly hasConflicts: boolean;
  readonly stashes: StashRecord[];
}

export interface StashDetail {
  readonly oid: string;
  readonly parents: string[];
  readonly patch: string;
  readonly stagedPatch: string;
  readonly untrackedPatch: string;
}

export interface ConflictSide {
  readonly oid: string;
  readonly mode: string;
  readonly size: number;
  readonly preview: string;
  readonly binary: boolean | null;
  readonly truncated: boolean;
}

export interface ConflictFile {
  readonly path: string;
  readonly base: ConflictSide | null;
  readonly ours: ConflictSide | null;
  readonly theirs: ConflictSide | null;
}

export interface IntegrationSnapshot {
  repositoryId: string;
  repositoryPath: string;
  head: ExpectedState;
  stateToken: string;
  kind: string;
  owned: boolean;
  sessionId: string | null;
  originalHead: string | null;
  /** The branch a paused sequence returns to; a rebase detaches HEAD. */
  originalBranch: string | null;
  targetOid: string | null;
  message: string | null;
  dirty: boolean;
  canContinue: boolean;
  mainline: number | null;
  empty: boolean;
  canSkip: boolean;
  conflicts: ConflictFile[];
}

export interface CherryPickPreview {
  readonly targetOid: string;
  readonly parents: string[];
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTime: string;
  readonly mainline: number | null;
  /** `null` for a merge commit whose mainline the caller has not chosen. */
  readonly patch: string | null;
}

export interface CommitFile {
  readonly status: string;
  readonly path: string;
  /** `null` for a binary file, which has no line counts. */
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface CommitDetail {
  readonly oid: string;
  readonly baseOid: string | null;
  readonly commit: CommitRecord;
  readonly files: CommitFile[];
  readonly truncated: boolean;
}

export interface CommitFileDiff {
  readonly oid: string;
  readonly baseOid: string | null;
  readonly path: string;
  readonly patch: string;
  readonly truncated: boolean;
}

export interface WorktreeRecord {
  path: string;
  headOid: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
  /** False for another checkout outside this request's workspace authority. */
  accessible: boolean;
  /** Missing / prunable / unauthorized worktrees have no trustworthy state. */
  dirty: boolean | null;
}

export interface WorktreeBindingRequest {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly repositoryId: string | null;
}

export interface WorktreeBindingVerdict {
  readonly valid: boolean;
  /** `ok`, `pathMissing`, `notAWorktree`, `repositoryMismatch`, `branchChanged`. */
  readonly code: string;
  readonly worktreePath: string;
  readonly absolutePath: string;
  readonly repositoryId: string;
  readonly branch: string | null;
  readonly headOid: string | null;
  readonly isMain: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/* ------------------------------- branch tree ------------------------------ */

export interface RefsHead {
  readonly oid: string | null;
  readonly branch: string | null;
}
export interface RefsBranch {
  readonly name: string;
  readonly oid: string;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly current: boolean;
}
export interface RefsRemoteBranch {
  readonly name: string;
  readonly oid: string;
}
export interface RefsRemote {
  readonly name: string;
  readonly branches: RefsRemoteBranch[];
}
export interface RefsTag {
  readonly name: string;
  readonly oid: string;
  readonly annotated: boolean;
}
export interface RefsWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly oid: string | null;
  readonly locked: boolean;
}
export interface RefsStash {
  readonly index: number;
  readonly oid: string;
  readonly message: string;
  readonly createdAt: string;
}
export interface RefsSnapshot {
  readonly repositoryPath: string;
  readonly repositoryId: string;
  readonly kind: string;
  readonly name: string;
  readonly head: RefsHead;
  readonly branches: RefsBranch[];
  readonly remotes: RefsRemote[];
  readonly tags: RefsTag[];
  readonly worktrees: RefsWorktree[];
  readonly stashCount: number;
  readonly stashes: RefsStash[];
}

/* ---------------------------------- log ----------------------------------- */

export type LogRefKind = "head" | "all" | "named";

export interface LogRefs {
  readonly kind: LogRefKind;
  readonly names: string[];
}

export interface LogText {
  readonly query: string;
  readonly regex: boolean;
  readonly matchCase: boolean;
}

export interface LogRequest {
  readonly repositories: string[] | null;
  readonly refs: LogRefs;
  readonly authors: string[];
  readonly since: string | null;
  readonly until: string | null;
  readonly paths: string[];
  readonly text: LogText | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export type LogCommit = CommitRecord & { readonly repositoryPath: string };

export interface LogRepository {
  readonly path: string;
  readonly color: number;
}

export interface LogPage {
  readonly commits: LogCommit[];
  readonly nextCursor: string | null;
  readonly repositories: LogRepository[];
  readonly truncated: boolean;
}
