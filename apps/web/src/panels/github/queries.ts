import type { QueryClient } from "@tanstack/react-query";
import type {
  GithubIssue,
  GithubIssueFilter,
  GithubPullFilter,
  GithubPullRequest,
  GithubRateLimit,
  GithubRepositoryRef,
  HostGithubClient,
} from "@armadra/host-client";

/**
 * Query keys and paging for the GitHub page.
 *
 * Every key carries the workspace and the resolved repository, so switching
 * either one cannot show the previous repository's rows under the new title.
 * Paging stops at a fixed page count: a cursor the Host keeps repeating must
 * end the loop, not spin against the remote API.
 */

const MAX_PAGES = 10;
const PAGE = 100;

/** Identity of one repository, stable enough to key a cache on. */
export function repositoryKey(
  repository: GithubRepositoryRef | undefined,
): string {
  if (!repository) return "";
  return `${repository.apiBase}#${repository.owner}/${repository.name}`;
}

export const githubKeys = {
  all: ["github"] as const,
  repository: (workspaceId: string, remoteUrl: string) =>
    ["github", "repository", workspaceId, remoteUrl] as const,
  mapping: (workspaceId: string, repository: GithubRepositoryRef | undefined) =>
    ["github", "mapping", workspaceId, repositoryKey(repository)] as const,
  issues: (
    workspaceId: string,
    repository: GithubRepositoryRef | undefined,
    filter: string,
  ) =>
    [
      "github",
      "issues",
      workspaceId,
      repositoryKey(repository),
      filter,
    ] as const,
  issue: (
    workspaceId: string,
    repository: GithubRepositoryRef | undefined,
    number: bigint,
  ) =>
    [
      "github",
      "issue",
      workspaceId,
      repositoryKey(repository),
      String(number),
    ] as const,
  pulls: (
    workspaceId: string,
    repository: GithubRepositoryRef | undefined,
    filter: string,
  ) =>
    [
      "github",
      "pulls",
      workspaceId,
      repositoryKey(repository),
      filter,
    ] as const,
  pull: (
    workspaceId: string,
    repository: GithubRepositoryRef | undefined,
    number: bigint,
  ) =>
    [
      "github",
      "pull",
      workspaceId,
      repositoryKey(repository),
      String(number),
    ] as const,
  references: (workspaceId: string, targetId: string) =>
    ["github", "references", workspaceId, targetId] as const,
  credential: (workspaceId: string) =>
    ["github", "credential", workspaceId] as const,
};

export function invalidateGithubQueries(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: githubKeys.all });
}

/**
 * What a list page said about itself, kept next to the rows.
 *
 * `fromCache` and `observedAt` travel with the rows on purpose: the panel has
 * to be able to say "this is what the Host last saw", never to present a cached
 * answer as a live one.
 */
export interface ListMeta {
  fromCache: boolean;
  observedAtUnixMs: bigint;
  pollIntervalMs: bigint;
  rateLimit?: GithubRateLimit;
  /** True when paging stopped at the cap rather than at the last page. */
  truncated: boolean;
}

export interface IssuePage extends ListMeta {
  issues: GithubIssue[];
}

export interface PullPage extends ListMeta {
  pulls: GithubPullRequest[];
}

export async function allIssues(
  client: HostGithubClient,
  repository: GithubRepositoryRef,
  filter: GithubIssueFilter | undefined,
): Promise<IssuePage> {
  const issues: GithubIssue[] = [];
  let cursor = "";
  let last: Awaited<ReturnType<HostGithubClient["listIssues"]>> | null = null;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listIssues({
      repository,
      filter,
      afterCursor: cursor,
      limit: PAGE,
    });
    last = result;
    issues.push(...result.issues);
    if (!result.hasMore) break;
    cursor = result.nextCursor;
    truncated = page === MAX_PAGES - 1;
  }
  return {
    issues,
    fromCache: last?.fromCache ?? false,
    observedAtUnixMs: last?.observedAtUnixMs ?? 0n,
    pollIntervalMs: last?.pollIntervalMs ?? 0n,
    rateLimit: last?.rateLimit,
    truncated,
  };
}

export async function allPulls(
  client: HostGithubClient,
  repository: GithubRepositoryRef,
  filter: GithubPullFilter | undefined,
): Promise<PullPage> {
  const pulls: GithubPullRequest[] = [];
  let cursor = "";
  let last: Awaited<ReturnType<HostGithubClient["listPulls"]>> | null = null;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listPulls({
      repository,
      filter,
      afterCursor: cursor,
      limit: PAGE,
    });
    last = result;
    pulls.push(...result.pulls);
    if (!result.hasMore) break;
    cursor = result.nextCursor;
    truncated = page === MAX_PAGES - 1;
  }
  return {
    pulls,
    fromCache: last?.fromCache ?? false,
    observedAtUnixMs: last?.observedAtUnixMs ?? 0n,
    pollIntervalMs: last?.pollIntervalMs ?? 0n,
    rateLimit: last?.rateLimit,
    truncated,
  };
}
