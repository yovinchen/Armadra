import type { ServerResponse } from "node:http";
import {
  AutomationPlanConfigSchema,
  type AutomationPlan,
  type AutomationRun,
  fromBinary,
} from "@armadra/protocol";

import type { CoreRequest } from "../http/router";
import type { IdentityService } from "../identity/service";
import { bearerCredential } from "../identity/http";
import { identityFailure, isIdentityError } from "../identity/errors";
import { ScheduleError, num } from "./plan";
import type { PlanSnapshot, RunSnapshot } from "./engine";
import { type Caller, ScheduleService } from "./service";

/**
 * 自动化的 **新面**：`/api/automations/*`，JSON，`{ code, message }` 的错误信封。
 *
 * 设计 D9 里前端最终要收到的那一套。这一批 `apps/web` 一行不改，所以真正在用的
 * 还是隔壁 `rpc.ts` 的兼容面；这一面先落地，前端改打 `/api/` 的那一批就不必同时
 * 动两端。
 *
 * 形状直接从 protobuf 的消息对象转出来，不另手写一套 DTO：两面因此描述的是同
 * 一份记录，不会有一天多出一个只在其中一面出现的字段。`int64` 转成字符串，那是
 * JSON 里表示 64 位整数的唯一诚实做法——`number` 在 2^53 之上会悄悄改值。
 *
 * 写入那一侧收的是 **protobuf 编码后的 base64**（`configBase64` / `launchBase64`）
 * 而不是一份 JSON 配置：`@armadra/protocol` 今天没有把 `fromJson` 再导出来，手写
 * 一个 JSON → 配置的转换等于把这个文件开头反对的那件事做一遍。前端改打 `/api/`
 * 的那一批把 JSON 映射导出来之后，这里换成一行。
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
            configBase64?: string;
            payloadBase64?: string;
            expectedRevision?: number;
          }>();
          const snapshot = await service.define(
            caller(true),
            body.planId ?? "",
            fromBinary(
              AutomationPlanConfigSchema,
              Buffer.from(body.configBase64 ?? "", "base64"),
            ),
            Buffer.from(body.payloadBase64 ?? "", "base64"),
            Number(body.expectedRevision ?? 0),
          );
          return planJson(service, snapshot);
        },
      },
      {
        method: "GET",
        pattern: /^\/api\/automations\/plans\/(?<planId>[^/]+)\/payload$/,
        handler: (_request, caller, groups) => ({
          planId: groups.planId,
          payloadBase64: Buffer.from(
            service.payload(caller(false), groups.planId as string),
          ).toString("base64"),
        }),
      },
      {
        method: "POST",
        pattern: /^\/api\/automations\/plans\/(?<planId>[^/]+)\/activate$/,
        handler: async (request, caller, groups) => {
          const body = request.json<{
            expectedRevision?: number;
            configVersion?: number;
            configSha256Base64?: string;
          }>();
          const snapshot = await service.activate(
            caller(true),
            groups.planId as string,
            Number(body.expectedRevision ?? 0),
            Number(body.configVersion ?? 0),
            Buffer.from(body.configSha256Base64 ?? "", "base64"),
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
          return {
            sessions: page.sessions.map((record) => ({
              sessionId: record.sessionId,
              workspaceId: record.workspaceId,
              executionHostId: record.executionHostId,
              rootPath: page.rootPaths.get(record.rootId) ?? "",
              generation: record.generation,
              state: record.state,
              reasonCode: record.reasonCode,
              revision: record.revision,
              createdAtMs: record.createdAtMs,
              updatedAtMs: record.updatedAtMs,
            })),
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
            launchBase64?: string;
          }>();
          const record = service.defineCommandSession(
            caller(true),
            body.sessionId ?? "",
            body.rootPath ?? "",
            Buffer.from(body.launchBase64 ?? "", "base64"),
          );
          return {
            sessionId: record.sessionId,
            generation: record.generation,
            revision: record.revision,
          };
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
    const principal = this.options.identity.authenticate({
      accessToken: bearerCredential(request),
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

function planJson(service: ScheduleService, snapshot: PlanSnapshot): unknown {
  return {
    plan: messageJson(snapshot.plan),
    revision: snapshot.revision,
    configSha256Base64: Buffer.from(service.configDigest(snapshot)).toString(
      "base64",
    ),
  };
}

function runJson(snapshot: RunSnapshot): unknown {
  return { run: messageJson(snapshot.run), revision: snapshot.revision };
}

/**
 * 消息对象 → JSON。
 *
 * `bigint` 转字符串，`Uint8Array` 转 base64，`$typeName` 去掉（它是运行时的
 * 类型标记，不是记录的一部分）。其余原样——字段名本来就是 camelCase。
 */
function messageJson(message: AutomationPlan | AutomationRun): unknown {
  return plainJson(message);
}

function plainJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(plainJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$typeName" || key === "$unknown") continue;
      out[key] = plainJson(entry);
    }
    return out;
  }
  return value;
}

export { num };
