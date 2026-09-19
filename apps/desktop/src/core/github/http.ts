/**
 * GitHub 域的两张面。
 *
 * **兼容面** `/rpc/armadra.v1.GithubService/…`：二进制 protobuf，24 个方法，
 * `packages/host-client/src/github` 今天发的就是它。本批前端一行不改，所以这一面
 * 必须逐字对上：路径、`application/x-protobuf`、消息形状、`Origin` 与 CSRF 的门，
 * 以及 `{ code, message }` 的拒绝形状。它活到 R7。
 *
 * **新面** `/api/github/*`：JSON，同一批动词，设计 D9 里前端最终要收到的那一套。
 * 请求体是 protobuf 消息的 JSON 形式（`fromJson`），响应是 `toJson`——用同一份
 * schema 而不是手写一遍 camelCase，这样两张面不可能对同一个字段有两种说法。
 *
 * 身份从**核验过的会话**来，从不从消息里来。请求里的 scope 只挑工作空间；一个
 * 不是这台机器的 host 被拒绝，而不是被重新解释成本地。
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
  GetGithubStatusMappingRequestSchema,
  GetGithubIssueResponseSchema,
  GetGithubPullRequestSchema,
  GetGithubPullResponseSchema,
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
  MAX_FRAME_BYTES,
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
  fromBinary,
  toBinary,
  type CommandMeta,
} from "@armadra/protocol";
// `fromJson` / `toJson` 走上游包：`@armadra/protocol` 的 barrel 只转出
// `create` / `fromBinary` / `toBinary`，而新面要的是同一份 schema 的 JSON 形式。
// 用同一个版本（2.2.5）的同一个运行时，两张面不可能对一个字段有两种说法。
import {
  fromJson,
  toJson,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";

import { bearerCredential } from "../identity/http";
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

export const MEDIA_TYPE = "application/x-protobuf";
export const RPC_PREFIX = "/rpc/armadra.v1.GithubService/";
export const API_PREFIX = "/api/github/";

/**
 * 兼容面覆盖的 24 个方法，顺序照 `apps/host/internal/server/github.go` 的
 * `githubMethod`。少一个，面板的某一步就断在那里。
 */
export const RPC_METHODS = [
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

export type RpcMethod = (typeof RPC_METHODS)[number];

/** 每个方法要哪个权限，以及它是不是一次写（写要 CSRF）。 */
const PERMISSIONS: Record<
  RpcMethod,
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
  RpcMethod,
  { request: DescMessage; response: DescMessage }
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
function withoutBodies(method: RpcMethod, message: unknown): unknown {
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

  /** 兼容面。前端发什么，这里就得收什么。 */
  async rpc(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    const method = request.path.slice(RPC_PREFIX.length) as RpcMethod;
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      this.fail(response, cors, {
        status: 405,
        code: "UNSUPPORTED",
        message: "A POST is required",
      });
      return;
    }
    if (!(RPC_METHODS as readonly string[]).includes(method)) {
      this.fail(response, cors, {
        status: 404,
        code: "NOT_FOUND",
        message: "No such method",
      });
      return;
    }
    const type = (request.headers["content-type"] ?? "").toString();
    if (!type.startsWith(MEDIA_TYPE)) {
      this.fail(response, cors, {
        status: 415,
        code: "INVALID_ARGUMENT",
        message: "A Protobuf request is required",
      });
      return;
    }
    if (request.body.byteLength > MAX_FRAME_BYTES) {
      this.fail(response, cors, {
        status: 413,
        code: "RESOURCE_EXHAUSTED",
        message: "GitHub request exceeds its limit",
      });
      return;
    }
    const schema = SCHEMAS[method];
    let input: MessageShape<DescMessage>;
    try {
      input = fromBinary(schema.request, new Uint8Array(request.body));
    } catch {
      this.fail(response, cors, {
        status: 400,
        code: "INVALID_ARGUMENT",
        message: "Invalid GitHub request",
      });
      return;
    }
    let caller: Caller;
    try {
      caller = this.caller(request, method, input);
    } catch (error) {
      this.fail(response, cors, this.authFailure(error));
      return;
    }
    try {
      const result = withoutBodies(
        method,
        await this.invoke(method, caller, input),
      );
      const wire = toBinary(
        schema.response,
        result as MessageShape<DescMessage>,
      );
      if (wire.byteLength > MAX_FRAME_BYTES) {
        // 一个不合规的客户端读不了的帧不发出去：超出预算是调用方能应对的错误，
        // 不是一段会被截成它认不出的东西的正文。
        this.fail(response, cors, {
          status: 413,
          code: "RESOURCE_EXHAUSTED",
          message:
            "The GitHub result exceeds the frame budget; narrow the request",
        });
        return;
      }
      response.writeHead(200, { ...cors, "content-type": MEDIA_TYPE });
      response.end(Buffer.from(wire));
    } catch (error) {
      this.fail(response, cors, githubFailure(error));
    } finally {
      // 粘进来的令牌在调用返回之后就从这个进程手里这份请求上抹掉，不论结果如何。
      if (method === "ConfigureCredential") {
        (input as unknown as { token: string }).token = "";
      }
    }
  }

  /** 新面。同一批动词，JSON 的外衣。 */
  async api(
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
    let input: MessageShape<DescMessage>;
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
      caller = this.caller(request, method, input);
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
      this.json(
        response,
        cors,
        200,
        toJson(schema.response, result as MessageShape<DescMessage>),
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
   * 从核验过的会话里推出调用方。请求里的 scope 只挑工作空间；它从不提供身份，而
   * 一个不是这台机器的 host 被拒绝，而不是被重新解释成本地。
   */
  private caller(
    request: CoreRequest,
    method: RpcMethod,
    input: MessageShape<DescMessage>,
  ): Caller {
    const origin = header(request, "origin");
    if (origin === undefined || countHeader(request, "origin") !== 1) {
      throw new IdentityError("permission");
    }
    if (countHeader(request, "x-armadra-csrf") > 1) {
      throw new IdentityError("permission");
    }
    const meta = (input as unknown as { meta?: CommandMeta }).meta;
    const workspaceId = meta?.scope?.workspaceId ?? "";
    if (workspaceId === "") throw new IdentityError("invalid");
    const hostId = this.options.service.hostId;
    if ((meta?.scope?.hostId ?? "") !== "" && meta?.scope?.hostId !== hostId) {
      throw new IdentityError("permission");
    }
    if (
      (meta?.scope?.executionHostId ?? "") !== "" &&
      meta?.scope?.executionHostId !== hostId
    ) {
      throw new IdentityError("permission");
    }
    const rule = PERMISSIONS[method];
    const principal = this.options.identity.authenticate({
      accessToken: bearerCredential(request),
      hostId: this.options.identity.hostId(),
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
    method: RpcMethod,
    caller: Caller,
    input: MessageShape<DescMessage>,
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

/**
 * 新面的动词名。它们是 RPC 方法名的 kebab-case——同一批动词、同一批 schema，只是
 * 拼法跟着 `/api/` 的习惯。
 */
export const API_METHODS: Record<string, RpcMethod> = Object.fromEntries(
  RPC_METHODS.map((method) => [kebab(method), method]),
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
