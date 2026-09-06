/**
 * The Host GitHub surface: one client class over per-domain request groups
 * (credential, issues, mapping, pulls, references) and the error, validation
 * and call-context modules they share.
 */

export type {
  DeleteGithubBranchResponse,
  GetGithubIssueResponse,
  GetGithubPullResponse,
  GithubCheckRun,
  GithubCheckSummary,
  GithubComment,
  GithubCredentialStatus,
  GithubExternalReference,
  GithubIssue,
  GithubIssueFilter,
  GithubIssuePatch,
  GithubLabel,
  GithubMilestone,
  GithubPullFile,
  GithubPullFilter,
  GithubPullRequest,
  GithubRateLimit,
  GithubRepository,
  GithubRepositoryRef,
  GithubReview,
  GithubReviewComment,
  GithubReviewCommentDraft,
  GithubStatusGroup,
  GithubStatusMapping,
  GithubStateCoupling,
  GithubUser,
  GithubWriteOutcome,
  ListGithubIssuesResponse,
  ListGithubPullsResponse,
  ListGithubReferencesResponse,
  MergeGithubPullResponse,
  MoveGithubIssueResponse,
  RerunGithubChecksResponse,
  ResolveGithubRepositoryResponse,
} from "@armadra/protocol";
export {
  GithubCheckConclusion,
  GithubCredentialSource,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMergeableState,
  GithubMergeMethod,
  GithubPullState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubReviewState,
  GithubSecretStore,
  GithubStatusSource,
  GithubWriteState,
} from "@armadra/protocol";

export { classifyGithubFailure, HostGithubError } from "./errors.js";
export type { HostGithubFailure } from "./errors.js";
export type { HostGithubClientOptions } from "./context.js";
export { HostGithubClient } from "./client.js";
