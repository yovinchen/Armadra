import {
  GithubExternalReferenceSchema,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  LinkGithubReferenceRequestSchema,
  ListGithubReferencesRequestSchema,
  ListGithubReferencesResponseSchema,
  UnlinkGithubReferenceRequestSchema,
  UnlinkGithubReferenceResponseSchema,
  create,
  fromBinary,
  toBinary,
  type GithubExternalReference,
  type ListGithubReferencesResponse,
} from "@armadra/protocol";

import { type GithubCallContext } from "./context.js";
import { reject } from "./errors.js";
import {
  checkReference,
  page,
  requireNumber,
  requireRepository,
  scopedId,
} from "./validate.js";

export function linkReference(
  ctx: GithubCallContext,
  input: {
    reference: GithubExternalReference;
    expectedRevision: bigint;
  },
): Promise<GithubExternalReference> {
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
    meta: ctx.meta(),
    reference: { ...reference, workspaceId: ctx.workspaceId },
    expectedRevision: input.expectedRevision,
  });
  return ctx.call(
    "LinkReference",
    toBinary(LinkGithubReferenceRequestSchema, request),
    true,
    (wire) =>
      checkReference(
        ctx.workspaceId,
        fromBinary(GithubExternalReferenceSchema, wire),
      ),
  );
}

export function unlinkReference(
  ctx: GithubCallContext,
  input: {
    referenceId: string;
    expectedRevision: bigint;
  },
): Promise<void> {
  if (
    !scopedId.test(input?.referenceId ?? "") ||
    typeof input.expectedRevision !== "bigint" ||
    input.expectedRevision <= 0n
  )
    reject("invalid");
  const request = create(UnlinkGithubReferenceRequestSchema, {
    meta: ctx.meta(),
    referenceId: input.referenceId,
    expectedRevision: input.expectedRevision,
  });
  return ctx.call(
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

export function listReferences(
  ctx: GithubCallContext,
  input: {
    targetId?: string;
    afterId?: string;
    limit?: number;
  } = {},
): Promise<ListGithubReferencesResponse> {
  const afterId = input.afterId ?? "";
  const bounds = page(afterId, input.limit ?? 50);
  const request = create(ListGithubReferencesRequestSchema, {
    meta: ctx.meta(),
    targetId: input.targetId ?? "",
    afterId,
    limit: bounds.limit,
  });
  return ctx.call(
    "ListReferences",
    toBinary(ListGithubReferencesRequestSchema, request),
    false,
    (wire) => {
      const value = fromBinary(ListGithubReferencesResponseSchema, wire);
      if (value.references.length > bounds.limit) reject("response");
      for (const reference of value.references)
        checkReference(ctx.workspaceId, reference);
      if (value.hasMore && (!value.nextId || value.nextId === afterId))
        reject("response");
      return value;
    },
  );
}
