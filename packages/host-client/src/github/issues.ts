import {
  CommentGithubIssueRequestSchema,
  CreateGithubIssueRequestSchema,
  GetGithubIssueRequestSchema,
  GetGithubIssueResponseSchema,
  GithubCommentSchema,
  GithubIssueSchema,
  ListGithubIssuesRequestSchema,
  ListGithubIssuesResponseSchema,
  SetGithubIssueStateRequestSchema,
  UpdateGithubIssueRequestSchema,
  create,
  fromBinary,
  toBinary,
  type GetGithubIssueResponse,
  type GithubComment,
  type GithubIssue,
  type GithubIssueFilter,
  type GithubIssuePatch,
  type GithubIssueState,
  type GithubIssueStateReason,
  type GithubRepositoryRef,
  type ListGithubIssuesResponse,
} from "@armadra/protocol";

import { type GithubCallContext } from "./context.js";
import { reject } from "./errors.js";
import {
  checkIssue,
  checkReference,
  page,
  requireNumber,
  requireRepository,
} from "./validate.js";

export function listIssues(
  ctx: GithubCallContext,
  input: {
    repository: GithubRepositoryRef;
    filter?: GithubIssueFilter;
    afterCursor?: string;
    limit?: number;
  },
): Promise<ListGithubIssuesResponse> {
  const repository = requireRepository(input?.repository);
  const afterCursor = input.afterCursor ?? "";
  const bounds = page(afterCursor, input.limit ?? 50);
  const request = create(ListGithubIssuesRequestSchema, {
    meta: ctx.meta(),
    repository,
    filter: input.filter,
    afterCursor,
    limit: bounds.limit,
  });
  return ctx.call(
    "ListIssues",
    toBinary(ListGithubIssuesRequestSchema, request),
    false,
    (wire) => {
      const value = fromBinary(ListGithubIssuesResponseSchema, wire);
      if (value.issues.length > bounds.limit) reject("response");
      for (const issue of value.issues) checkIssue(issue, repository);
      if (
        value.hasMore &&
        (!value.nextCursor || value.nextCursor === afterCursor)
      )
        reject("response");
      return value;
    },
  );
}

export function getIssue(
  ctx: GithubCallContext,
  input: {
    repository: GithubRepositoryRef;
    number: bigint;
  },
): Promise<GetGithubIssueResponse> {
  const repository = requireRepository(input?.repository);
  const request = create(GetGithubIssueRequestSchema, {
    meta: ctx.meta(),
    repository,
    number: requireNumber(input.number),
  });
  return ctx.call(
    "GetIssue",
    toBinary(GetGithubIssueRequestSchema, request),
    false,
    (wire) => {
      const value = fromBinary(GetGithubIssueResponseSchema, wire);
      if (!value.issue) reject("response");
      checkIssue(value.issue, repository);
      if (value.issue.number !== input.number) reject("response");
      for (const reference of value.references)
        checkReference(ctx.workspaceId, reference);
      return value;
    },
  );
}

export function createIssue(
  ctx: GithubCallContext,
  input: {
    repository: GithubRepositoryRef;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestoneNumber?: bigint;
  },
): Promise<GithubIssue> {
  const repository = requireRepository(input?.repository);
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 256
  )
    reject("invalid");
  const request = create(CreateGithubIssueRequestSchema, {
    meta: ctx.meta(),
    repository,
    title: input.title,
    body: input.body ?? "",
    labels: input.labels ?? [],
    assignees: input.assignees ?? [],
    milestoneNumber: input.milestoneNumber ?? 0n,
  });
  return ctx.call(
    "CreateIssue",
    toBinary(CreateGithubIssueRequestSchema, request),
    true,
    (wire) => checkIssue(fromBinary(GithubIssueSchema, wire), repository),
  );
}

/**
 * GitHub has no atomic version lock, so the caller passes the `updatedAt` it
 * displayed and the Host re-reads before writing.
 */
export function updateIssue(
  ctx: GithubCallContext,
  input: {
    repository: GithubRepositoryRef;
    number: bigint;
    patch: GithubIssuePatch;
    expectedUpdatedAtUnixMs: bigint;
  },
): Promise<GithubIssue> {
  const repository = requireRepository(input?.repository);
  if (
    !input.patch ||
    typeof input.expectedUpdatedAtUnixMs !== "bigint" ||
    input.expectedUpdatedAtUnixMs <= 0n
  )
    reject("invalid");
  const request = create(UpdateGithubIssueRequestSchema, {
    meta: ctx.meta(),
    repository,
    number: requireNumber(input.number),
    patch: input.patch,
    expectedUpdatedAtUnixMs: input.expectedUpdatedAtUnixMs,
  });
  return ctx.call(
    "UpdateIssue",
    toBinary(UpdateGithubIssueRequestSchema, request),
    true,
    (wire) => checkIssue(fromBinary(GithubIssueSchema, wire), repository),
  );
}

/** Close and reopen. Moving to a Done group is a different call by design. */
export function setIssueState(
  ctx: GithubCallContext,
  input: {
    repository: GithubRepositoryRef;
    number: bigint;
    state: GithubIssueState;
    reason?: GithubIssueStateReason;
    expectedUpdatedAtUnixMs: bigint;
  },
): Promise<GithubIssue> {
  const repository = requireRepository(input?.repository);
  if (
    typeof input.expectedUpdatedAtUnixMs !== "bigint" ||
    input.expectedUpdatedAtUnixMs <= 0n
  )
    reject("invalid");
  const request = create(SetGithubIssueStateRequestSchema, {
    meta: ctx.meta(),
    repository,
    number: requireNumber(input.number),
    state: input.state,
    reason: input.reason,
    expectedUpdatedAtUnixMs: input.expectedUpdatedAtUnixMs,
  });
  return ctx.call(
    "SetIssueState",
    toBinary(SetGithubIssueStateRequestSchema, request),
    true,
    (wire) => checkIssue(fromBinary(GithubIssueSchema, wire), repository),
  );
}

export function commentIssue(
  ctx: GithubCallContext,
  input: {
    repository: GithubRepositoryRef;
    number: bigint;
    body: string;
  },
): Promise<GithubComment> {
  const repository = requireRepository(input?.repository);
  if (
    typeof input.body !== "string" ||
    !input.body.trim() ||
    input.body.length > 65536
  )
    reject("invalid");
  const request = create(CommentGithubIssueRequestSchema, {
    meta: ctx.meta(),
    repository,
    number: requireNumber(input.number),
    body: input.body,
  });
  return ctx.call(
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
