import {
  create,
  fromBinary,
  toBinary,
  CommentGithubIssueRequestSchema,
  ConfigureGithubCredentialRequestSchema,
  CreateGithubIssueRequestSchema,
  CreateGithubPullRequestSchema,
  GetGithubChecksRequestSchema,
  GetGithubCredentialRequestSchema,
  GetGithubIssueRequestSchema,
  GetGithubIssueResponseSchema,
  GetGithubPullRequestSchema,
  GetGithubPullResponseSchema,
  GetGithubStatusMappingRequestSchema,
  GithubCheckSummarySchema,
  GithubCommentSchema,
  GithubCredentialSource,
  GithubCredentialStatusSchema,
  GithubExternalReferenceSchema,
  GithubIssueSchema,
  GithubMergeMethod,
  GithubPullRequestSchema,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubReviewSchema,
  GithubReviewState,
  GithubStatusMappingSchema,
  GithubStatusSource,
  LinkGithubReferenceRequestSchema,
  ListGithubIssuesRequestSchema,
  ListGithubIssuesResponseSchema,
  ListGithubPullsRequestSchema,
  ListGithubPullsResponseSchema,
  ListGithubReferencesRequestSchema,
  ListGithubReferencesResponseSchema,
  MergeGithubPullRequestSchema,
  MergeGithubPullResponseSchema,
  MoveGithubIssueRequestSchema,
  MoveGithubIssueResponseSchema,
  PutGithubStatusMappingRequestSchema,
  ResolveGithubRepositoryRequestSchema,
  ResolveGithubRepositoryResponseSchema,
  RevokeGithubCredentialRequestSchema,
  SetGithubIssueStateRequestSchema,
  SubmitGithubReviewRequestSchema,
  UnlinkGithubReferenceRequestSchema,
  UnlinkGithubReferenceResponseSchema,
  UpdateGithubIssueRequestSchema,
  type GetGithubIssueResponse,
  type GetGithubPullResponse,
  type GithubCheckSummary,
  type GithubComment,
  type GithubCredentialStatus,
  type GithubExternalReference,
  type GithubIssue,
  type GithubIssueFilter,
  type GithubIssuePatch,
  type GithubIssueState,
  type GithubIssueStateReason,
  type GithubPullFilter,
  type GithubPullRequest,
  type GithubRepositoryRef,
  type GithubReview,
  type GithubReviewCommentDraft,
  type GithubStatusMapping,
  type ListGithubIssuesResponse,
  type ListGithubPullsResponse,
  type ListGithubReferencesResponse,
  type MergeGithubPullResponse,
  type MoveGithubIssueResponse,
  type ResolveGithubRepositoryResponse,
  type GithubCheckConclusion,
} from "@armadra/protocol";
import { HostIdentityError } from "./identity.js";
import type { HostAuthenticatedTransport } from "./automation.js";

export type {
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

const SERVICE = "GithubService";
/** A page has to fit the Host frame budget with room for long Issue bodies. */
const MAX_PAGE = 100;

/**
 * What went wrong, in terms the panel can act on. `rateLimited` is separate
 * from `network` because waiting is the repair, and `unsupported` is separate
 * from `permission` because one is "this Host has no GitHub credential" and the
 * other is "this device may not use it".
 */
export type HostGithubFailure =
  | "invalid"
  | "unauthenticated"
  | "permission"
  | "unsupported"
  | "notFound"
  | "conflict"
  | "rateLimited"
  | "response"
  | "cancelled"
  | "network";

/** Carries only stable metadata; never a response body, token or URL. */
export class HostGithubError extends Error {
  readonly name = "HostGithubError";
  constructor(
    readonly failure: HostGithubFailure,
    /** A mutation that reached the Host but whose result was never read. */
    readonly outcomeUnknown = false,
    readonly httpStatus?: number,
    readonly hostCode?: string,
  ) {
    super(`Host GitHub request failed (${failure}).`);
  }
}

function reject(failure: HostGithubFailure): never {
  throw new HostGithubError(failure);
}

/**
 * Maps a transport failure onto a repair. An unrecognised remote code stays
 * `network` rather than being softened into `invalid`: a write whose outcome
 * was not read must make the caller reload, not retry.
 */
export function classifyGithubFailure(error: unknown): HostGithubError {
  if (error instanceof HostGithubError) return error;
  if (!(error instanceof HostIdentityError))
    return new HostGithubError("network");
  const { code, hostCode, httpStatus, outcomeUnknown } = error;
  const fail = (failure: HostGithubFailure) =>
    new HostGithubError(failure, outcomeUnknown, httpStatus, hostCode);
  if (code === "CANCELLED" || code === "TIMEOUT") return fail("cancelled");
  if (code === "INVALID_OPTIONS") return fail("invalid");
  if (
    code === "MALFORMED_RESPONSE" ||
    code === "RESPONSE_TOO_LARGE" ||
    code === "UNEXPECTED_CONTENT_TYPE"
  )
    return fail("response");
  if (code !== "REMOTE_ERROR") return fail("network");
  switch (hostCode) {
    case "UNAUTHENTICATED":
      return fail("unauthenticated");
    case "PERMISSION_DENIED":
      return fail("permission");
    case "UNSUPPORTED":
      return fail("unsupported");
    case "NOT_FOUND":
      return fail("notFound");
    case "CONFLICT":
      return fail("conflict");
    case "RESOURCE_EXHAUSTED":
      return fail("rateLimited");
    case "INVALID_ARGUMENT":
      return fail("invalid");
    default:
      return fail("network");
  }
}

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `github-${Date.now().toString(36)}-${counter}`;
}

const idPattern = /^[0-9a-f]{32}$/;
const scopedId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
/** Owner and repository name as GitHub itself constrains them. */
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function validRepository(value: GithubRepositoryRef | undefined): boolean {
  if (!value) return false;
  if (!namePattern.test(value.owner) || !namePattern.test(value.name))
    return false;
  if (!value.apiBase || !value.host) return false;
  let url: URL;
  try {
    url = new URL(value.apiBase);
  } catch {
    return false;
  }
  // An http API base would send the token in clear text, so it is refused here
  // as well as on the Host rather than trusted to be loopback.
  return url.protocol === "https:" && !url.username && !url.password;
}

function requireRepository(value: GithubRepositoryRef): GithubRepositoryRef {
  if (!validRepository(value)) reject("invalid");
  return value;
}

function requireNumber(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > 2_147_483_647n)
    reject("invalid");
  return value;
}

/** 40 hexadecimal characters, or the 64 of SHA-256 object names. */
function requireSha(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value))
    reject("invalid");
  return value;
}

function page(after: string, limit: number): { limit: number } {
  if (
    typeof after !== "string" ||
    after.length > 512 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE
  )
    reject("invalid");
  return { limit };
}

export interface HostGithubClientOptions {
  session: HostAuthenticatedTransport;
  hostId: string;
  workspaceId: string;
}

/**
 * Typed access to the Host's authenticated GitHub surface.
 *
 * The session supplies principal, device and grants, so nothing here carries
 * identity, and no method ever sees a token: the Host holds the credential and
 * this client only names the repository to act on. Responses are validated
 * before they reach the UI — a half-decoded pull request rendered next to a
 * merge button would be claiming the Host said something it did not.
 */
export class HostGithubClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;
  readonly #workspaceId: string;

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
    const request = create(GetGithubCredentialRequestSchema, {
      meta: this.#meta(),
    });
    return this.#call(
      "GetCredential",
      toBinary(GetGithubCredentialRequestSchema, request),
      false,
      (wire) =>
        this.#credential(fromBinary(GithubCredentialStatusSchema, wire)),
    );
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
    const token = input?.token ?? "";
    const needsToken =
      input?.source === GithubCredentialSource.TOKEN_REF && token.length > 0;
    if (
      !input ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision < 0n ||
      typeof token !== "string" ||
      token.length > 4096 ||
      (input.source === GithubCredentialSource.TOKEN_REF && !needsToken) ||
      (input.source !== GithubCredentialSource.TOKEN_REF && token.length > 0)
    )
      reject("invalid");
    const apiBase = input.apiBase ?? "";
    if (apiBase) {
      let url: URL;
      try {
        url = new URL(apiBase);
      } catch {
        return Promise.reject(new HostGithubError("invalid"));
      }
      if (url.protocol !== "https:" || url.username || url.password)
        reject("invalid");
    }
    const request = create(ConfigureGithubCredentialRequestSchema, {
      meta: this.#meta(),
      source: input.source,
      token,
      apiBase,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "ConfigureCredential",
      toBinary(ConfigureGithubCredentialRequestSchema, request),
      true,
      (wire) =>
        this.#credential(fromBinary(GithubCredentialStatusSchema, wire)),
    );
  }

  revokeCredential(input: {
    expectedRevision: bigint;
  }): Promise<GithubCredentialStatus> {
    if (
      typeof input?.expectedRevision !== "bigint" ||
      input.expectedRevision <= 0n
    )
      reject("invalid");
    const request = create(RevokeGithubCredentialRequestSchema, {
      meta: this.#meta(),
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "RevokeCredential",
      toBinary(RevokeGithubCredentialRequestSchema, request),
      true,
      (wire) =>
        this.#credential(fromBinary(GithubCredentialStatusSchema, wire)),
    );
  }

  /* ---------------------------------------------------------------- repository */

  resolveRepository(
    remoteUrl: string,
  ): Promise<ResolveGithubRepositoryResponse> {
    if (
      typeof remoteUrl !== "string" ||
      !remoteUrl.trim() ||
      remoteUrl.length > 2048
    )
      reject("invalid");
    const request = create(ResolveGithubRepositoryRequestSchema, {
      meta: this.#meta(),
      remoteUrl,
    });
    return this.#call(
      "ResolveRepository",
      toBinary(ResolveGithubRepositoryRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ResolveGithubRepositoryResponseSchema, wire);
        // A mismatch is an answer, not a repository: it must not arrive with
        // one, or the panel would show an enterprise repo it never resolved.
        if (value.hostMismatch) {
          if (value.repository) reject("response");
          return value;
        }
        if (!validRepository(value.repository?.ref)) reject("response");
        return value;
      },
    );
  }

  /* ---------------------------------------------------------------- issues */

  listIssues(input: {
    repository: GithubRepositoryRef;
    filter?: GithubIssueFilter;
    afterCursor?: string;
    limit?: number;
  }): Promise<ListGithubIssuesResponse> {
    const repository = requireRepository(input?.repository);
    const afterCursor = input.afterCursor ?? "";
    const bounds = page(afterCursor, input.limit ?? 50);
    const request = create(ListGithubIssuesRequestSchema, {
      meta: this.#meta(),
      repository,
      filter: input.filter,
      afterCursor,
      limit: bounds.limit,
    });
    return this.#call(
      "ListIssues",
      toBinary(ListGithubIssuesRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListGithubIssuesResponseSchema, wire);
        if (value.issues.length > bounds.limit) reject("response");
        for (const issue of value.issues) this.#issue(issue, repository);
        if (
          value.hasMore &&
          (!value.nextCursor || value.nextCursor === afterCursor)
        )
          reject("response");
        return value;
      },
    );
  }

  getIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GetGithubIssueResponse> {
    const repository = requireRepository(input?.repository);
    const request = create(GetGithubIssueRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
    });
    return this.#call(
      "GetIssue",
      toBinary(GetGithubIssueRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(GetGithubIssueResponseSchema, wire);
        if (!value.issue) reject("response");
        this.#issue(value.issue, repository);
        if (value.issue.number !== input.number) reject("response");
        for (const reference of value.references) this.#reference(reference);
        return value;
      },
    );
  }

  createIssue(input: {
    repository: GithubRepositoryRef;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestoneNumber?: bigint;
  }): Promise<GithubIssue> {
    const repository = requireRepository(input?.repository);
    if (
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 256
    )
      reject("invalid");
    const request = create(CreateGithubIssueRequestSchema, {
      meta: this.#meta(),
      repository,
      title: input.title,
      body: input.body ?? "",
      labels: input.labels ?? [],
      assignees: input.assignees ?? [],
      milestoneNumber: input.milestoneNumber ?? 0n,
    });
    return this.#call(
      "CreateIssue",
      toBinary(CreateGithubIssueRequestSchema, request),
      true,
      (wire) => this.#issue(fromBinary(GithubIssueSchema, wire), repository),
    );
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
    const repository = requireRepository(input?.repository);
    if (
      !input.patch ||
      typeof input.expectedUpdatedAtUnixMs !== "bigint" ||
      input.expectedUpdatedAtUnixMs <= 0n
    )
      reject("invalid");
    const request = create(UpdateGithubIssueRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
      patch: input.patch,
      expectedUpdatedAtUnixMs: input.expectedUpdatedAtUnixMs,
    });
    return this.#call(
      "UpdateIssue",
      toBinary(UpdateGithubIssueRequestSchema, request),
      true,
      (wire) => this.#issue(fromBinary(GithubIssueSchema, wire), repository),
    );
  }

  /** Close and reopen. Moving to a Done group is a different call by design. */
  setIssueState(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    state: GithubIssueState;
    reason?: GithubIssueStateReason;
    expectedUpdatedAtUnixMs: bigint;
  }): Promise<GithubIssue> {
    const repository = requireRepository(input?.repository);
    if (
      typeof input.expectedUpdatedAtUnixMs !== "bigint" ||
      input.expectedUpdatedAtUnixMs <= 0n
    )
      reject("invalid");
    const request = create(SetGithubIssueStateRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
      state: input.state,
      reason: input.reason,
      expectedUpdatedAtUnixMs: input.expectedUpdatedAtUnixMs,
    });
    return this.#call(
      "SetIssueState",
      toBinary(SetGithubIssueStateRequestSchema, request),
      true,
      (wire) => this.#issue(fromBinary(GithubIssueSchema, wire), repository),
    );
  }

  commentIssue(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    body: string;
  }): Promise<GithubComment> {
    const repository = requireRepository(input?.repository);
    if (
      typeof input.body !== "string" ||
      !input.body.trim() ||
      input.body.length > 65536
    )
      reject("invalid");
    const request = create(CommentGithubIssueRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
      body: input.body,
    });
    return this.#call(
      "CommentIssue",
      toBinary(CommentGithubIssueRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(GithubCommentSchema, wire);
        if (value.id <= 0n) reject("response");
        return value;
      },
    );
  }

  /* ---------------------------------------------------------------- mapping */

  getStatusMapping(
    repository: GithubRepositoryRef,
  ): Promise<GithubStatusMapping> {
    const target = requireRepository(repository);
    const request = create(GetGithubStatusMappingRequestSchema, {
      meta: this.#meta(),
      repository: target,
    });
    return this.#call(
      "GetStatusMapping",
      toBinary(GetGithubStatusMappingRequestSchema, request),
      false,
      (wire) => this.#mapping(fromBinary(GithubStatusMappingSchema, wire)),
    );
  }

  putStatusMapping(input: {
    mapping: GithubStatusMapping;
    expectedRevision: bigint;
  }): Promise<GithubStatusMapping> {
    if (
      !input?.mapping ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision < 0n
    )
      reject("invalid");
    requireRepository(input.mapping.repository!);
    // A mapping whose groups collide would make an Issue's group ambiguous, so
    // it is refused here rather than turned into a conflict badge later.
    const ids = new Set<string>();
    const labels = new Set<string>();
    const options = new Set<string>();
    for (const group of input.mapping.groups) {
      if (!scopedId.test(group.id ?? "") || ids.has(group.id))
        reject("invalid");
      ids.add(group.id);
      if (input.mapping.source === GithubStatusSource.LABEL) {
        if (!group.label || labels.has(group.label)) reject("invalid");
        labels.add(group.label);
      }
      if (input.mapping.source === GithubStatusSource.PROJECT_FIELD) {
        if (!group.projectOptionId || options.has(group.projectOptionId))
          reject("invalid");
        options.add(group.projectOptionId);
      }
    }
    for (const coupling of input.mapping.stateGroups)
      if (!ids.has(coupling.groupId)) reject("invalid");
    const request = create(PutGithubStatusMappingRequestSchema, {
      meta: this.#meta(),
      mapping: input.mapping,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "PutStatusMapping",
      toBinary(PutGithubStatusMappingRequestSchema, request),
      true,
      (wire) => this.#mapping(fromBinary(GithubStatusMappingSchema, wire)),
    );
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
    const repository = requireRepository(input?.repository);
    if (
      !scopedId.test(input.toGroupId ?? "") ||
      typeof input.expectedUpdatedAtUnixMs !== "bigint" ||
      input.expectedUpdatedAtUnixMs <= 0n ||
      typeof input.expectedMappingRevision !== "bigint" ||
      input.expectedMappingRevision <= 0n
    )
      reject("invalid");
    const request = create(MoveGithubIssueRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
      toGroupId: input.toGroupId,
      fromGroupId: input.fromGroupId ?? "",
      expectedUpdatedAtUnixMs: input.expectedUpdatedAtUnixMs,
      expectedMappingRevision: input.expectedMappingRevision,
    });
    return this.#call(
      "MoveIssue",
      toBinary(MoveGithubIssueRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(MoveGithubIssueResponseSchema, wire);
        // Every move writes something; an outcome-free response would let the
        // panel show a silent success it has no evidence for.
        if (value.outcomes.length === 0) reject("response");
        if (value.issue) this.#issue(value.issue, repository);
        return value;
      },
    );
  }

  /* ---------------------------------------------------------------- pulls */

  listPulls(input: {
    repository: GithubRepositoryRef;
    filter?: GithubPullFilter;
    afterCursor?: string;
    limit?: number;
  }): Promise<ListGithubPullsResponse> {
    const repository = requireRepository(input?.repository);
    const afterCursor = input.afterCursor ?? "";
    const bounds = page(afterCursor, input.limit ?? 50);
    const request = create(ListGithubPullsRequestSchema, {
      meta: this.#meta(),
      repository,
      filter: input.filter,
      afterCursor,
      limit: bounds.limit,
    });
    return this.#call(
      "ListPulls",
      toBinary(ListGithubPullsRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListGithubPullsResponseSchema, wire);
        if (value.pulls.length > bounds.limit) reject("response");
        for (const pull of value.pulls) this.#pull(pull, repository);
        if (
          value.hasMore &&
          (!value.nextCursor || value.nextCursor === afterCursor)
        )
          reject("response");
        return value;
      },
    );
  }

  getPull(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GetGithubPullResponse> {
    const repository = requireRepository(input?.repository);
    const request = create(GetGithubPullRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
    });
    return this.#call(
      "GetPull",
      toBinary(GetGithubPullRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(GetGithubPullResponseSchema, wire);
        if (!value.pull) reject("response");
        this.#pull(value.pull, repository);
        if (value.pull.number !== input.number) reject("response");
        // Checks for a different commit answer a question nobody asked, and
        // would sit next to a merge button as if they described this head.
        if (value.checks && value.checks.headSha !== value.pull.headSha)
          reject("response");
        for (const reference of value.references) this.#reference(reference);
        return value;
      },
    );
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
    const repository = requireRepository(input?.repository);
    const ref = (value: string) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      !/[ - ~^:?*[\\]/.test(value) &&
      !value.includes("..") &&
      !value.startsWith("-");
    if (
      !ref(input.baseRef) ||
      !ref(input.headRef) ||
      input.baseRef === input.headRef
    )
      reject("invalid");
    if (
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 256
    )
      reject("invalid");
    const request = create(CreateGithubPullRequestSchema, {
      meta: this.#meta(),
      repository,
      baseRef: input.baseRef,
      headRef: input.headRef,
      title: input.title,
      body: input.body ?? "",
      draft: input.draft ?? false,
      linkedIssueNumber: input.linkedIssueNumber ?? 0n,
      expectedHeadSha: input.expectedHeadSha
        ? requireSha(input.expectedHeadSha)
        : "",
    });
    return this.#call(
      "CreatePull",
      toBinary(CreateGithubPullRequestSchema, request),
      true,
      (wire) =>
        this.#pull(fromBinary(GithubPullRequestSchema, wire), repository),
    );
  }

  submitReview(input: {
    repository: GithubRepositoryRef;
    number: bigint;
    commitSha: string;
    state: GithubReviewState;
    body?: string;
    comments?: GithubReviewCommentDraft[];
  }): Promise<GithubReview> {
    const repository = requireRepository(input?.repository);
    const state = input.state;
    if (
      state !== GithubReviewState.APPROVED &&
      state !== GithubReviewState.CHANGES_REQUESTED &&
      state !== GithubReviewState.COMMENTED
    )
      reject("invalid");
    const body = input.body ?? "";
    const comments = input.comments ?? [];
    // GitHub refuses an empty "request changes"; refusing here keeps the panel
    // from reporting a review it never submitted.
    if (state === GithubReviewState.CHANGES_REQUESTED && !body.trim())
      reject("invalid");
    if (body.length > 65536 || comments.length > 200) reject("invalid");
    for (const comment of comments)
      if (
        !comment.path ||
        comment.path.length > 4096 ||
        comment.line <= 0n ||
        !comment.body.trim() ||
        (comment.side !== "LEFT" && comment.side !== "RIGHT")
      )
        reject("invalid");
    const request = create(SubmitGithubReviewRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
      commitSha: requireSha(input.commitSha),
      state,
      body,
      comments,
    });
    return this.#call(
      "SubmitReview",
      toBinary(SubmitGithubReviewRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(GithubReviewSchema, wire);
        if (value.id <= 0n) reject("response");
        return value;
      },
    );
  }

  getChecks(input: {
    repository: GithubRepositoryRef;
    number: bigint;
  }): Promise<GithubCheckSummary> {
    const repository = requireRepository(input?.repository);
    const request = create(GetGithubChecksRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
    });
    return this.#call(
      "GetChecks",
      toBinary(GetGithubChecksRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(GithubCheckSummarySchema, wire);
        requireSha(value.headSha);
        return value;
      },
    );
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
    const repository = requireRepository(input?.repository);
    if (
      input.method !== GithubMergeMethod.MERGE &&
      input.method !== GithubMergeMethod.SQUASH &&
      input.method !== GithubMergeMethod.REBASE
    )
      reject("invalid");
    const request = create(MergeGithubPullRequestSchema, {
      meta: this.#meta(),
      repository,
      number: requireNumber(input.number),
      expectedHeadSha: requireSha(input.expectedHeadSha),
      method: input.method,
      commitTitle: input.commitTitle ?? "",
      commitMessage: input.commitMessage ?? "",
      expectedCheckRollup: input.expectedCheckRollup,
    });
    return this.#call(
      "MergePull",
      toBinary(MergeGithubPullRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(MergeGithubPullResponseSchema, wire);
        // "Not merged" must always say why, and a merge must produce a commit;
        // otherwise the panel cannot tell a refusal from a lost result.
        if (value.merged) {
          if (!value.mergeSha) reject("response");
        } else if (!value.reasonCode) reject("response");
        return value;
      },
    );
  }

  /* ---------------------------------------------------------------- references */

  linkReference(input: {
    reference: GithubExternalReference;
    expectedRevision: bigint;
  }): Promise<GithubExternalReference> {
    const reference = input?.reference;
    if (
      !reference ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision < 0n
    )
      reject("invalid");
    requireRepository(reference.repository!);
    requireNumber(reference.number);
    if (
      reference.kind !== GithubReferenceKind.ISSUE &&
      reference.kind !== GithubReferenceKind.PULL_REQUEST
    )
      reject("invalid");
    if (
      reference.targetKind !== GithubReferenceTargetKind.SESSION &&
      reference.targetKind !== GithubReferenceTargetKind.BRANCH &&
      reference.targetKind !== GithubReferenceTargetKind.WORKTREE
    )
      reject("invalid");
    if (!reference.targetId.trim() || reference.targetId.length > 512)
      reject("invalid");
    const request = create(LinkGithubReferenceRequestSchema, {
      meta: this.#meta(),
      reference: { ...reference, workspaceId: this.#workspaceId },
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "LinkReference",
      toBinary(LinkGithubReferenceRequestSchema, request),
      true,
      (wire) =>
        this.#reference(fromBinary(GithubExternalReferenceSchema, wire)),
    );
  }

  unlinkReference(input: {
    referenceId: string;
    expectedRevision: bigint;
  }): Promise<void> {
    if (
      !scopedId.test(input?.referenceId ?? "") ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision <= 0n
    )
      reject("invalid");
    const request = create(UnlinkGithubReferenceRequestSchema, {
      meta: this.#meta(),
      referenceId: input.referenceId,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "UnlinkReference",
      toBinary(UnlinkGithubReferenceRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(UnlinkGithubReferenceResponseSchema, wire);
        if (!value.unlinked || value.referenceId !== input.referenceId)
          reject("response");
      },
    );
  }

  listReferences(
    input: {
      targetId?: string;
      afterId?: string;
      limit?: number;
    } = {},
  ): Promise<ListGithubReferencesResponse> {
    const afterId = input.afterId ?? "";
    const bounds = page(afterId, input.limit ?? 50);
    const request = create(ListGithubReferencesRequestSchema, {
      meta: this.#meta(),
      targetId: input.targetId ?? "",
      afterId,
      limit: bounds.limit,
    });
    return this.#call(
      "ListReferences",
      toBinary(ListGithubReferencesRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListGithubReferencesResponseSchema, wire);
        if (value.references.length > bounds.limit) reject("response");
        for (const reference of value.references) this.#reference(reference);
        if (value.hasMore && (!value.nextId || value.nextId === afterId))
          reject("response");
        return value;
      },
    );
  }

  /* ---------------------------------------------------------------- validation */

  #credential(value: GithubCredentialStatus): GithubCredentialStatus {
    // A status that claims to be usable without an API base cannot be acted on,
    // and "available" with no source configured would be a contradiction.
    if (!value.apiBase) reject("response");
    if (
      value.available &&
      value.source !== GithubCredentialSource.GH_CLI &&
      value.source !== GithubCredentialSource.TOKEN_REF
    )
      reject("response");
    return value;
  }

  #issue(value: GithubIssue, repository: GithubRepositoryRef): GithubIssue {
    if (value.number <= 0n) reject("response");
    const seen = value.repository;
    // The Host must answer about the repository that was asked for; silently
    // rendering another one's Issues under this repository's tab is worse than
    // an error.
    if (
      !seen ||
      seen.owner !== repository.owner ||
      seen.name !== repository.name ||
      seen.apiBase !== repository.apiBase
    )
      reject("response");
    return value;
  }

  #pull(
    value: GithubPullRequest,
    repository: GithubRepositoryRef,
  ): GithubPullRequest {
    if (value.number <= 0n) reject("response");
    const seen = value.repository;
    if (
      !seen ||
      seen.owner !== repository.owner ||
      seen.name !== repository.name ||
      seen.apiBase !== repository.apiBase
    )
      reject("response");
    if (value.headSha) requireSha(value.headSha);
    return value;
  }

  #mapping(value: GithubStatusMapping): GithubStatusMapping {
    if (!validRepository(value.repository)) reject("response");
    const ids = new Set<string>();
    for (const group of value.groups) {
      if (!group.id || ids.has(group.id)) reject("response");
      ids.add(group.id);
    }
    for (const coupling of value.stateGroups)
      if (!ids.has(coupling.groupId)) reject("response");
    return value;
  }

  #reference(value: GithubExternalReference): GithubExternalReference {
    if (
      !value.referenceId ||
      value.workspaceId !== this.#workspaceId ||
      value.number <= 0n ||
      value.revision <= 0n ||
      !validRepository(value.repository)
    )
      reject("response");
    return value;
  }
}
