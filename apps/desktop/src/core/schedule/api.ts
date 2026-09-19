import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import type {
  AutomationPlanConfig,
  CommandLaunchSpec,
} from "@armadra/protocol";

import type { CoreRequest } from "../http/router";
import type { IdentityService } from "../identity/service";
import { credential, nativeRequest } from "../identity/http";
import {
  IdentityError,
  identityFailure,
  isIdentityError,
} from "../identity/errors";
import {
  commandSessionToJson,
  launchSpecFromJson,
  planConfigFromJson,
  planToJson,
  runToJson,
} from "./json";
import { ScheduleError, num } from "./plan";
import { sessionMessage } from "./rpc";
import type { PlanSnapshot, RunSnapshot } from "./engine";
import { type Caller, ScheduleService } from "./service";

/**
 * 自动化的 JSON 面：`/api/automations/*`，错误信封 `{ code, message }`。
 *
 * 这是页面今天打的那一面（R7a）。隔壁 `rpc.ts` 的 protobuf 兼容面还在，R7 收尾
 * 删；在那之前两张面对同一条记录说的必须是同一句话，`api.test.ts` 有一条用例就
 * 是逐字段比对它们。
 *
 * 形状由 `json.ts` 决定：**库里存的和线上发的是同一份 JSON**。写入那一侧因此收
 * 的是一份普通的 JSON 配置，而不再是一段 base64 的 protobuf——0020 之前它收
 * `configBase64` / `launchBase64` / `payloadBase64`，因为那时候库里存的就是字节。
 * 逐字段的说明在 `docs/contracts/core-json-api.md` §4。
 *
 * 载荷（stdin / prompt）在线上是 **UTF-8 文本**：它是用户自己敲进去的东西，
 * base64 只会让一个人读不懂自己的计划。库里仍然是字节（§4.3）。
 */

export const API_PREFIX = "/api/automations";

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handler: (
    request: CoreRequest,
    caller: (mutation: boolean) => Caller,
    groups: Record<string, string>,
  ) => Promise<unknown> | unknown;
}

export interface AutomationApiOptions {
  readonly service: ScheduleService;
  readonly identity: IdentityService;
}

export class AutomationApi {
  private readonly routes: Route[];

  constructor(private readonly options: AutomationApiOptions) {
    const service = options.service;
    this.routes = [
      {
        method: "GET",
        pattern: /^\/api\/automations\/plans$/,
        handler: (request, caller) => {
          const page = service.listPlans(
            caller(false),
            request.query.get("after") ?? "",
            Number(request.query.get("limit") ?? 50),
          );
          return {
            plans: page.plans.map((snapshot) => planJson(service, snapshot)),
            nextId: page.nextId,
            hasMore: page.hasMore,
          };
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/automations\/plans$/,
        handler: async (request, caller) => {
          const body = request.json<{
            planId?: string;
            config?: unknown;
            payload?: string;
            expectedRevision?: number;
          }>();
          const snapshot = await service.define(
            caller(true),
            body.planId ?? "",
            configOf(body.config),
            Buffer.from(body.payload ?? "", "utf8"),
            Number(body.expectedRevision ?? 0),
          );
          return planJson(service, snapshot);
        },
      },
      {
        method: "GET",
        pattern: /^\/api\/automations\/plans\/(?<planId>[^/]+)\/payload$/,
        handler: (_request, caller, groups) => {
          const bytes = service.payload(caller(false), groups.planId as string);
          return {
            planId: groups.planId,
            payload: Buffer.from(bytes).toString("utf8"),
            payloadSha256: createHash("sha256").update(bytes).digest("base64"),
          };
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/automations\/plans\/(?<planId>[^/]+)\/activate$/,
        handler: async (request, caller, groups) => {
          const body = request.json<{
            expectedRevision?: number;
            configVersion?: number;
            configSha256?: string;
          }>();
          const snapshot = await service.activate(
            caller(true),
            groups.planId as string,
            Number(body.expectedRevision ?? 0),
            Number(body.configVersion ?? 0),
            Buffer.from(body.configSha256 ?? "", "base64"),
          );
          return planJson(service, snapshot);
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/automations\/plans\/(?<planId>[^/]+)\/pause$/,
        handler: async (request, caller, groups) => {
          const body = request.json<{ expectedRevision?: number }>();
          const snapshot = await service.pause(
            caller(true),
            groups.planId as string,
            Number(body.expectedRevision ?? 0),
          );
          return planJson(service, snapshot);
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/automations\/plans\/(?<planId>[^/]+)\/run$/,
        handler: async (request, caller, groups) => {
          const body = request.json<{ expectedRevision?: number }>();
          const snapshot = await service.runNow(
            caller(true),
            groups.planId as string,
            Number(body.expectedRevision ?? 0),
          );
          return runJson(snapshot);
        },
      },
      {
        method: "GET",
        pattern: /^\/api\/automations\/plans\/(?<planId>[^/]+)\/runs$/,
        handler: (request, caller, groups) => {
          const page = service.listRuns(
            caller(false),
            groups.planId as string,
            request.query.get("after") ?? "",
            Number(request.query.get("limit") ?? 50),
          );
          return {
            runs: page.runs.map(runJson),
            nextId: page.nextId,
            hasMore: page.hasMore,
          };
        },
      },
      {
        method: "GET",
        pattern: /^\/api\/automations\/command-sessions$/,
        handler: (request, caller) => {
          const page = service.listCommandSessions(
            caller(false),
            request.query.get("after") ?? "",
            Number(request.query.get("limit") ?? 50),
          );
          // 整条 `AutomationCommandSession`，不是它的一个摘要：新建计划的向导
          // 要按冻结的启动定义核对目标，一份少了 `launch` 的列表答不了那个问题。
          return {
            sessions: page.sessions.map((record) =>
              commandSessionToJson(
                sessionMessage(record, page.rootPaths.get(record.rootId) ?? ""),
              ),
            ),
            nextId: page.nextId,
            hasMore: page.hasMore,
          };
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/automations\/command-sessions$/,
        handler: (request, caller) => {
          const body = request.json<{
            sessionId?: string;
            rootPath?: string;
            launch?: unknown;
          }>();
          const record = service.defineCommandSession(
            caller(true),
            body.sessionId ?? "",
            body.rootPath ?? "",
            launchOf(body.launch),
          );
          return commandSessionToJson(
            sessionMessage(record, body.rootPath ?? ""),
          );
        },
      },
    ];
  }

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
    const found = this.routes.find(
      (route) =>
        route.method === request.method && route.pattern.test(request.path),
    );
    if (found === undefined) {
      this.send(response, cors, 404, {
        code: "not_found",
        message: "没有这个自动化路由",
      });
      return;
    }
    const groups =
      (found.pattern.exec(request.path)?.groups as
        | Record<string, string>
        | undefined) ?? {};
    // 工作空间跟着查询串走，授权位跟着会话走：一个请求可以说它想操作哪个工作
    // 空间，不能说它有什么权限。
    const workspaceId = request.query.get("workspaceId") ?? "";
    try {
      const body = await found.handler(
        request,
        (mutation) => this.caller(request, workspaceId, mutation),
        groups,
      );
      this.send(response, cors, 200, body);
    } catch (error) {
      const failure = apiFailure(error);
      this.send(response, cors, failure.status, {
        code: failure.code,
        message: failure.message,
      });
    }
  }

  /**
   * 这次调用背后的主体。
   *
   * 明文回环上没带凭据的一次调用按**本机主人**处理（`IdentityService.localOwner`）：
   * 页面经 `apps/web/src/api/request.ts` 打这一面，而桌面壳的会话是原生的，密钥
   * 在壳里，既不发 Cookie 也到不了那个 `fetch`。TLS 的服务器壳上这条路不存在。
   *
   * 主人也必须是一台**真设备**：自动化的授权记录要拿它的 epoch 复核，一个编出来
   * 的设备标识会让计划在第一次投递时被自己的复核拒掉。
   */
  private caller(
    request: CoreRequest,
    workspaceId: string,
    mutation: boolean,
  ): Caller {
    const hostId = this.options.identity.hostId();
    const origin = headerOf(request, "origin");
    if (origin === undefined) {
      throw new ScheduleError("authorization", "这次调用没有报来源");
    }
    const token = credential(request, hostId, "access");
    if (token === "" && nativeRequest(request)) {
      const owner = this.options.identity.localOwner();
      // 还没配过对：这是「没有会话」，不是「权限不够」——页面据此去走配对，
      // 而不是去看一块它其实有权限打开的面板。
      if (owner === undefined) throw new IdentityError("unauthenticated");
      return { ...owner, workspaceId };
    }
    const principal = this.options.identity.authenticate({
      accessToken: token,
      hostId,
      origin,
      requireCsrf: mutation,
      csrfToken: headerOf(request, "x-armadra-csrf") ?? "",
    });
    return {
      principalId: principal.principalId,
      deviceId: principal.deviceId,
      deviceEpoch: principal.deviceEpoch,
      workspaceId,
      scopes: principal.scopes,
    };
  }

  private send(
    response: ServerResponse,
    cors: Record<string, string>,
    status: number,
    body: unknown,
  ): void {
    const payload = Buffer.from(JSON.stringify(body ?? null), "utf8");
    response.writeHead(status, {
      ...cors,
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  }
}

/** 域内失败 → `{ code, message }`。code 是 snake_case，和其余 `/api/` 一致。 */
export function apiFailure(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  // 认证失败照身份域自己的分档，只是 code 换成这一面的 snake_case 拼法。
  if (isIdentityError(error)) {
    const failure = identityFailure(error);
    return {
      status: failure.status,
      code:
        failure.status === 401
          ? "unauthenticated"
          : failure.status === 403
            ? "forbidden"
            : failure.status === 404
              ? "not_found"
              : failure.status === 409
                ? "conflict"
                : "bad_request",
      message: failure.message,
    };
  }
  if (error instanceof ScheduleError) {
    switch (error.code) {
      case "invalid":
      case "receipt":
        return { status: 400, code: "bad_request", message: error.message };
      case "authorization":
        return { status: 403, code: "forbidden", message: error.message };
      case "unsupported":
        return { status: 409, code: "unsupported", message: error.message };
      case "conflict":
        return { status: 409, code: "conflict", message: error.message };
      case "notFound":
        return { status: 404, code: "not_found", message: error.message };
    }
  }
  return {
    status: 500,
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function headerOf(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function configOf(value: unknown): AutomationPlanConfig {
  try {
    return planConfigFromJson(value ?? {});
  } catch {
    throw new ScheduleError("invalid", "这份计划配置读不出来");
  }
}

function launchOf(value: unknown): CommandLaunchSpec {
  try {
    return launchSpecFromJson(value ?? {});
  } catch {
    throw new ScheduleError("invalid", "这份启动定义读不出来");
  }
}

function planJson(service: ScheduleService, snapshot: PlanSnapshot): unknown {
  return {
    plan: planToJson(snapshot.plan),
    revision: snapshot.revision,
    configSha256: Buffer.from(service.configDigest(snapshot)).toString(
      "base64",
    ),
  };
}

function runJson(snapshot: RunSnapshot): unknown {
  return { run: runToJson(snapshot.run), revision: snapshot.revision };
}

export { num };
