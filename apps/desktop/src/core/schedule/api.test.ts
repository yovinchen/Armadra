/**
 * 自动化的 JSON 面：`apps/web/src/api/automations.ts` 今天打的就是它。
 *
 * 测的不是调度逻辑（那在 `engine.test.ts` 里），而是**这一面说得对**：每条路由
 * 的形状、错误码、写入侧收的是普通 JSON 而不是 base64 protobuf，以及两张面对同
 * 一条记录说的是同一句话。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AutomationPlanSnapshotSchema,
  ListAutomationPlansRequestSchema,
  ListAutomationPlansResponseSchema,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { type OpenedDatabase, openDatabase } from "../db/open";
import { allScopes } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { AutomationApi } from "./api";
import { ScheduleEngine } from "./engine";
import { FakeDispatcher } from "./fixture";
import { AutomationRpc } from "./rpc";
import { ScheduleService } from "./service";
import { ScheduleStore } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const ORIGIN = "http://127.0.0.1:1420";
const INSTANCE = "0123456789abcdef0123456789abcdef";

const closing: (() => void)[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Fixture {
  readonly hostId: string;
  /** 带凭据的一次调用。 */
  call(
    method: string,
    path: string,
    body?: unknown,
    options?: { anonymous?: boolean },
  ): Promise<Answer>;
  /** 同一批数据在兼容面上的样子。 */
  rpc(action: string, body: Uint8Array): Promise<Buffer>;
}

function setUp(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "armadra-automation-api-"));
  directories.push(directory);
  const opened: OpenedDatabase = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  const identityStore = new IdentityStore(opened.database);
  const identity = new IdentityService(identityStore, INSTANCE);
  const hostId = identityStore.hostId();
  const ticket = identity.issueBootstrap({
    hostId,
    instanceId: INSTANCE,
    origin: ORIGIN,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const credentials = identity.consumeBootstrap({
    ticket: ticket.ticket,
    hostId,
    instanceId: INSTANCE,
    origin: ORIGIN,
  });

  const store = new ScheduleStore(opened.database);
  const authority: { service?: ScheduleService } = {};
  const engine = new ScheduleEngine({
    store,
    dispatcher: new FakeDispatcher(),
    authorizer: {
      verify: async (authorization, config) => {
        await authority.service?.verify(authorization, config);
      },
    },
    hostId,
    instanceId: "instance-1",
  });
  const service = new ScheduleService({
    store,
    engine,
    identity: identityStore,
    hostId,
    generationOf: () => 7,
  });
  authority.service = service;
  const api = new AutomationApi({ service, identity });
  const rpc = new AutomationRpc({ service, identity });

  async function drive(
    handler: {
      handle(
        request: never,
        response: never,
        cors: Record<string, string>,
      ): Promise<void>;
    },
    request: Record<string, unknown>,
  ): Promise<{ status: number; wire: Buffer }> {
    const chunks: Buffer[] = [];
    let status = 200;
    const response = {
      writeHead(code: number) {
        status = code;
        return response;
      },
      end(payload?: Buffer) {
        if (payload) chunks.push(payload);
      },
      setHeader() {},
    };
    await handler.handle(request as never, response as never, {});
    return { status, wire: Buffer.concat(chunks) };
  }

  return {
    hostId,
    async call(method, path, body, options = {}) {
      const [pathname, search = ""] = path.split("?");
      const text = body === undefined ? "" : JSON.stringify(body);
      const result = await drive(api, {
        method,
        path: pathname,
        query: new URLSearchParams(search),
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...(options.anonymous
            ? {}
            : {
                authorization: `Bearer ${credentials.accessToken}`,
                "x-armadra-csrf": credentials.csrfToken,
              }),
        },
        body: Buffer.from(text, "utf8"),
        raw: { socket: {} },
        json: () => (text === "" ? {} : JSON.parse(text)),
      });
      return {
        status: result.status,
        body:
          result.wire.byteLength === 0
            ? {}
            : (JSON.parse(result.wire.toString("utf8")) as Record<
                string,
                unknown
              >),
      };
    },
    async rpc(action, body) {
      const result = await drive(rpc, {
        method: "POST",
        path: `/rpc/armadra.v1.AutomationService/${action}`,
        query: new URLSearchParams(),
        headers: {
          origin: ORIGIN,
          "content-type": "application/x-protobuf",
          authorization: `Bearer ${credentials.accessToken}`,
          "x-armadra-csrf": credentials.csrfToken,
        },
        body: Buffer.from(body),
        raw: { socket: {} },
        json: () => null,
      });
      return result.wire;
    },
  };
}

/** 一份最小的合法配置，写成这一面收的那种普通 JSON。 */
function planConfigJson(hostId: string): Record<string, unknown> {
  return {
    workspaceId: "ws",
    title: "每天九点跑一次",
    // `oneof` 摊平成那一个被设置的字段，但它仍然在 `schedule` 这个消息里面。
    schedule: { cron: { expression: "0 9 * * *", timezone: "UTC" } },
    target: {
      executionHostId: hostId,
      kind: "AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT",
      nodeId: "node-1",
      agentLaunch: { agentId: "claude", accountId: "default" },
    },
    misfirePolicy: "AUTOMATION_MISFIRE_POLICY_SKIP",
    concurrencyPolicy: "AUTOMATION_CONCURRENCY_POLICY_FORBID",
    misfireGraceMs: "60000",
    busyTtlMs: "60000",
  };
}

async function definePlan(fixture: Fixture): Promise<Answer> {
  return fixture.call("POST", "/api/automations/plans?workspaceId=ws", {
    planId: "plan-1",
    config: planConfigJson(fixture.hostId),
    payload: "跑一次检查",
    expectedRevision: 0,
  });
}

describe("自动化的 JSON 面", () => {
  it("写入侧收普通 JSON 配置与 UTF-8 载荷，不再是 base64 protobuf", async () => {
    const fixture = setUp();
    const defined = await definePlan(fixture);
    expect(defined.status).toBe(200);
    const snapshot = defined.body as {
      plan: Record<string, unknown>;
      revision: number;
      configSha256: string;
    };
    expect(snapshot.revision).toBe(1);
    expect(snapshot.plan.id).toBe("plan-1");
    // `int64` 是十进制字符串，枚举是枚举值名，零值照写。
    expect(snapshot.plan.state).toBe("AUTOMATION_PLAN_STATE_DRAFT");
    expect(typeof snapshot.plan.createdAtUnixMs).toBe("string");
    expect(snapshot.plan).toHaveProperty("needsAttention", false);
    // 摘要是 base64，长度就是 32 字节的那一串。
    expect(Buffer.from(snapshot.configSha256, "base64")).toHaveLength(32);

    // 载荷读回来是原文，不是 base64。
    const payload = await fixture.call(
      "GET",
      "/api/automations/plans/plan-1/payload?workspaceId=ws",
    );
    expect(payload.status).toBe(200);
    expect(payload.body.payload).toBe("跑一次检查");
  });

  it("列表、激活、暂停、运行历史各答自己的形状", async () => {
    const fixture = setUp();
    const defined = await definePlan(fixture);
    const snapshot = defined.body as {
      plan: { configVersion: string };
      configSha256: string;
    };

    const listed = await fixture.call(
      "GET",
      "/api/automations/plans?workspaceId=ws&limit=10",
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ hasMore: false });
    expect((listed.body.plans as unknown[]).length).toBe(1);

    const activated = await fixture.call(
      "POST",
      "/api/automations/plans/plan-1/activate?workspaceId=ws",
      {
        expectedRevision: 1,
        configVersion: Number(snapshot.plan.configVersion),
        configSha256: snapshot.configSha256,
      },
    );
    expect(activated.status).toBe(200);
    expect((activated.body.plan as Record<string, unknown>).state).toBe(
      "AUTOMATION_PLAN_STATE_ACTIVE",
    );

    const paused = await fixture.call(
      "POST",
      "/api/automations/plans/plan-1/pause?workspaceId=ws",
      { expectedRevision: 2 },
    );
    expect(paused.status).toBe(200);
    expect((paused.body.plan as Record<string, unknown>).state).toBe(
      "AUTOMATION_PLAN_STATE_PAUSED",
    );

    const runs = await fixture.call(
      "GET",
      "/api/automations/plans/plan-1/runs?workspaceId=ws",
    );
    expect(runs.status).toBe(200);
    expect(runs.body).toMatchObject({ runs: [], hasMore: false });
  });

  it("摘要对不上就是 conflict，而不是一次悄悄的激活", async () => {
    const fixture = setUp();
    await definePlan(fixture);
    const refused = await fixture.call(
      "POST",
      "/api/automations/plans/plan-1/activate?workspaceId=ws",
      {
        expectedRevision: 1,
        configVersion: 1,
        configSha256: Buffer.alloc(32).toString("base64"),
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("conflict");
    expect(typeof refused.body.message).toBe("string");
  });

  it("读不出来的配置是 bad_request，不是一个空计划", async () => {
    const fixture = setUp();
    const refused = await fixture.call(
      "POST",
      "/api/automations/plans?workspaceId=ws",
      { planId: "plan-1", config: { schedule: 7 }, expectedRevision: 0 },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("bad_request");
  });

  it("没有这条路由就是 not_found", async () => {
    const fixture = setUp();
    const missing = await fixture.call(
      "GET",
      "/api/automations/nowhere?workspaceId=ws",
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");
  });

  it("明文回环上没带凭据按本机主人算，其余照常认证", async () => {
    const fixture = setUp();
    const anonymous = await fixture.call(
      "GET",
      "/api/automations/plans?workspaceId=ws",
      undefined,
      { anonymous: true },
    );
    // 壳与 core 在同一台机器上，页面手上没有会话密钥：这条路存在，否则面板打不开。
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toMatchObject({ plans: [], hasMore: false });
  });

  it("两张面对同一个计划说同一句话", async () => {
    const fixture = setUp();
    const defined = await definePlan(fixture);
    const viaJson = defined.body as { plan: Record<string, unknown> };

    const listed = fromBinary(
      ListAutomationPlansResponseSchema,
      await fixture.rpc(
        "ListPlans",
        toBinary(
          ListAutomationPlansRequestSchema,
          create(ListAutomationPlansRequestSchema, {
            meta: {
              requestId: "r1",
              scope: {
                hostId: fixture.hostId,
                workspaceId: "ws",
                executionHostId: fixture.hostId,
              },
            },
            limit: 10,
          }),
        ),
      ),
    );
    const viaRpc = listed.plans[0];
    expect(viaRpc?.plan?.id).toBe(viaJson.plan.id);
    expect(String(viaRpc?.plan?.createdAtUnixMs)).toBe(
      viaJson.plan.createdAtUnixMs,
    );
    expect(viaRpc?.plan?.config?.title).toBe(
      (viaJson.plan.config as Record<string, unknown>).title,
    );
    // 摘要也是同一个数：两张面读的是同一份规范 JSON。
    expect(
      Buffer.from(viaRpc?.configSha256 ?? new Uint8Array()).toString("base64"),
    ).toBe((defined.body as { configSha256: string }).configSha256);
    void AutomationPlanSnapshotSchema;
  });
});
