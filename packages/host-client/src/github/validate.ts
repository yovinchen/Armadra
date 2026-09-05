import {
  GithubCredentialSource,
  type GithubCredentialStatus,
  type GithubExternalReference,
  type GithubIssue,
  type GithubPullRequest,
  type GithubRepositoryRef,
  type GithubStatusMapping,
} from "@armadra/protocol";

import { MAX_PAGE, reject } from "./errors.js";

export const idPattern = /^[0-9a-f]{32}$/;
export const scopedId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
/** Owner and repository name as GitHub itself constrains them. */
export const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function validRepository(
  value: GithubRepositoryRef | undefined,
): boolean {
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

export function requireRepository(
  value: GithubRepositoryRef,
): GithubRepositoryRef {
  if (!validRepository(value)) reject("invalid");
  return value;
}

export function requireNumber(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > 2_147_483_647n)
    reject("invalid");
  return value;
}

/** 40 hexadecimal characters, or the 64 of SHA-256 object names. */
export function requireSha(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value))
    reject("invalid");
  return value;
}

export function page(after: string, limit: number): { limit: number } {
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

/** A status that claims to be usable must name a source the panel can act on. */
export function checkCredential(
  value: GithubCredentialStatus,
): GithubCredentialStatus {
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

export function checkIssue(
  value: GithubIssue,
  repository: GithubRepositoryRef,
): GithubIssue {
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

export function checkPull(
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

export function checkMapping(value: GithubStatusMapping): GithubStatusMapping {
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

export function checkReference(
  workspaceId: string,
  value: GithubExternalReference,
): GithubExternalReference {
  if (
    !value.referenceId ||
    value.workspaceId !== workspaceId ||
    value.number <= 0n ||
    value.revision <= 0n ||
    !validRepository(value.repository)
  )
    reject("response");
  return value;
}
