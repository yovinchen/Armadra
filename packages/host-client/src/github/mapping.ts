import {
  GetGithubStatusMappingRequestSchema,
  GithubStatusMappingSchema,
  GithubStatusSource,
  MoveGithubIssueRequestSchema,
  MoveGithubIssueResponseSchema,
  PutGithubStatusMappingRequestSchema,
  create,
  fromBinary,
  toBinary,
  type GithubRepositoryRef,
  type GithubStatusMapping,
  type MoveGithubIssueResponse,
} from "@armadra/protocol";

import { type GithubCallContext } from "./context.js";
import { reject } from "./errors.js";
import {
  checkIssue,
  checkMapping,
  requireNumber,
  requireRepository,
  scopedId,
} from "./validate.js";

export function getStatusMapping(
  ctx: GithubCallContext,
  repository: GithubRepositoryRef,
): Promise<GithubStatusMapping> {
  const target = requireRepository(repository);
  const request = create(GetGithubStatusMappingRequestSchema, {
    meta: ctx.meta(),
    repository: target,
  });
  return ctx.call(
    "GetStatusMapping",
    toBinary(GetGithubStatusMappingRequestSchema, request),
    false,
    (wire) => checkMapping(fromBinary(GithubStatusMappingSchema, wire)),
  );
}

export function putStatusMapping(
  ctx: GithubCallContext,
  input: {
    mapping: GithubStatusMapping;
    expectedRevision: bigint;
  },
): Promise<GithubStatusMapping> {
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
    if (!scopedId.test(group.id ?? "") || ids.has(group.id)) reject("invalid");
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
    meta: ctx.meta(),
    mapping: input.mapping,
    expectedRevision: input.expectedRevision,
  });
  return ctx.call(
    "PutStatusMapping",
    toBinary(PutGithubStatusMappingRequestSchema, request),
    true,
    (wire) => checkMapping(fromBinary(GithubStatusMappingSchema, wire)),
  );
}

/** Moves one Issue between configured groups; other labels are left alone. */
export function moveIssue(
  ctx: GithubCallContext,
  input: {
    repository: GithubRepositoryRef;
    number: bigint;
    toGroupId: string;
    fromGroupId?: string;
    expectedUpdatedAtUnixMs: bigint;
    expectedMappingRevision: bigint;
  },
): Promise<MoveGithubIssueResponse> {
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
    meta: ctx.meta(),
    repository,
    number: requireNumber(input.number),
    toGroupId: input.toGroupId,
    fromGroupId: input.fromGroupId ?? "",
    expectedUpdatedAtUnixMs: input.expectedUpdatedAtUnixMs,
    expectedMappingRevision: input.expectedMappingRevision,
  });
  return ctx.call(
    "MoveIssue",
    toBinary(MoveGithubIssueRequestSchema, request),
    true,
    (wire) => {
      const value = fromBinary(MoveGithubIssueResponseSchema, wire);
      // Every move writes something; an outcome-free response would let the
      // panel show a silent success it has no evidence for.
      if (value.outcomes.length === 0) reject("response");
      if (value.issue) checkIssue(value.issue, repository);
      return value;
    },
  );
}
