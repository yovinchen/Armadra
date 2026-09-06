import {
  HostGithubError,
  SERVICE,
  classifyGithubFailure,
  reject,
  requestId,
} from "./errors.js";
import { idPattern, scopedId } from "./validate.js";
import type { GithubCallContext, HostGithubClientOptions } from "./context.js";
import * as credential from "./credential.js";
import * as issues from "./issues.js";
import * as mapping from "./mapping.js";
import * as pulls from "./pulls.js";
import * as references from "./references.js";
import type {
  DeleteGithubBranchResponse,
  GetGithubIssueResponse,
  GetGithubPullResponse,
  GithubCheckConclusion,
  GithubCheckSummary,
  GithubComment,
  GithubCredentialSource,
  GithubCredentialStatus,
  GithubExternalReference,
  GithubIssue,
  GithubIssueFilter,
  GithubIssuePatch,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMergeMethod,
  GithubPullFilter,
  GithubPullRequest,
  GithubRepositoryRef,
  GithubReview,
  GithubReviewCommentDraft,
  GithubReviewState,
  GithubStatusMapping,
  ListGithubIssuesResponse,
  ListGithubPullsResponse,
  ListGithubReferencesResponse,
  MergeGithubPullResponse,
  MoveGithubIssueResponse,
  RerunGithubChecksResponse,
  ResolveGithubRepositoryResponse,
} from "@armadra/protocol";

/**
 * Typed access to the Host's authenticated GitHub surface.
 *
 * The session supplies principal, device and grants, so nothing here carries
 * identity, and no method ever sees a token: the Host holds the credential and
 * this client only names the repository to act on. Responses are validated
 * before they reach the UI — a half-decoded pull request rendered next to a
 * merge button would be claiming the Host said something it did not.
 *
 * The request groups live in sibling modules and are handed this client's
 * `GithubCallContext`; the methods below stay the surface callers hold.
 */
export class HostGithubClient {
  readonly #session: HostGithubClientOptions["session"];
  readonly #hostId: string;
  readonly #workspaceId: string;
  readonly #ctx: GithubCallContext;

  constructor(options: HostGithubClientOptions) {
    if (
      !options ||
      typeof options.session?.send !== "function" ||
      !idPattern.test(options.hostId ?? "") ||
      !scopedId.test(options.workspaceId ?? "")
    )
      reject("invalid");
    this.#session = options.session;
    this.#hostId = options.hostId;
    this.#workspaceId = options.workspaceId;
    this.#ctx = {
      workspaceId: this.#workspaceId,
      meta: () => this.#meta(),
      call: (action, body, mutation, decode) =>
        this.#call(action, body, mutation, decode),
    };
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }
  get hostId(): string {
    return this.#hostId;
  }

  #meta() {
    return {
      requestId: requestId(),
      scope: {
        hostId: this.#hostId,
        workspaceId: this.#workspaceId,
        executionHostId: this.#hostId,
      },
    };
  }

  async #call<T>(
    action: string,
    body: Uint8Array,
    mutation: boolean,
    decode: (wire: Uint8Array) => T,
  ): Promise<T> {
    let wire: Uint8Array;
    try {
      wire = await this.#session.send(SERVICE, action, body, mutation);
    } catch (error) {
      throw classifyGithubFailure(error);
    }
    try {
      return decode(wire);
    } catch (error) {
      if (error instanceof HostGithubError) throw error;
      throw new HostGithubError("response", mutation);
    }
  }

  /* ---------------------------------------------------------------- credentials */

  /** Never returns a token; only which source is configured and whether it works. */
  getCredential(): Promise<GithubCredentialStatus> {
    return credential.getCredential(this.#ctx);
  }

  /**
   * `token` is the one value that travels outbound, and only for TOKEN_REF.
   * It is not retained here and the Host answers with a status, never an echo.
   */
  configureCredential(input: {
    source: GithubCredentialSource;
    token?: string;
    apiBase?: string;
    expectedRevision: bigint;
  }): Promise<GithubCredentialStatus> {
    return credential.configureCredential(this.#ctx, input);
  }

  revokeCredential(input: {
    expectedRevision: bigint;
  }): Promise<GithubCredentialStatus> {
    return credential.revokeCredential(this.#ctx, input);
  }

  /* ---------------------------------------------------------------- repository */

  resolveRepository(
    remoteUrl: string,
  ): Promise<ResolveGithubRepositoryResponse> {
    return credential.resolveRepository(this.#ctx, remoteUrl);
  }

  /* ---------------------------------------------------------------- issues */

  listIssues(input: {
    repository: GithubRepositoryRef;
    filter?: GithubIssueFilter;
    afterCursor?: string;
    limit?: number;
  }): Promise<ListGithubIssuesResponse> {
    return issues.listIssues(this.#ctx, input);
  }

  getIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GetGithubIssueResponse> {
    return issues.getIssue(this.#ctx, input);
  }

  createIssue(input: {
    repository: GithubRepositoryRef;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestoneNumber?: bigint;
  }): Promise<GithubIssue> {
    return issues.createIssue(this.#ctx, input);
  }

  /**
   * GitHub has no atomic version lock, so the caller passes the `updatedAt` it
   * displayed and the Host re-reads before writing.
   */
  updateIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    patch: GithubIssuePatch;
    expectedUpdatedAtUnixMs: bigint;
  }): Promise<GithubIssue> {
    return issues.updateIssue(this.#ctx, input);
  }

  /** Close and reopen. Moving to a Done group is a different call by design. */
  setIssueState(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    state: GithubIssueState;
    reason?: GithubIssueStateReason;
    expectedUpdatedAtUnixMs: bigint;
  }): Promise<GithubIssue> {
    return issues.setIssueState(this.#ctx, input);
  }

  commentIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    body: string;
  }): Promise<GithubComment> {
    return issues.commentIssue(this.#ctx, input);
  }

  /* ---------------------------------------------------------------- mapping */

  getStatusMapping(
    repository: GithubRepositoryRef,
  ): Promise<GithubStatusMapping> {
    return mapping.getStatusMapping(this.#ctx, repository);
  }

  putStatusMapping(input: {
    mapping: GithubStatusMapping;
    expectedRevision: bigint;
  }): Promise<GithubStatusMapping> {
    return mapping.putStatusMapping(this.#ctx, input);
  }

  /** Moves one Issue between configured groups; other labels are left alone. */
  moveIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    toGroupId: string;
    fromGroupId?: string;
    expectedUpdatedAtUnixMs: bigint;
    expectedMappingRevision: bigint;
  }): Promise<MoveGithubIssueResponse> {
    return mapping.moveIssue(this.#ctx, input);
  }

  /* ---------------------------------------------------------------- pulls */

  listPulls(input: {
    repository: GithubRepositoryRef;
    filter?: GithubPullFilter;
    afterCursor?: string;
    limit?: number;
  }): Promise<ListGithubPullsResponse> {
    return pulls.listPulls(this.#ctx, input);
  }

  getPull(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GetGithubPullResponse> {
    return pulls.getPull(this.#ctx, input);
  }

  createPull(input: {
    repository: GithubRepositoryRef;
    baseRef: string;
    headRef: string;
    title: string;
    body?: string;
    draft?: boolean;
    linkedIssueNumber?: bigint;
    expectedHeadSha?: string;
  }): Promise<GithubPullRequest> {
    return pulls.createPull(this.#ctx, input);
  }

  submitReview(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    commitSha: string;
    state: GithubReviewState;
    body?: string;
    comments?: GithubReviewCommentDraft[];
  }): Promise<GithubReview> {
    return pulls.submitReview(this.#ctx, input);
  }

  getChecks(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GithubCheckSummary> {
    return pulls.getChecks(this.#ctx, input);
  }

  /**
   * Merges under the exact head the panel displayed. Passing the rollup the
   * reader saw lets the Host refuse when checks changed underneath it; a green
   * screen locally is not a promise the remote will still accept the merge.
   */
  mergePull(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    expectedHeadSha: string;
    method: GithubMergeMethod;
    commitTitle?: string;
    commitMessage?: string;
    expectedCheckRollup?: GithubCheckConclusion;
  }): Promise<MergeGithubPullResponse> {
    return pulls.mergePull(this.#ctx, input);
  }

  /** Restarts the rerunnable checks for the head the panel displayed. */
  rerunChecks(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    expectedHeadSha: string;
    checkName?: string;
    failedOnly?: boolean;
  }): Promise<RerunGithubChecksResponse> {
    return pulls.rerunChecks(this.#ctx, input);
  }

  /**
   * Deletes one remote branch. Separate from merging on purpose: cleaning up
   * is the reader's decision, and it touches nothing local.
   */
  deleteBranch(input: {
    repository: GithubRepositoryRef;
    branch: string;
    expectedSha: string;
  }): Promise<DeleteGithubBranchResponse> {
    return pulls.deleteBranch(this.#ctx, input);
  }

  /* ---------------------------------------------------------------- references */

  linkReference(input: {
    reference: GithubExternalReference;
    expectedRevision: bigint;
  }): Promise<GithubExternalReference> {
    return references.linkReference(this.#ctx, input);
  }

  unlinkReference(input: {
    referenceId: string;
    expectedRevision: bigint;
  }): Promise<void> {
    return references.unlinkReference(this.#ctx, input);
  }

  listReferences(
    input: {
      targetId?: string;
      afterId?: string;
      limit?: number;
    } = {},
  ): Promise<ListGithubReferencesResponse> {
    return references.listReferences(this.#ctx, input);
  }
}
