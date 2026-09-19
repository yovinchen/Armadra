/**
 * GitHub 域的那一面：`/api/github/<verb>`，JSON。
 *
 * 24 个动词各一条 `POST`，请求体是那个动词自己的参数，响应是它的返回记录，两者
 * 都按 `schema.ts` 的字段表编解码——形状逐字段写在
 * `docs/contracts/core-json-api.md` §5，页面那一侧是
 * `apps/web/src/api/github.ts` 的 zod。
 *
 * `/rpc/armadra.v1.GithubService/*` 的 protobuf 兼容面在 R7 删掉了。
 *
 * 身份从**核验过的会话**来，从不从请求里来：工作空间跟着查询串走，一次调用可以
 * 说它想操作哪个工作空间，不能说它有什么权限。
 */

import type { ServerResponse } from "node:http";

import {
  CommentGithubIssueRequestSchema,
  ConfigureGithubCredentialRequestSchema,
  CreateGithubIssueRequestSchema,
  CreateGithubPullRequestSchema,
  DeleteGithubBranchRequestSchema,
  DeleteGithubBranchResponseSchema,
  GetGithubChecksRequestSchema,
  GetGithubCredentialRequestSchema,
  GetGithubIssueRequestSchema,
  GetGithubIssueResponseSchema,
  GetGithubPullRequestSchema,
  GetGithubPullResponseSchema,
  GetGithubStatusMappingRequestSchema,
  GithubCheckSummarySchema,
  GithubCommentSchema,
  GithubCredentialStatusSchema,
  GithubExternalReferenceSchema,
  GithubIssueSchema,
  GithubPullRequestSchema,
  GithubReviewSchema,
  GithubStatusMappingSchema,
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
  RerunGithubChecksRequestSchema,
  RerunGithubChecksResponseSchema,
  ResolveGithubRepositoryRequestSchema,
  ResolveGithubRepositoryResponseSchema,
  RevokeGithubCredentialRequestSchema,
  SetGithubIssueStateRequestSchema,
  SubmitGithubReviewRequestSchema,
  UnlinkGithubReferenceRequestSchema,
  UnlinkGithubReferenceResponseSchema,
  UpdateGithubIssueRequestSchema,
} from "./schema";
import { fromJson, toJson, type MessageDesc } from "../contract/message";

import { bearerCredential, credential, nativeRequest } from "../identity/http";
import { IdentityError } from "../identity/errors";
import type { IdentityService } from "../identity/service";
import { scope } from "../identity/scopes";
import type { CoreRequest } from "../http/router";
import { rerunChecks, deleteBranch } from "./cleanup";
import { UNAUTHENTICATED, githubFailure, type GithubFailure } from "./errors";
import {
  commentIssue,
  createIssue,
  getIssue,
  listIssues,
  moveIssue,
  resolveRepository,
  setIssueState,
  updateIssue,
} from "./issues";
import {
  createPull,
  getChecks,
  getPull,
  listPulls,
  mergePull,
  submitReview,
} from "./pulls";
import {
  configureCredential,
  getCredential,
  linkReference,
  listReferences,
  revokeCredential,
  unlinkReference,
} from "./references";
import { getStatusMapping, putStatusMapping } from "./status";
import {
  SCOPE_READ,
  SCOPE_WRITE,
  type Caller,
  type GithubService,
} from "./service";

export const API_PREFIX = "/api/github/";

/** 这一面覆盖的 24 个动词。少一个，面板的某一步就断在那里。 */
export const GITHUB_METHODS = [
  "GetCredential",
  "ConfigureCredential",
  "RevokeCredential",
  "ResolveRepository",
  "ListIssues",
  "GetIssue",
  "CreateIssue",
  "UpdateIssue",
  "SetIssueState",
  "CommentIssue",
  "GetStatusMapping",
  "PutStatusMapping",
  "MoveIssue",
  "ListPulls",
  "GetPull",
  "CreatePull",
  "SubmitReview",
  "GetChecks",
  "RerunChecks",
  "MergePull",
  "DeleteBranch",
  "LinkReference",
  "UnlinkReference",
  "ListReferences",
] as const;

export type GithubMethod = (typeof GITHUB_METHODS)[number];

/** 每个方法要哪个权限，以及它是不是一次写（写要 CSRF）。 */
const PERMISSIONS: Record<
  GithubMethod,
  { permission: string; mutating: boolean }
> = {
  GetCredential: { permission: SCOPE_READ, mutating: false },
  ConfigureCredential: { permission: SCOPE_WRITE, mutating: true },
  RevokeCredential: { permission: SCOPE_WRITE, mutating: true },
  ResolveRepository: { permission: SCOPE_READ, mutating: false },
  ListIssues: { permission: SCOPE_READ, mutating: false },
  GetIssue: { permission: SCOPE_READ, mutating: false },
  CreateIssue: { permission: SCOPE_WRITE, mutating: true },
  UpdateIssue: { permission: SCOPE_WRITE, mutating: true },
  SetIssueState: { permission: SCOPE_WRITE, mutating: true },
  CommentIssue: { permission: SCOPE_WRITE, mutating: true },
  GetStatusMapping: { permission: SCOPE_READ, mutating: false },
  PutStatusMapping: { permission: SCOPE_WRITE, mutating: true },
  MoveIssue: { permission: SCOPE_WRITE, mutating: true },
  ListPulls: { permission: SCOPE_READ, mutating: false },
  GetPull: { permission: SCOPE_READ, mutating: false },
  CreatePull: { permission: SCOPE_WRITE, mutating: true },
  SubmitReview: { permission: SCOPE_WRITE, mutating: true },
  GetChecks: { permission: SCOPE_READ, mutating: false },
  RerunChecks: { permission: SCOPE_WRITE, mutating: true },
  MergePull: { permission: SCOPE_WRITE, mutating: true },
  DeleteBranch: { permission: SCOPE_WRITE, mutating: true },
  LinkReference: { permission: SCOPE_WRITE, mutating: true },
  UnlinkReference: { permission: SCOPE_WRITE, mutating: true },
  ListReferences: { permission: SCOPE_READ, mutating: false },
};

/** 每个方法的请求与响应 schema。 */
const SCHEMAS: Record<
  GithubMethod,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { request: MessageDesc<any>; response: MessageDesc<any> }
> = {
  GetCredential: {
    request: GetGithubCredentialRequestSchema,
    response: GithubCredentialStatusSchema,
  },
  ConfigureCredential: {
    request: ConfigureGithubCredentialRequestSchema,
    response: GithubCredentialStatusSchema,
  },
  RevokeCredential: {
    request: RevokeGithubCredentialRequestSchema,
    response: GithubCredentialStatusSchema,
  },
  ResolveRepository: {
    request: ResolveGithubRepositoryRequestSchema,
    response: ResolveGithubRepositoryResponseSchema,
  },
  ListIssues: {
    request: ListGithubIssuesRequestSchema,
    response: ListGithubIssuesResponseSchema,
  },
  GetIssue: {
    request: GetGithubIssueRequestSchema,
    response: GetGithubIssueResponseSchema,
  },
  CreateIssue: {
    request: CreateGithubIssueRequestSchema,
    response: GithubIssueSchema,
  },
  UpdateIssue: {
    request: UpdateGithubIssueRequestSchema,
    response: GithubIssueSchema,
  },
  SetIssueState: {
    request: SetGithubIssueStateRequestSchema,
    response: GithubIssueSchema,
  },
  CommentIssue: {
    request: CommentGithubIssueRequestSchema,
    response: GithubCommentSchema,
  },
  GetStatusMapping: {
    request: GetGithubStatusMappingRequestSchema,
    response: GithubStatusMappingSchema,
  },
  PutStatusMapping: {
    request: PutGithubStatusMappingRequestSchema,
    response: GithubStatusMappingSchema,
  },
  MoveIssue: {
    request: MoveGithubIssueRequestSchema,
    response: MoveGithubIssueResponseSchema,
  },
  ListPulls: {
    request: ListGithubPullsRequestSchema,
    response: ListGithubPullsResponseSchema,
  },
  GetPull: {
    request: GetGithubPullRequestSchema,
    response: GetGithubPullResponseSchema,
  },
  CreatePull: {
    request: CreateGithubPullRequestSchema,
    response: GithubPullRequestSchema,
  },
  SubmitReview: {
    request: SubmitGithubReviewRequestSchema,
    response: GithubReviewSchema,
  },
  GetChecks: {
    request: GetGithubChecksRequestSchema,
    response: GithubCheckSummarySchema,
  },
  RerunChecks: {
    request: RerunGithubChecksRequestSchema,
    response: RerunGithubChecksResponseSchema,
  },
  MergePull: {
    request: MergeGithubPullRequestSchema,
    response: MergeGithubPullResponseSchema,
  },
  DeleteBranch: {
    request: DeleteGithubBranchRequestSchema,
    response: DeleteGithubBranchResponseSchema,
  },
  LinkReference: {
    request: LinkGithubReferenceRequestSchema,
    response: GithubExternalReferenceSchema,
  },
  UnlinkReference: {
    request: UnlinkGithubReferenceRequestSchema,
    response: UnlinkGithubReferenceResponseSchema,
  },
  ListReferences: {
    request: ListGithubReferencesRequestSchema,
    response: ListGithubReferencesResponseSchema,
  },
};

export interface GithubHttpOptions {
  readonly service: GithubService;
  readonly identity: IdentityService;
}

/**
 * 列表响应里不带正文。一百条 Issue 的正文装不进一帧，而一个被截断的正文比一个
 * 缺席的更糟：详情请求会把整份拿回来。
 */
function withoutBodies(method: GithubMethod, message: unknown): unknown {
  if (method === "ListIssues") {
    for (const issue of (message as { issues: { body: string }[] }).issues) {
      issue.body = "";
    }
  }
  if (method === "ListPulls") {
    for (const pull of (message as { pulls: { body: string }[] }).pulls) {
      pull.body = "";
    }
  }
  return message;
}

export class GithubHttp {
  constructor(private readonly options: GithubHttpOptions) {}

  async handle(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const action = request.path.slice(API_PREFIX.length);
    const method = API_METHODS[action];
    if (method === undefined || request.method !== "POST") {
      this.json(response, cors, 404, {
        code: "NOT_FOUND",
        message: "No such method",
      });
      return;
    }
    const schema = SCHEMAS[method];
    let input: unknown;
    try {
      input = fromJson(
        schema.request,
        request.body.byteLength === 0 ? {} : request.json(),
      );
    } catch {
      this.json(response, cors, 400, {
        code: "INVALID_ARGUMENT",
        message: "Invalid GitHub request",
      });
      return;
    }
    let caller: Caller;
    try {
      caller = this.caller(request, method);
    } catch (error) {
      const failure = this.authFailure(error);
      this.json(response, cors, failure.status, {
        code: failure.code,
        message: failure.message,
      });
      return;
    }
    try {
      const result = withoutBodies(
        method,
        await this.invoke(method, caller, input),
      );
      // 零值照写：一份缺字段的 JSON 和一份字段为零的 JSON 对页面是两句话，而
      // 同一条记录只该有一句。`apps/web/src/api/github.ts` 的 zod 按这个形状解。
      this.json(
        response,
        cors,
        200,
        toJson(schema.response, result),
      );
    } catch (error) {
      const failure = githubFailure(error);
      this.json(response, cors, failure.status, {
        code: failure.code,
        message: failure.message,
      });
    } finally {
      if (method === "ConfigureCredential") {
        (input as unknown as { token: string }).token = "";
      }
    }
  }

  /**
   * 这一面的调用方。
   *
   * 两条规矩：
   *
   *   1. **工作空间跟着查询串走**。一次调用可以说它想操作哪个工作空间，不能说它
   *      有什么权限——那仍然只来自会话。
   *   2. **明文回环上的无凭据调用按本机主人处理**（{@link IdentityService.localOwner}）。
   *      页面经 `apps/web/src/api/request.ts` 打这一面，而桌面壳的会话是原生的，
   *      密钥在壳里：既不发 Cookie，也到不了那个 `fetch`。TLS 的服务器壳上这条
   *      路不存在，凭据仍然是必须的。
   */
  private caller(request: CoreRequest, method: GithubMethod): Caller {
    const origin = header(request, "origin");
    if (origin === undefined || countHeader(request, "origin") !== 1) {
      throw new IdentityError("permission");
    }
    if (countHeader(request, "x-armadra-csrf") > 1) {
      throw new IdentityError("permission");
    }
    const workspaceId = request.query.get("workspaceId") ?? "";
    if (workspaceId === "") throw new IdentityError("invalid");
    const hostId = this.options.service.hostId;
    const rule = PERMISSIONS[method];
    const identity = this.options.identity;
    const token = credential(request, identity.hostId(), "access");
    if (token === "" && nativeRequest(request)) {
      const owner = identity.localOwner();
      if (owner === undefined) throw new IdentityError("unauthenticated");
      return { ...owner, workspaceId };
    }
    const principal = identity.authenticate({
      accessToken: token,
      hostId: identity.hostId(),
      origin,
      csrfToken: header(request, "x-armadra-csrf") ?? "",
      requireCsrf: rule.mutating,
      requiredScopes: [scope(rule.permission, workspaceId, hostId)],
    });
    return {
      principalId: principal.principalId,
      deviceId: principal.deviceId,
      deviceEpoch: principal.deviceEpoch,
      workspaceId,
      scopes: principal.scopes,
    };
  }

  private authFailure(error: unknown): GithubFailure {
    if (error instanceof IdentityError) {
      if (error.kind === "unauthenticated") return UNAUTHENTICATED;
      if (error.kind === "invalid") {
        return {
          status: 400,
          code: "INVALID_ARGUMENT",
          message: "Invalid GitHub request",
        };
      }
      return {
        status: 403,
        code: "PERMISSION_DENIED",
        message: "GitHub permission or CSRF check failed",
      };
    }
    return githubFailure(error);
  }

  /** 一个方法名到它的实现。25 条，一条不少。 */
  private invoke(
    method: GithubMethod,
    caller: Caller,
    input: unknown,
  ): Promise<unknown> | unknown {
    const service = this.options.service;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const message = input as any;
    switch (method) {
      case "GetCredential":
        return getCredential(service, caller);
      case "ConfigureCredential":
        return configureCredential(service, caller, message);
      case "RevokeCredential":
        return revokeCredential(service, caller, message);
      case "ResolveRepository":
        return resolveRepository(service, caller, message.remoteUrl);
      case "ListIssues":
        return listIssues(service, caller, message);
      case "GetIssue":
        return getIssue(service, caller, message);
      case "CreateIssue":
        return createIssue(service, caller, message);
      case "UpdateIssue":
        return updateIssue(service, caller, message);
      case "SetIssueState":
        return setIssueState(service, caller, message);
      case "CommentIssue":
        return commentIssue(service, caller, message);
      case "GetStatusMapping":
        return getStatusMapping(service, caller, message.repository);
      case "PutStatusMapping":
        return putStatusMapping(
          service,
          caller,
          message.mapping,
          message.expectedRevision,
        );
      case "MoveIssue":
        return moveIssue(service, caller, message);
      case "ListPulls":
        return listPulls(service, caller, message);
      case "GetPull":
        return getPull(service, caller, message);
      case "CreatePull":
        return createPull(service, caller, message);
      case "SubmitReview":
        return submitReview(service, caller, message);
      case "GetChecks":
        return getChecks(service, caller, message);
      case "RerunChecks":
        return rerunChecks(service, caller, message);
      case "MergePull":
        return mergePull(service, caller, message);
      case "DeleteBranch":
        return deleteBranch(service, caller, message);
      case "LinkReference":
        return linkReference(service, caller, message);
      case "UnlinkReference":
        return unlinkReference(service, caller, message);
      case "ListReferences":
        return listReferences(service, caller, message);
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  private fail(
    response: ServerResponse,
    cors: Record<string, string>,
    failure: GithubFailure,
  ): void {
    this.json(response, cors, failure.status, {
      code: failure.code,
      message: failure.message,
    });
  }

  private json(
    response: ServerResponse,
    cors: Record<string, string>,
    status: number,
    body: unknown,
  ): void {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    response.writeHead(status, {
      ...cors,
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  }
}

/** 路径上的动词名：方法名的 kebab-case。 */
export const API_METHODS: Record<string, GithubMethod> = Object.fromEntries(
  GITHUB_METHODS.map((method) => [kebab(method), method]),
);

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function header(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function countHeader(request: CoreRequest, name: string): number {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length;
  return typeof value === "string" ? 1 : 0;
}
