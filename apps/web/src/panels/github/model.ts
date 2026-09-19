import {
  GithubApiError,
  GithubCheckConclusion,
  GithubCredentialSource,
  GithubIssue,
  GithubIssueState,
  GithubMergeMethod,
  GithubPullRequest,
  GithubPullState,
  GithubReviewState,
  GithubSecretStore,
  GithubStatusGroup,
  GithubStatusMapping,
  GithubWriteState,
} from "../../api/github";

/**
 * Display model for the GitHub page. Everything here is a pure function of
 * what the Host said: an Issue with no configured group lands in "unmapped"
 * rather than being invented into one, and a machine reason code is carried
 * through untranslated.
 */

/* -------------------------------- failures -------------------------------- */

/** Turns a client failure into the one sentence that says what to do next. */
export function failureKey(error: unknown): string {
  if (!(error instanceof GithubApiError)) return "github.error.network";
  if (error.outcomeUnknown) return "github.error.unknownOutcome";
  return `github.error.${error.failure}`;
}

/* --------------------------------- polling -------------------------------- */

/**
 * There is no webhook on a local Host, so the panel polls at the interval the
 * Host asked for. It is clamped on both ends: a zero would spin the API, and
 * an hour would make the page quietly stale.
 */
export const MIN_POLL_MS = 15_000;
export const MAX_POLL_MS = 300_000;

export function pollInterval(requested: bigint | undefined): number {
  const value = Number(requested ?? 0n);
  if (!Number.isFinite(value) || value <= 0) return MIN_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(value)));
}

/* ------------------------------ status groups ----------------------------- */

/** Issues under one configured group; `group` is null for the unmapped pile. */
export interface IssueGroup {
  id: string;
  group: GithubStatusGroup | null;
  issues: GithubIssue[];
}

export const UNMAPPED_GROUP_ID = "";

/**
 * Buckets issues by the group the Host reported on each Issue.
 *
 * The mapping decides the order and the titles; an Issue whose `statusGroupId`
 * is empty or names a group that is no longer configured goes to the unmapped
 * pile, because showing it under some other group would be a claim the Host
 * never made. The unmapped pile is only rendered when it has something in it.
 */
export function groupIssues(
  issues: readonly GithubIssue[],
  mapping: GithubStatusMapping | undefined,
): IssueGroup[] {
  const groups = mapping?.groups ?? [];
  const known = new Map(groups.map((group) => [group.id, group]));
  const buckets = new Map<string, GithubIssue[]>();
  for (const group of groups) buckets.set(group.id, []);
  buckets.set(UNMAPPED_GROUP_ID, []);
  for (const issue of issues) {
    const id =
      issue.statusGroupId && known.has(issue.statusGroupId)
        ? issue.statusGroupId
        : UNMAPPED_GROUP_ID;
    buckets.get(id)!.push(issue);
  }
  const result: IssueGroup[] = groups.map((group) => ({
    id: group.id,
    group,
    issues: buckets.get(group.id) ?? [],
  }));
  const unmapped = buckets.get(UNMAPPED_GROUP_ID) ?? [];
  if (unmapped.length > 0)
    result.push({ id: UNMAPPED_GROUP_ID, group: null, issues: unmapped });
  return result;
}

/* --------------------------------- labels --------------------------------- */

export function issueStateKey(state: GithubIssueState): string {
  switch (state) {
    case GithubIssueState.OPEN:
      return "github.issueState.open";
    case GithubIssueState.CLOSED:
      return "github.issueState.closed";
    default:
      return "github.issueState.unspecified";
  }
}

export function pullStateKey(pull: GithubPullRequest): string {
  switch (pull.state) {
    case GithubPullState.OPEN:
      return "github.pullState.open";
    case GithubPullState.CLOSED:
      return "github.pullState.closed";
    case GithubPullState.MERGED:
      return "github.pullState.merged";
    default:
      return "github.pullState.unspecified";
  }
}

export function checkConclusionKey(value: GithubCheckConclusion): string {
  switch (value) {
    case GithubCheckConclusion.PENDING:
      return "github.check.pending";
    case GithubCheckConclusion.SUCCESS:
      return "github.check.success";
    case GithubCheckConclusion.FAILURE:
      return "github.check.failure";
    case GithubCheckConclusion.NEUTRAL:
      return "github.check.neutral";
    case GithubCheckConclusion.CANCELLED:
      return "github.check.cancelled";
    case GithubCheckConclusion.SKIPPED:
      return "github.check.skipped";
    case GithubCheckConclusion.TIMED_OUT:
      return "github.check.timedOut";
    case GithubCheckConclusion.ACTION_REQUIRED:
      return "github.check.actionRequired";
    case GithubCheckConclusion.STALE:
      return "github.check.stale";
    default:
      return "github.check.unspecified";
  }
}

export function reviewStateKey(state: GithubReviewState): string {
  switch (state) {
    case GithubReviewState.COMMENTED:
      return "github.reviewState.commented";
    case GithubReviewState.APPROVED:
      return "github.reviewState.approved";
    case GithubReviewState.CHANGES_REQUESTED:
      return "github.reviewState.changesRequested";
    case GithubReviewState.DISMISSED:
      return "github.reviewState.dismissed";
    case GithubReviewState.PENDING:
      return "github.reviewState.pending";
    default:
      return "github.reviewState.unspecified";
  }
}

export function mergeMethodKey(method: GithubMergeMethod): string {
  switch (method) {
    case GithubMergeMethod.MERGE:
      return "github.mergeMethod.merge";
    case GithubMergeMethod.SQUASH:
      return "github.mergeMethod.squash";
    case GithubMergeMethod.REBASE:
      return "github.mergeMethod.rebase";
    default:
      return "github.mergeMethod.unspecified";
  }
}

export function writeStateKey(state: GithubWriteState): string {
  switch (state) {
    case GithubWriteState.APPLIED:
      return "github.writeState.applied";
    case GithubWriteState.PENDING:
      return "github.writeState.pending";
    case GithubWriteState.FAILED:
      return "github.writeState.failed";
    case GithubWriteState.CONFLICTED:
      return "github.writeState.conflicted";
    case GithubWriteState.SKIPPED:
      return "github.writeState.skipped";
    default:
      return "github.writeState.unspecified";
  }
}

export function credentialSourceKey(source: GithubCredentialSource): string {
  switch (source) {
    case GithubCredentialSource.NONE:
      return "github.source.none";
    case GithubCredentialSource.GH_CLI:
      return "github.source.ghCli";
    case GithubCredentialSource.TOKEN_REF:
      return "github.source.token";
    default:
      return "github.source.unspecified";
  }
}

export function secretStoreKey(store: GithubSecretStore): string {
  switch (store) {
    case GithubSecretStore.NONE:
      return "github.store.none";
    case GithubSecretStore.OS_KEYCHAIN:
      return "github.store.osKeychain";
    case GithubSecretStore.FILE_FALLBACK:
      return "github.store.fileFallback";
    default:
      return "github.store.unspecified";
  }
}

/**
 * The codes the Host documents for a refused merge. Anything else is shown as
 * the raw code alone rather than being explained with a guess.
 */
const MERGE_REASONS = new Set([
  "HEAD_MOVED",
  "CHECKS_CHANGED",
  "BLOCKED",
  "METHOD_NOT_ALLOWED",
  "NOT_MERGEABLE",
  "UNKNOWN_OUTCOME",
]);

export function mergeReasonKey(code: string): string | null {
  return MERGE_REASONS.has(code) ? `github.mergeReason.${code}` : null;
}

/* -------------------------------- checkout -------------------------------- */

/**
 * The local branch name suggested for checking a pull request out.
 *
 * A fork's head ref lives in someone else's repository, so reusing that name
 * locally would silently take over a branch the user may already have. Fork
 * pull requests are therefore suggested under a `pr-<number>` name derived
 * from the pull request itself, and same-repository ones keep their own ref.
 */
export function suggestedHeadRef(pull: GithubPullRequest): string {
  if (!pull.fromFork && pull.headRef) return pull.headRef;
  return `pr-${pull.number}`;
}

/* ---------------------------------- time ---------------------------------- */

/** Absolute instant; unset (0) reads as unknown rather than as the epoch. */
export function instant(
  value: bigint | undefined,
  locale: string,
): string | null {
  if (!value) return null;
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(millis));
}

/** Short, copyable head identity — the full SHA stays available as a title. */
export function shortSha(sha: string): string {
  return sha ? sha.slice(0, 12) : "";
}
