/**
 * 端点包装。移植自 `apps/host/internal/githubapi/resources.go` 与 `projects.go`。
 *
 * 每一个在拼路径之前先校验引用，所以 owner 或仓库名永远没法把请求扩到调用方指名
 * 的那个仓库之外。
 */

import {
  GithubCheckConclusion,
  GithubIssueState,
  GithubPullState,
  GithubRepositorySchema,
  create,
  type GithubCheckRun,
  type GithubCheckSummary,
  type GithubComment,
  type GithubIssue,
  type GithubIssueFilter,
  type GithubMergeMethod,
  type GithubPullFile,
  type GithubPullFilter,
  type GithubPullRequest,
  type GithubRepository,
  type GithubRepositoryRef,
  type GithubReview,
  type GithubReviewComment,
} from "@armadra/protocol";

import { type GithubClient, type GithubResponse, perPage } from "./client";
import { apiFailure, codeOf } from "./errors";
import {
  checkSummary,
  isPullRecord,
  mergeMethods,
  permission,
  statusRun,
  toCheckRun,
  toComment,
  toFile,
  toIssue,
  toPull,
  toReview,
  toReviewComment,
  type WireCheckRun,
  type WireComment,
  type WireFile,
  type WireIssue,
  type WirePull,
  type WireRepository,
  type WireReview,
  type WireReviewComment,
  type WireStatus,
} from "./decode";
import { validName } from "./remote";

/**
 * Issue / PR 编号的上界。
 *
 * 写成 `2n ** 31n` 而不是 `BigInt(1 << 31)`：后者在 JS 里是 32 位有符号左移，
 * 得到的是 -2147483648，于是**每一个**正编号都会被判成越界。
 */
const MAX_NUMBER = 2n ** 31n;

function decode<T>(response: GithubResponse): T {
  try {
    return JSON.parse(response.body.toString("utf8")) as T;
  } catch {
    throw apiFailure("INVALID_ARGUMENT", response.status, "RESPONSE_MALFORMED");
  }
}

function repoPath(
  client: GithubClient,
  ref: GithubRepositoryRef | undefined,
  suffix: string,
): string {
  if (ref === undefined || !validName(ref.owner) || !validName(ref.name)) {
    throw apiFailure("INVALID_ARGUMENT", 0, "REPOSITORY_INVALID");
  }
  // 指向另一个服务的引用会把这个仓库的名字——和这个令牌——送到错误的 authority。
  if (ref.apiBase !== "" && ref.apiBase !== client.apiBase()) {
    throw apiFailure("INVALID_ARGUMENT", 0, "API_BASE_MISMATCH");
  }
  return `/repos/${ref.owner}/${ref.name}${suffix}`;
}

function issuePath(
  client: GithubClient,
  ref: GithubRepositoryRef | undefined,
  number: bigint,
  suffix: string,
): string {
  if (number <= 0n || number > MAX_NUMBER) {
    throw apiFailure("INVALID_ARGUMENT", 0, "NUMBER_INVALID");
  }
  return repoPath(client, ref, `/issues/${number}${suffix}`);
}

function pullPath(
  client: GithubClient,
  ref: GithubRepositoryRef | undefined,
  number: bigint,
  suffix: string,
): string {
  if (number <= 0n || number > MAX_NUMBER) {
    throw apiFailure("INVALID_ARGUMENT", 0, "NUMBER_INVALID");
  }
  return repoPath(client, ref, `/pulls/${number}${suffix}`);
}

/** 仓库本身，也是合并策略和访问者权限的来源。 */
export async function repository(
  client: GithubClient,
  ref: GithubRepositoryRef,
  atMs: number,
): Promise<{ repository: GithubRepository; response: GithubResponse }> {
  const response = await client.get(repoPath(client, ref, ""));
  const value = decode<WireRepository>(response);
  return {
    repository: create(GithubRepositorySchema, {
      ref,
      id: BigInt(Math.trunc(value.id ?? 0)),
      defaultBranch: value.default_branch ?? "",
      private: value.private === true,
      fork: value.fork === true,
      hasIssues: value.has_issues === true,
      allowedMergeMethods: mergeMethods(value),
      permission: permission(value),
      observedAtUnixMs: BigInt(atMs),
    }),
    response,
  };
}

function issueQuery(
  filter: GithubIssueFilter | undefined,
  page: number,
  limit: number,
): Record<string, string> {
  const query: Record<string, string> = {
    per_page: perPage(limit),
    sort: "updated",
    direction: "desc",
  };
  if (page > 1) query.page = String(page);
  let state = "all";
  if (filter !== undefined) {
    if (filter.state === GithubIssueState.OPEN) state = "open";
    if (filter.state === GithubIssueState.CLOSED) state = "closed";
    if (filter.labels.length > 0) query.labels = filter.labels.join(",");
    if (filter.assignee !== "") query.assignee = filter.assignee;
    if (filter.author !== "") query.creator = filter.author;
    if (filter.milestoneNumber > 0n) {
      query.milestone = String(filter.milestoneNumber);
    }
  }
  query.state = state;
  return query;
}

/**
 * 列一页 Issue。Issues 端点也会返回 PR，所以任何带 `pull_request` 成员的东西在这
 * 里被丢掉，而不是出现在一张关掉它含义完全不同的 Issue 列表里。
 */
export async function issues(
  client: GithubClient,
  ref: GithubRepositoryRef,
  filter: GithubIssueFilter | undefined,
  page: number,
  limit: number,
  atMs: number,
): Promise<{ issues: GithubIssue[]; response: GithubResponse }> {
  const response = await client.get(
    repoPath(client, ref, "/issues"),
    issueQuery(filter, page, limit),
  );
  const values = decode<WireIssue[]>(response);
  const needle = (filter?.query ?? "").trim().toLowerCase();
  const result: GithubIssue[] = [];
  for (const value of values) {
    if (isPullRecord(value)) continue;
    // 自由文本过滤在本地做：search API 是另一套配额、另一套限流，混在一起会让
    // 翻页和「观察于」这个瞬间在每一页上含义不同。
    if (
      needle !== "" &&
      !(value.title ?? "").toLowerCase().includes(needle) &&
      !(value.body ?? "").toLowerCase().includes(needle)
    ) {
      continue;
    }
    result.push(toIssue(value, ref, atMs));
  }
  return { issues: result, response };
}

export async function issue(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  atMs: number,
): Promise<{
  issue: GithubIssue;
  nodeId: string;
  response: GithubResponse;
}> {
  const response = await client.get(issuePath(client, ref, number, ""));
  const value = decode<WireIssue>(response);
  if (isPullRecord(value)) {
    throw apiFailure("NOT_FOUND", response.status, "NOT_AN_ISSUE");
  }
  return {
    issue: toIssue(value, ref, atMs),
    nodeId: value.node_id ?? "",
    response,
  };
}

export async function issueComments(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  limit: number,
): Promise<GithubComment[]> {
  const response = await client.get(
    issuePath(client, ref, number, "/comments"),
    { per_page: perPage(limit) },
  );
  return decode<WireComment[]>(response).map(toComment);
}

export async function createIssue(
  client: GithubClient,
  ref: GithubRepositoryRef,
  body: Record<string, unknown>,
  atMs: number,
): Promise<GithubIssue> {
  const response = await client.write(
    "POST",
    repoPath(client, ref, "/issues"),
    body,
  );
  return toIssue(decode<WireIssue>(response), ref, atMs);
}

/**
 * 写调用方已经组装好的那些成员。调用方已经重新读过这个 Issue，所以这里绝不往请求
 * 里合并任何自己的东西。
 */
export async function patchIssue(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  body: Record<string, unknown>,
  atMs: number,
): Promise<GithubIssue> {
  const response = await client.write(
    "PATCH",
    issuePath(client, ref, number, ""),
    body,
  );
  return toIssue(decode<WireIssue>(response), ref, atMs);
}

export async function createIssueComment(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  text: string,
): Promise<GithubComment> {
  const response = await client.write(
    "POST",
    issuePath(client, ref, number, "/comments"),
    { body: text },
  );
  return toComment(decode<WireComment>(response));
}

function pullQuery(
  filter: GithubPullFilter | undefined,
  page: number,
  limit: number,
): Record<string, string> {
  const query: Record<string, string> = {
    per_page: perPage(limit),
    sort: "updated",
    direction: "desc",
  };
  if (page > 1) query.page = String(page);
  let state = "all";
  if (filter !== undefined) {
    if (filter.state === GithubPullState.OPEN) state = "open";
    if (
      filter.state === GithubPullState.CLOSED ||
      filter.state === GithubPullState.MERGED
    ) {
      state = "closed";
    }
    if (filter.baseRef !== "") query.base = filter.baseRef;
  }
  query.state = state;
  return query;
}

/**
 * 列一页 PR。作者、被请求评审、草稿和已合并这几个过滤在本地做，因为列表端点不
 * 提供它们，也因为 search API 会在另一套配额下翻页。
 */
export async function pulls(
  client: GithubClient,
  ref: GithubRepositoryRef,
  filter: GithubPullFilter | undefined,
  page: number,
  limit: number,
  allowed: readonly GithubMergeMethod[],
  atMs: number,
): Promise<{ pulls: GithubPullRequest[]; response: GithubResponse }> {
  const response = await client.get(
    repoPath(client, ref, "/pulls"),
    pullQuery(filter, page, limit),
  );
  const values = decode<WirePull[]>(response);
  const result: GithubPullRequest[] = [];
  for (const value of values) {
    const pull = toPull(value, ref, allowed, atMs);
    if (filter !== undefined) {
      if (
        filter.state === GithubPullState.MERGED &&
        pull.state !== GithubPullState.MERGED
      ) {
        continue;
      }
      if (
        filter.state === GithubPullState.CLOSED &&
        pull.state !== GithubPullState.CLOSED
      ) {
        continue;
      }
      if (
        filter.author !== "" &&
        (pull.author === undefined ||
          pull.author.login.toLowerCase() !== filter.author.toLowerCase())
      ) {
        continue;
      }
      if (filter.draftOnly && !pull.draft) continue;
      if (
        filter.reviewRequested !== "" &&
        !pull.requestedReviewers.some(
          (reviewer) =>
            reviewer.login.toLowerCase() ===
            filter.reviewRequested.toLowerCase(),
        )
      ) {
        continue;
      }
    }
    result.push(pull);
  }
  return { pulls: result, response };
}

export async function pull(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  allowed: readonly GithubMergeMethod[],
  atMs: number,
): Promise<{ pull: GithubPullRequest; response: GithubResponse }> {
  const response = await client.get(pullPath(client, ref, number, ""));
  return {
    pull: toPull(decode<WirePull>(response), ref, allowed, atMs),
    response,
  };
}

export async function pullFiles(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  limit: number,
): Promise<GithubPullFile[]> {
  const response = await client.get(pullPath(client, ref, number, "/files"), {
    per_page: perPage(limit),
  });
  return decode<WireFile[]>(response).map(toFile);
}

export async function pullReviews(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  limit: number,
): Promise<GithubReview[]> {
  const response = await client.get(pullPath(client, ref, number, "/reviews"), {
    per_page: perPage(limit),
  });
  return decode<WireReview[]>(response).map(toReview);
}

export async function pullReviewComments(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  limit: number,
): Promise<GithubReviewComment[]> {
  const response = await client.get(
    pullPath(client, ref, number, "/comments"),
    {
      per_page: perPage(limit),
    },
  );
  return decode<WireReviewComment[]>(response).map(toReviewComment);
}

export async function createPull(
  client: GithubClient,
  ref: GithubRepositoryRef,
  body: Record<string, unknown>,
  allowed: readonly GithubMergeMethod[],
  atMs: number,
): Promise<GithubPullRequest> {
  const response = await client.write(
    "POST",
    repoPath(client, ref, "/pulls"),
    body,
  );
  return toPull(decode<WirePull>(response), ref, allowed, atMs);
}

export async function createReview(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  body: Record<string, unknown>,
): Promise<GithubReview> {
  const response = await client.write(
    "POST",
    pullPath(client, ref, number, "/reviews"),
    body,
  );
  return toReview(decode<WireReview>(response));
}

function validRefName(name: string): boolean {
  return (
    name !== "" &&
    name.length <= 255 &&
    !name.includes("..") &&
    !name.startsWith("/")
  );
}

/**
 * 读一个 ref 的对象。为一个从没推上去的分支建 PR 会在远端失败并给一条含糊的消息，
 * 所以 core 先查一次并说清楚哪个分支不在。
 */
export async function refSha(
  client: GithubClient,
  ref: GithubRepositoryRef,
  name: string,
): Promise<string> {
  if (!validRefName(name)) {
    throw apiFailure("INVALID_ARGUMENT", 0, "REF_INVALID");
  }
  const response = await client.get(
    repoPath(client, ref, `/git/ref/heads/${encodeURIComponent(name)}`),
  );
  return decode<{ object?: { sha?: string } }>(response).object?.sha ?? "";
}

/** 只接受完整的对象名。短 SHA 会让一次合并指向评审者看到的那个 head 之外的东西。 */
export function validSha(value: string): boolean {
  return (
    (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value)
  );
}

/**
 * 读 GitHub 为一个提交暴露的两张面：check run 和更老的 commit status。一个仓库
 * 可能只用其中一种，只报一张会给出一个空的、读起来令人放心的假结果。
 */
export async function checks(
  client: GithubClient,
  ref: GithubRepositoryRef,
  sha: string,
  atMs: number,
): Promise<GithubCheckSummary> {
  if (!validSha(sha)) throw apiFailure("INVALID_ARGUMENT", 0, "SHA_INVALID");
  const runsResponse = await client.get(
    repoPath(client, ref, `/commits/${sha}/check-runs`),
    { per_page: perPage(0) },
  );
  const decoded = decode<{ check_runs?: WireCheckRun[] }>(runsResponse);
  const runs: GithubCheckRun[] = (decoded.check_runs ?? []).map(toCheckRun);
  try {
    const statusResponse = await client.get(
      repoPath(client, ref, `/commits/${sha}/status`),
      { per_page: perPage(0) },
    );
    const combined = decode<{ statuses?: WireStatus[] }>(statusResponse);
    for (const status of combined.statuses ?? []) runs.push(statusRun(status));
  } catch (error) {
    // commit status 是可选的；一个只用 check run 的仓库没有它照样是完整答案。
    if (codeOf(error) !== "NOT_FOUND") throw error;
  }
  return checkSummary(sha, runs, atMs);
}

/**
 * 一次写，永远不重试。一次拒绝连同远端状态一起报出去，这样调用方能说清是 head
 * 动了还是保护规则挡了。
 */
export async function merge(
  client: GithubClient,
  ref: GithubRepositoryRef,
  number: bigint,
  sha: string,
  method: string,
  title: string,
  message: string,
): Promise<string> {
  if (!validSha(sha)) throw apiFailure("INVALID_ARGUMENT", 0, "SHA_INVALID");
  const body: Record<string, unknown> = { sha, merge_method: method };
  if (title !== "") body.commit_title = title;
  if (message !== "") body.commit_message = message;
  const response = await client.write(
    "PUT",
    pullPath(client, ref, number, "/merge"),
    body,
  );
  const value = decode<{ sha?: string; merged?: boolean }>(response);
  // 一个说 `merged:false` 的 200 是一次拒绝，不是一次成功。它被报成拒绝，这样没有
  // 调用方能把「没有错误」读成「合了」。
  if (value.merged !== true || !validSha(value.sha ?? "")) {
    throw apiFailure("CONFLICT", response.status, "NOT_MERGED");
  }
  return value.sha as string;
}

/**
 * 重启一次 Actions 工作流运行。`failedOnly` 只重跑没过的 job，那是一个刚修好一个
 * job 的读者想要的；整个运行是 API 永远接受的兜底。
 *
 * 这是一次写，所以永远不重试：一次重复的重启会烧掉第二份 runner 时间并产生第二个
 * 互相竞争的结果。
 */
export async function rerunWorkflowRun(
  client: GithubClient,
  ref: GithubRepositoryRef,
  runId: bigint,
  failedOnly: boolean,
): Promise<void> {
  if (runId <= 0n) {
    throw apiFailure("INVALID_ARGUMENT", 0, "WORKFLOW_RUN_INVALID");
  }
  const suffix = failedOnly ? "/rerun-failed-jobs" : "/rerun";
  await client.write(
    "POST",
    repoPath(client, ref, `/actions/runs/${runId}${suffix}`),
    {},
  );
}

/** 删一个分支 ref。调用方已经重新读过并比对过；这里只执行删除。 */
export async function deleteRef(
  client: GithubClient,
  ref: GithubRepositoryRef,
  name: string,
): Promise<void> {
  if (!validRefName(name)) {
    throw apiFailure("INVALID_ARGUMENT", 0, "REF_INVALID");
  }
  await client.write(
    "DELETE",
    repoPath(client, ref, `/git/refs/heads/${encodeURIComponent(name)}`),
  );
}

/**
 * 认一个凭据属于哪个账号，以及远端说这个令牌带着哪些 scope。这是唯一一条不靠猜就
 * 能回答「这个凭据能用吗」的路。
 */
export async function viewer(
  client: GithubClient,
): Promise<{ login: string; scopes: readonly string[] }> {
  const response = await client.get("/user");
  return {
    login: decode<{ login?: string }>(response).login ?? "",
    scopes: response.oauthScopes,
  };
}

/* ------------------------------- Projects v2 ------------------------------ */

const NODE_PATTERN = /^[A-Za-z0-9_=-]{1,256}$/;

function validNode(...values: string[]): void {
  for (const value of values) {
    if (!NODE_PATTERN.test(value)) {
      throw apiFailure("INVALID_ARGUMENT", 0, "NODE_ID_INVALID");
    }
  }
}

// API 在 projectItems 上没有按 project 过滤的入口，所以这个 Issue 属于的每个
// project 都会回来，正在配置的那个在这里挑出来。
const PROJECT_ITEM_QUERY =
  "query($issue:ID!){node(id:$issue){... on Issue{projectItems(first:50){nodes{id project{id} fieldValues(first:50){nodes{... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2FieldCommon{id}}}}}}}}}}";

const ADD_PROJECT_ITEM_MUTATION =
  "mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}";

const SET_PROJECT_FIELD_MUTATION =
  "mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}";

const PROJECT_STATUSES_QUERY =
  "query($project:ID!,$after:String){node(id:$project){... on ProjectV2{items(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{content{... on Issue{number}} fieldValues(first:50){nodes{... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2FieldCommon{id}}}}}}}}}}";

/** 一次列举的上界。比这更大的 project 只被读到一部分。 */
const PROJECT_STATUS_PAGES = 5;

/**
 * 一个 Issue 在一个 project 上的成员关系，以及它的 Status 字段现在持有的选项。
 * 空的 `itemId` 表示这个 Issue 压根不在这个 project 上，那和「在上面但没设值」是
 * 两种不同的修法。
 */
export interface ProjectItem {
  readonly itemId: string;
  readonly optionId: string;
}

interface FieldValueNodes {
  nodes?: { optionId?: string; field?: { id?: string } }[];
}

export async function projectItem(
  client: GithubClient,
  issueNodeId: string,
  projectId: string,
  fieldId: string,
): Promise<ProjectItem> {
  validNode(issueNodeId, projectId, fieldId);
  const data = (await client.graphql(PROJECT_ITEM_QUERY, {
    issue: issueNodeId,
  })) as {
    node?: {
      projectItems?: {
        nodes?: {
          id?: string;
          project?: { id?: string };
          fieldValues?: FieldValueNodes;
        }[];
      };
    };
  } | null;
  for (const item of data?.node?.projectItems?.nodes ?? []) {
    if (item.project?.id !== projectId) continue;
    let optionId = "";
    for (const value of item.fieldValues?.nodes ?? []) {
      if (value.field?.id === fieldId) optionId = value.optionId ?? "";
    }
    return { itemId: item.id ?? "", optionId };
  }
  return { itemId: "", optionId: "" };
}

/**
 * 把这个 Issue 放上 project。它是独立的一次调用，因为「加进 project」和「设置
 * Status」是两个独立的效果，而一次只成功了一半的移动必须能说清是哪一半。
 */
export async function addProjectItem(
  client: GithubClient,
  projectId: string,
  issueNodeId: string,
): Promise<string> {
  validNode(projectId, issueNodeId);
  const data = (await client.graphql(ADD_PROJECT_ITEM_MUTATION, {
    project: projectId,
    content: issueNodeId,
  })) as { addProjectV2ItemById?: { item?: { id?: string } } } | null;
  const id = data?.addProjectV2ItemById?.item?.id ?? "";
  if (id === "") throw apiFailure("INVALID_ARGUMENT", 0, "GRAPHQL_MALFORMED");
  return id;
}

/**
 * 读一个 project 上每个 Issue 的 Status 字段，这样一页 Issue 一次查询就能分组，
 * 而不是每个 Issue 一次。
 */
export async function projectStatuses(
  client: GithubClient,
  projectId: string,
  fieldId: string,
): Promise<Map<number, string>> {
  validNode(projectId, fieldId);
  const result = new Map<number, string>();
  let cursor = "";
  for (let page = 0; page < PROJECT_STATUS_PAGES; page += 1) {
    const variables: Record<string, unknown> = { project: projectId };
    if (cursor !== "") variables.after = cursor;
    const data = (await client.graphql(PROJECT_STATUSES_QUERY, variables)) as {
      node?: {
        items?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          nodes?: {
            content?: { number?: number };
            fieldValues?: FieldValueNodes;
          }[];
        };
      };
    } | null;
    const items = data?.node?.items;
    for (const item of items?.nodes ?? []) {
      const number = item.content?.number ?? 0;
      if (number <= 0) continue;
      for (const value of item.fieldValues?.nodes ?? []) {
        if (value.field?.id === fieldId && (value.optionId ?? "") !== "") {
          result.set(number, value.optionId as string);
        }
      }
    }
    if (items?.pageInfo?.hasNextPage !== true) break;
    const next = items.pageInfo.endCursor ?? "";
    if (next === "") break;
    cursor = next;
  }
  return result;
}

export async function setProjectField(
  client: GithubClient,
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): Promise<void> {
  validNode(projectId, itemId, fieldId, optionId);
  const data = (await client.graphql(SET_PROJECT_FIELD_MUTATION, {
    project: projectId,
    item: itemId,
    field: fieldId,
    option: optionId,
  })) as {
    updateProjectV2ItemFieldValue?: { projectV2Item?: { id?: string } };
  } | null;
  if ((data?.updateProjectV2ItemFieldValue?.projectV2Item?.id ?? "") === "") {
    throw apiFailure("INVALID_ARGUMENT", 0, "GRAPHQL_MALFORMED");
  }
}

/** rollup 用到的常量，导出给 `pulls.ts` 判断「检查有没有变」。 */
export const CHECK_UNSPECIFIED = GithubCheckConclusion.UNSPECIFIED;
