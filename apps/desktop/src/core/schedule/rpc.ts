import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  ActivateAutomationRequestSchema,
  AutomationCommandSessionSchema,
  AutomationCommandSessionState,
  AutomationPlanSnapshotSchema,
  AutomationRunSnapshotSchema,
  CommandLaunchSpecSchema,
  DefineAutomationRequestSchema,
  DefineCommandSessionRequestSchema,
  ErrorResponseSchema,
  GetAutomationPayloadRequestSchema,
  GetAutomationPayloadResponseSchema,
  ListAutomationPlansRequestSchema,
  ListAutomationPlansResponseSchema,
  ListAutomationRunsRequestSchema,
  ListAutomationRunsResponseSchema,
  ListCommandSessionsRequestSchema,
  ListCommandSessionsResponseSchema,
  PauseAutomationRequestSchema,
  RunAutomationNowRequestSchema,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";

import type { CoreRequest } from "../http/router";
import type { IdentityService } from "../identity/service";
import { MEDIA_TYPE, bearerCredential } from "../identity/http";
import { identityFailure, isIdentityError } from "../identity/errors";
import { ScheduleError, big, num } from "./plan";
import type { PlanSnapshot } from "./engine";
import { type Caller, ScheduleService } from "./service";
import type { CommandSessionRecord } from "./store";
import { COMMAND_SESSION_READY } from "./store";

/**
 * 自动化的 **兼容面**：`/rpc/armadra.v1.AutomationService/…`，二进制 protobuf。
 *
 * `packages/host-client` 的 `HostAutomationClient` 今天发的就是它，而这一批
 * `apps/web` 一行不改。所以这一面必须逐字对上：路径、`application/x-protobuf`、
 * 九个方法名、消息形状，以及 `Origin` 与 CSRF 的门。它活到前端改打 `/api/` 之后
 * 才删——新面 `/api/automations/*` 已经在隔壁 `api.ts` 里备好了。
 *
 * 前缀比身份域那一条长，所以 `CoreServer.raw` 的「最长前缀优先」会先选中这里；
 * 身份域的 `/rpc/armadra.v1.` 一个字节都不用动。
 */

export const RPC_PREFIX = "/rpc/armadra.v1.AutomationService/";

/** 少一个，自动化面板就断在那一步。 */
export const RPC_METHODS = [
  "DefineCommandSession",
  "ListCommandSessions",
  "Define",
  "GetPayload",
  "Activate",
  "Pause",
  "RunNow",
  "ListPlans",
  "ListRuns",
] as const;

/** 只改状态的那些方法要 CSRF；读不要。和 Host 的 `mutation` 标记一致。 */
const MUTATIONS = new Set<string>([
  "DefineCommandSession",
  "Define",
  "Activate",
  "Pause",
  "RunNow",
]);

export interface AutomationRpcOptions {
  readonly service: ScheduleService;
  readonly identity: IdentityService;
}

interface Failure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** 域内失败 → 这一面的错误码。`UNKNOWN` 不在这张表里：它不是一次可以分类的失败。 */
export function rpcFailure(error: unknown): Failure {
  // 认证失败照身份域自己的分档回答：页面在 401 上轮转重试、在 403 上不重试，
  // 两者合并成一个「认证失败」它就只能无限重试了。
  if (isIdentityError(error)) return identityFailure(error);
  if (error instanceof ScheduleError) {
    switch (error.code) {
      case "invalid":
      case "receipt":
        return {
          status: 400,
          code: "INVALID_ARGUMENT",
          message: error.message,
        };
      case "authorization":
        return {
          status: 403,
          code: "PERMISSION_DENIED",
          message: error.message,
        };
      case "unsupported":
        return { status: 400, code: "UNSUPPORTED", message: error.message };
      case "conflict":
        return { status: 409, code: "CONFLICT", message: error.message };
      case "notFound":
        return { status: 404, code: "NOT_FOUND", message: error.message };
    }
  }
  return {
    status: 500,
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  };
}

export class AutomationRpc {
  constructor(private readonly options: AutomationRpcOptions) {}

  async handle(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    const method = request.path.slice(RPC_PREFIX.length);
    if (request.method === "OPTIONS") {
      this.preflight(response, cors, header(request, "origin"));
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
    if (!acceptable(request)) {
      this.fail(response, cors, {
        status: 415,
        code: "INVALID_ARGUMENT",
        message: "A Protobuf request is required",
      });
      return;
    }
    try {
      await this.dispatch(request, response, cors, method);
    } catch (error) {
      this.fail(response, cors, rpcFailure(error));
    }
  }

  /**
   * 会话 → 调用方。
   *
   * 工作空间来自请求自己的 `meta.scope`，但**授权位来自会话**：一个请求可以说它
   * 想操作哪个工作空间，不能说它有什么权限。
   */
  private caller(
    request: CoreRequest,
    workspaceId: string,
    csrf: boolean,
  ): Caller {
    const hostId = this.options.identity.hostId();
    const origin = header(request, "origin");
    if (origin === undefined) {
      throw new ScheduleError("authorization", "这次调用没有报来源");
    }
    const principal = this.options.identity.authenticate({
      accessToken: bearerCredential(request),
      hostId,
      origin,
      requireCsrf: csrf,
      csrfToken: header(request, "x-armadra-csrf") ?? "",
    });
    return {
      principalId: principal.principalId,
      deviceId: principal.deviceId,
      deviceEpoch: principal.deviceEpoch,
      workspaceId,
      scopes: principal.scopes,
    };
  }

  private async dispatch(
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
    method: string,
  ): Promise<void> {
    const csrf = MUTATIONS.has(method);
    const service = this.options.service;
    switch (method) {
      case "DefineCommandSession": {
        const input = fromBinary(
          DefineCommandSessionRequestSchema,
          request.body,
        );
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const record = service.defineCommandSession(
          caller,
          input.sessionId,
          input.rootPath,
          input.launch ?? create(CommandLaunchSpecSchema, {}),
        );
        this.proto(
          response,
          cors,
          AutomationCommandSessionSchema,
          sessionMessage(record, input.rootPath),
        );
        return;
      }
      case "ListCommandSessions": {
        const input = fromBinary(
          ListCommandSessionsRequestSchema,
          request.body,
        );
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const page = service.listCommandSessions(
          caller,
          input.afterId,
          input.limit,
        );
        this.proto(
          response,
          cors,
          ListCommandSessionsResponseSchema,
          create(ListCommandSessionsResponseSchema, {
            sessions: page.sessions.map((record) =>
              sessionMessage(record, page.rootPaths.get(record.rootId) ?? ""),
            ),
            nextId: page.nextId,
            hasMore: page.hasMore,
          }),
        );
        return;
      }
      case "Define": {
        const input = fromBinary(DefineAutomationRequestSchema, request.body);
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const snapshot = await service.define(
          caller,
          input.planId,
          input.config ?? emptyConfig(),
          input.payload,
          num(input.expectedRevision),
        );
        this.plan(response, cors, service, snapshot);
        return;
      }
      case "GetPayload": {
        const input = fromBinary(
          GetAutomationPayloadRequestSchema,
          request.body,
        );
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const payload = service.payload(caller, input.planId);
        this.proto(
          response,
          cors,
          GetAutomationPayloadResponseSchema,
          create(GetAutomationPayloadResponseSchema, {
            planId: input.planId,
            payload,
            payloadSha256: digestOf(payload),
          }),
        );
        return;
      }
      case "Activate": {
        const input = fromBinary(ActivateAutomationRequestSchema, request.body);
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const snapshot = await service.activate(
          caller,
          input.planId,
          num(input.expectedRevision),
          num(input.configVersion),
          input.configSha256,
        );
        this.plan(response, cors, service, snapshot);
        return;
      }
      case "Pause": {
        const input = fromBinary(PauseAutomationRequestSchema, request.body);
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const snapshot = await service.pause(
          caller,
          input.planId,
          num(input.expectedRevision),
        );
        this.plan(response, cors, service, snapshot);
        return;
      }
      case "RunNow": {
        const input = fromBinary(RunAutomationNowRequestSchema, request.body);
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const snapshot = await service.runNow(
          caller,
          input.planId,
          num(input.expectedRevision),
        );
        this.proto(
          response,
          cors,
          AutomationRunSnapshotSchema,
          create(AutomationRunSnapshotSchema, {
            run: snapshot.run,
            revision: big(snapshot.revision),
          }),
        );
        return;
      }
      case "ListPlans": {
        const input = fromBinary(
          ListAutomationPlansRequestSchema,
          request.body,
        );
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const page = service.listPlans(caller, input.afterId, input.limit);
        this.proto(
          response,
          cors,
          ListAutomationPlansResponseSchema,
          create(ListAutomationPlansResponseSchema, {
            plans: page.plans.map((snapshot) =>
              create(AutomationPlanSnapshotSchema, {
                plan: snapshot.plan,
                revision: big(snapshot.revision),
                configSha256: service.configDigest(snapshot),
              }),
            ),
            nextId: page.nextId,
            hasMore: page.hasMore,
          }),
        );
        return;
      }
      case "ListRuns": {
        const input = fromBinary(ListAutomationRunsRequestSchema, request.body);
        const caller = this.caller(request, workspaceOf(input.meta), csrf);
        const page = service.listRuns(
          caller,
          input.planId,
          input.afterId,
          input.limit,
        );
        this.proto(
          response,
          cors,
          ListAutomationRunsResponseSchema,
          create(ListAutomationRunsResponseSchema, {
            runs: page.runs.map((snapshot) =>
              create(AutomationRunSnapshotSchema, {
                run: snapshot.run,
                revision: big(snapshot.revision),
              }),
            ),
            nextId: page.nextId,
            hasMore: page.hasMore,
          }),
        );
        return;
      }
      default:
        this.fail(response, cors, {
          status: 404,
          code: "NOT_FOUND",
          message: "No such method",
        });
    }
  }

  private plan(
    response: ServerResponse,
    cors: Record<string, string>,
    service: ScheduleService,
    snapshot: PlanSnapshot,
  ): void {
    this.proto(
      response,
      cors,
      AutomationPlanSnapshotSchema,
      create(AutomationPlanSnapshotSchema, {
        plan: snapshot.plan,
        revision: big(snapshot.revision),
        configSha256: service.configDigest(snapshot),
      }),
    );
  }

  private proto(
    response: ServerResponse,
    cors: Record<string, string>,
    schema: Parameters<typeof toBinary>[0],
    message: Parameters<typeof toBinary>[1],
    status = 200,
  ): void {
    const payload = Buffer.from(toBinary(schema, message));
    response.writeHead(status, {
      ...cors,
      "content-type": MEDIA_TYPE,
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  }

  private fail(
    response: ServerResponse,
    cors: Record<string, string>,
    failure: Failure,
  ): void {
    this.proto(
      response,
      cors,
      ErrorResponseSchema,
      create(ErrorResponseSchema, {
        code: failure.code,
        message: failure.message,
      }),
      failure.status,
    );
  }

  /** 和身份面同一套：只放行这一面真的会用到的那几个头。 */
  private preflight(
    response: ServerResponse,
    cors: Record<string, string>,
    origin: string | undefined,
  ): void {
    if (origin === undefined) {
      this.fail(response, cors, {
        status: 403,
        code: "PERMISSION_DENIED",
        message: "Device permission or CSRF check failed",
      });
      return;
    }
    response.writeHead(204, {
      ...cors,
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers":
        "Content-Type, Accept, X-Armadra-CSRF, Authorization",
      vary: "Access-Control-Request-Method, Access-Control-Request-Headers, Origin",
    });
    response.end();
  }
}

/* --------------------------------- 小工具 --------------------------------- */

function header(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function acceptable(request: CoreRequest): boolean {
  const encoding = header(request, "content-encoding");
  if (encoding !== undefined && encoding !== "identity") return false;
  const type = header(request, "content-type");
  return type?.split(";", 1)[0]?.trim().toLowerCase() === MEDIA_TYPE;
}

function workspaceOf(
  meta: { scope?: { workspaceId: string } } | undefined,
): string {
  return meta?.scope?.workspaceId ?? "";
}

function emptyConfig(): never {
  throw new ScheduleError("invalid", "请求里没有配置");
}

function digestOf(payload: Uint8Array): Uint8Array {
  // 载荷的引用就是它的摘要，所以这里重算一次而不是从计划里抄：抄下来的那个可能
  // 描述的是另一串字节。
  return createHash("sha256").update(payload).digest();
}

export function sessionMessage(record: CommandSessionRecord, rootPath: string) {
  return create(AutomationCommandSessionSchema, {
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    executionHostId: record.executionHostId,
    rootPath,
    launch: record.launch,
    generation: big(record.generation),
    launchSha256: record.launchSha256,
    state:
      record.state === COMMAND_SESSION_READY
        ? AutomationCommandSessionState.READY
        : AutomationCommandSessionState.UNREBUILDABLE,
    reasonCode: record.reasonCode,
    revision: big(record.revision),
    createdAtUnixMs: big(record.createdAtMs),
    updatedAtUnixMs: big(record.updatedAtMs),
  });
}
