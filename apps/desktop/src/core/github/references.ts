/**
 * 外部连接：把一条 Issue 或 PR 连到一个本地会话、分支或 worktree（设计 §7.1）。
 * 移植自 `apps/host/internal/githubhost/references.go`。
 *
 * 一条连接是一个徽标和一条回去的路——它从不把一个会话变成一个 GitHub 对象，取消
 * 连接也从不碰两边任何一边。
 */

import {
  GithubExternalReferenceSchema,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubRepositoryRefSchema,
  ListGithubReferencesResponseSchema,
  UnlinkGithubReferenceResponseSchema,
  create,
  type GithubCredentialStatus,
  type GithubExternalReference,
  type GithubRepositoryRef,
  type ConfigureGithubCredentialRequest,
  type LinkGithubReferenceRequest,
  type ListGithubReferencesRequest,
  type ListGithubReferencesResponse,
  type RevokeGithubCredentialRequest,
  type UnlinkGithubReferenceRequest,
  type UnlinkGithubReferenceResponse,
} from "@armadra/protocol";

import { githubError } from "./errors";
import {
  MAX_PAGE_LIMIT,
  SCOPE_READ,
  SCOPE_WRITE,
  key,
  pageLimit,
  referenceId,
  type Caller,
  type GithubService,
} from "./service";
import {
  GITHUB_REFERENCE_ISSUE,
  GITHUB_REFERENCE_PULL,
  GITHUB_TARGET_BRANCH,
  GITHUB_TARGET_SESSION,
  GITHUB_TARGET_WORKTREE,
  type GithubReferenceRecord,
} from "./store";

function referenceKind(value: number): GithubReferenceKind {
  return value === GITHUB_REFERENCE_PULL
    ? GithubReferenceKind.PULL_REQUEST
    : GithubReferenceKind.ISSUE;
}

function referenceKindValue(kind: GithubReferenceKind): number {
  if (kind === GithubReferenceKind.ISSUE) return GITHUB_REFERENCE_ISSUE;
  if (kind === GithubReferenceKind.PULL_REQUEST) return GITHUB_REFERENCE_PULL;
  throw githubError("invalid");
}

function targetKind(value: number): GithubReferenceTargetKind {
  if (value === GITHUB_TARGET_BRANCH) return GithubReferenceTargetKind.BRANCH;
  if (value === GITHUB_TARGET_WORKTREE) {
    return GithubReferenceTargetKind.WORKTREE;
  }
  return GithubReferenceTargetKind.SESSION;
}

function targetKindValue(kind: GithubReferenceTargetKind): number {
  switch (kind) {
    case GithubReferenceTargetKind.SESSION:
      return GITHUB_TARGET_SESSION;
    case GithubReferenceTargetKind.BRANCH:
      return GITHUB_TARGET_BRANCH;
    case GithubReferenceTargetKind.WORKTREE:
      return GITHUB_TARGET_WORKTREE;
    default:
      throw githubError("invalid");
  }
}

export function referenceMessage(
  record: GithubReferenceRecord,
): GithubExternalReference {
  return create(GithubExternalReferenceSchema, {
    referenceId: record.referenceId,
    workspaceId: record.workspaceId,
    repository: create(GithubRepositoryRefSchema, {
      owner: record.repository.owner,
      name: record.repository.name,
      apiBase: record.repository.apiBase,
      host: record.repository.webHost,
    }),
    kind: referenceKind(record.kind),
    number: BigInt(record.number),
    targetKind: targetKind(record.targetKind),
    targetId: record.targetId,
    title: record.title,
    revision: BigInt(record.revision),
    createdAtUnixMs: BigInt(record.createdAtMs),
    updatedAtUnixMs: BigInt(record.updatedAtMs),
  });
}

/**
 * 收集指向一个远端对象的连接，这样详情视图可以显示哪些本地会话或 worktree 正在
 * 做它。
 */
export function referencesFor(
  service: GithubService,
  workspaceId: string,
  ref: GithubRepositoryRef,
  kind: GithubReferenceKind,
  number: bigint,
): GithubExternalReference[] {
  const records = service.store.references(workspaceId, "", "", MAX_PAGE_LIMIT);
  const result: GithubExternalReference[] = [];
  for (const record of records) {
    if (
      BigInt(record.number) !== number ||
      referenceKind(record.kind) !== kind
    ) {
      continue;
    }
    if (
      record.repository.owner !== ref.owner ||
      record.repository.name !== ref.name ||
      record.repository.apiBase !== ref.apiBase
    ) {
      continue;
    }
    result.push(referenceMessage(record));
  }
  return result;
}

/**
 * 记下一条连接。它的标识由这条连接的含义导出，所以把同一个 Issue 连到同一个目标
 * 两次是同一条记录，而不是一个节点上的两个徽标。
 */
export function linkReference(
  service: GithubService,
  caller: Caller,
  request: LinkGithubReferenceRequest,
): GithubExternalReference {
  service.authorize(caller, SCOPE_WRITE);
  const reference = request.reference;
  if (reference === undefined) throw githubError("invalid");
  const ref = service.repository(reference.repository);
  const kind = referenceKindValue(reference.kind);
  const target = targetKindValue(reference.targetKind);
  const id = reference.targetId.trim();
  if (
    id === "" ||
    id.length > 512 ||
    reference.number <= 0n ||
    reference.title.length > 1024
  ) {
    throw githubError("invalid");
  }
  const now = service.now();
  const stored = service.store.putReference(
    {
      referenceId: referenceId(
        caller.workspaceId,
        ref,
        reference.kind,
        reference.number,
        reference.targetKind,
        id,
      ),
      workspaceId: caller.workspaceId,
      repository: key(ref),
      kind,
      number: Number(reference.number),
      targetKind: target,
      targetId: id,
      title: reference.title,
      revision: 0,
      createdAtMs: now,
      updatedAtMs: now,
    },
    Number(request.expectedRevision),
  );
  return referenceMessage(stored);
}

/**
 * 只删掉一条连接。它指着的远端对象和本地会话都原封不动。
 */
export function unlinkReference(
  service: GithubService,
  caller: Caller,
  request: UnlinkGithubReferenceRequest,
): UnlinkGithubReferenceResponse {
  service.authorize(caller, SCOPE_WRITE);
  const id = request.referenceId;
  if (id === "" || id.length > 256 || request.expectedRevision === 0n) {
    throw githubError("invalid");
  }
  service.store.deleteReference(
    caller.workspaceId,
    id,
    Number(request.expectedRevision),
  );
  return create(UnlinkGithubReferenceResponseSchema, {
    referenceId: id,
    unlinked: true,
  });
}

/**
 * 列这个工作空间的连接，可以只看一个目标。空目标列整个工作空间；它从来不是一次
 * 隐式匹配。
 */
export function listReferences(
  service: GithubService,
  caller: Caller,
  request: ListGithubReferencesRequest,
): ListGithubReferencesResponse {
  service.authorize(caller, SCOPE_READ);
  const limit = pageLimit(Number(request.limit));
  const records = service.store.references(
    caller.workspaceId,
    request.targetId,
    request.afterId,
    limit + 1,
  );
  const result = create(ListGithubReferencesResponseSchema, {});
  for (const [index, record] of records.entries()) {
    if (index === limit) {
      result.hasMore = true;
      break;
    }
    result.references.push(referenceMessage(record));
    result.nextId = record.referenceId;
  }
  return result;
}

/* -------------------------------- 凭据包装 -------------------------------- */
//
// 它们返回的状态**永远不含令牌**；只有一次 configure 请求带着令牌，而且是入站的。

export async function getCredential(
  service: GithubService,
  caller: Caller,
): Promise<GithubCredentialStatus> {
  service.authorize(caller, SCOPE_READ);
  return service.credentials.status();
}

/**
 * `ConfigureCredential` 同时要求 `github:write` **和** settings 权限：选择这台
 * 机器的 GitHub 令牌从哪来是一次设置变更，不是一次普通的 Issue 编辑。
 */
export async function configureCredential(
  service: GithubService,
  caller: Caller,
  request: ConfigureGithubCredentialRequest,
): Promise<GithubCredentialStatus> {
  service.authorize(caller, SCOPE_WRITE);
  service.authorize(caller, "settings:write");
  return service.credentials.configure(
    request.source,
    request.token,
    request.apiBase,
    Number(request.expectedRevision),
  );
}

export async function revokeCredential(
  service: GithubService,
  caller: Caller,
  request: RevokeGithubCredentialRequest,
): Promise<GithubCredentialStatus> {
  service.authorize(caller, SCOPE_WRITE);
  service.authorize(caller, "settings:write");
  return service.credentials.revoke(Number(request.expectedRevision));
}
