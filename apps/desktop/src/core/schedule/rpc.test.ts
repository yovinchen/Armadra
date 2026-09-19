/**
 * 兼容面：`packages/host-client` 今天发什么，这一面就得答什么。
 *
 * 用例自己拼 protobuf 字节，用的是**客户端用的那些同一个 schema**——
 * `HostAutomationClient` 不是 `@armadra/desktop` 的依赖（它活到 R7 就删了，不值
 * 得为一个用例把它拉进来），而消息形状本身就是契约，字节对上了这一面就对上了。
 *
 * 对着的是 `apps/host/internal/automationhost/service_test.go` 的那一组：授权
 * 位、执行主机隔离、载荷的引用由服务端说了算、修订号冲突、分页。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ActivateAutomationRequestSchema,
  AutomationPlanConfigSchema,
  AutomationPlanSnapshotSchema,
  AutomationPlanState,
  AutomationRunSnapshotSchema,
  AutomationTargetKind,
  ErrorResponseSchema,
  DefineAutomationRequestSchema,
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
import { afterEach, describe, expect, it } from "vitest";

import { type OpenedDatabase, openDatabase } from "../db/open";
import { allScopes, scope, type Scope } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { ScheduleEngine } from "./engine";
import { FakeDispatcher } from "./fixture";
import { AutomationRpc, RPC_METHODS } from "./rpc";
import { ScheduleService } from "./service";
import { ScheduleStore } from "./store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const ORIGIN = "http://127.0.0.1:1420";
const INSTANCE = "0123456789abcdef0123456789abcdef";
const PROMPT = new TextEncoder().encode("跑一次检查");

/** 只改状态的方法要 CSRF，读不要——和客户端的 `mutation` 标记一致。 */
const MUTATIONS = new Set([
  "DefineCommandSession",
  "Define",
  "Activate",
  "Pause",
  "RunNow",
]);

const closing: (() => void)[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 一次调用的结果：要么是字节，要么是这一面报的错误码。 */
interface Answer {
  readonly status: number;
  readonly wire: Buffer;
  readonly code: string;
}

interface Fixture {
  readonly hostId: string;
  readonly service: ScheduleService;
  call(action: string, body: Uint8Array): Promise<Answer>;
}

function setUp(options: { scopes?: readonly Scope[] } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "armadra-automation-"));
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
    scopes: options.scopes ?? allScopes(),
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
  const rpc = new AutomationRpc({ service, identity });

  return {
    hostId,
    service,
    async call(action, body) {
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
      await rpc.handle(
        {
          method: "POST",
          path: `/rpc/armadra.v1.AutomationService/${action}`,
          query: new URLSearchParams(),
          headers: {
            origin: ORIGIN,
            "content-type": "application/x-protobuf",
            authorization: `Bearer ${credentials.accessToken}`,
            ...(MUTATIONS.has(action)
              ? { "x-armadra-csrf": credentials.csrfToken }
              : {}),
          },
          body: Buffer.from(body),
          raw: { socket: {} } as never,
          json: () => null as never,
        },
        response as never,
        {},
      );
      const wire = Buffer.concat(chunks);
      return {
        status,
        wire,
        code: status === 200 ? "" : fromBinary(ErrorResponseSchema, wire).code,
      };
    },
  };
}

function meta(hostId: string, workspaceId = "ws") {
  return {
    requestId: "r1",
    scope: { hostId, workspaceId, executionHostId: hostId },
  };
}

function planConfig(hostId: string) {
  return create(AutomationPlanConfigSchema, {
    workspaceId: "ws",
    title: "每天九点跑一次",
    schedule: {
      kind: {
        case: "cron",
        value: { expression: "0 9 * * *", timezone: "UTC" },
      },
    },
    target: {
      executionHostId: hostId,
      kind: AutomationTargetKind.AGENT_SESSION_PROMPT,
      nodeId: "node-1",
      agentLaunch: { agentId: "claude", accountId: "default" },
    },
    // 引用与摘要由服务端说了算，客户端写什么都被覆盖。
    payloadRef: "客户端瞎写的",
    payloadSha256: new Uint8Array(32),
  });
}

async function define(
  fixture: Fixture,
  expectedRevision = 0n,
  hostId?: string,
) {
  const answer = await fixture.call(
    "Define",
    toBinary(
      DefineAutomationRequestSchema,
      create(DefineAutomationRequestSchema, {
        meta: meta(fixture.hostId),
        planId: "p1",
        config: planConfig(hostId ?? fixture.hostId),
        payload: PROMPT,
        expectedRevision,
      }),
    ),
  );
  return answer;
}

describe("自动化兼容面", () => {
  it("九个方法一个不少", () => {
    expect([...RPC_METHODS]).toHaveLength(9);
    expect([...RPC_METHODS]).toContain("GetPayload");
  });

  it("列表、新建、激活、运行记录走的是同一条链", async () => {
    const fixture = setUp();
    const listed = await fixture.call(
      "ListPlans",
      toBinary(
        ListAutomationPlansRequestSchema,
        create(ListAutomationPlansRequestSchema, {
          meta: meta(fixture.hostId),
          limit: 50,
        }),
      ),
    );
    expect(listed.status).toBe(200);
    expect(
      fromBinary(ListAutomationPlansResponseSchema, listed.wire).plans,
    ).toHaveLength(0);

    const defined = await define(fixture);
    expect(defined.status).toBe(200);
    const snapshot = fromBinary(AutomationPlanSnapshotSchema, defined.wire);
    expect(snapshot.plan?.state).toBe(AutomationPlanState.DRAFT);
    // 引用就是载荷的摘要，客户端写的那串被覆盖了。
    expect(snapshot.plan?.config?.payloadRef).toBe(
      createHash("sha256").update(PROMPT).digest("hex"),
    );
    expect(snapshot.configSha256).toHaveLength(32);

    const activated = await fixture.call(
      "Activate",
      toBinary(
        ActivateAutomationRequestSchema,
        create(ActivateAutomationRequestSchema, {
          meta: meta(fixture.hostId),
          planId: "p1",
          configVersion: snapshot.plan!.configVersion,
          configSha256: snapshot.configSha256,
          expectedRevision: snapshot.revision,
        }),
      ),
    );
    expect(activated.status).toBe(200);
    const active = fromBinary(AutomationPlanSnapshotSchema, activated.wire);
    expect(active.plan?.state).toBe(AutomationPlanState.ACTIVE);

    const ran = await fixture.call(
      "RunNow",
      toBinary(
        RunAutomationNowRequestSchema,
        create(RunAutomationNowRequestSchema, {
          meta: meta(fixture.hostId),
          planId: "p1",
          expectedRevision: active.revision,
        }),
      ),
    );
    expect(ran.status).toBe(200);
    const run = fromBinary(AutomationRunSnapshotSchema, ran.wire);
    expect(run.run?.reasonCode).toBe("MANUAL_RUN");

    const runs = await fixture.call(
      "ListRuns",
      toBinary(
        ListAutomationRunsRequestSchema,
        create(ListAutomationRunsRequestSchema, {
          meta: meta(fixture.hostId),
          planId: "p1",
          limit: 25,
        }),
      ),
    );
    const history = fromBinary(ListAutomationRunsResponseSchema, runs.wire);
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]?.run?.id).toBe(run.run?.id);

    // 读回定义时用的那份提示词：编辑表单靠它起步，否则要么让人重打一遍，要么
    // 悄悄把计划改成什么都不输入。
    const payload = await fixture.call(
      "GetPayload",
      toBinary(
        GetAutomationPayloadRequestSchema,
        create(GetAutomationPayloadRequestSchema, {
          meta: meta(fixture.hostId),
          planId: "p1",
        }),
      ),
    );
    expect(
      new Uint8Array(
        fromBinary(GetAutomationPayloadResponseSchema, payload.wire).payload,
      ),
    ).toEqual(PROMPT);

    const paused = await fixture.call(
      "Pause",
      toBinary(
        PauseAutomationRequestSchema,
        create(PauseAutomationRequestSchema, {
          meta: meta(fixture.hostId),
          planId: "p1",
          expectedRevision: BigInt(
            fixture.service.engine.getPlan("ws", "p1").revision,
          ),
        }),
      ),
    );
    expect(
      fromBinary(AutomationPlanSnapshotSchema, paused.wire).plan?.state,
    ).toBe(AutomationPlanState.PAUSED);
  });

  it("只有读授权的设备改不动计划，但读得到", async () => {
    const fixture = setUp({ scopes: [scope("automation:read")] });
    const defined = await define(fixture);
    expect(defined.code).toBe("PERMISSION_DENIED");
    const listed = await fixture.call(
      "ListPlans",
      toBinary(
        ListAutomationPlansRequestSchema,
        create(ListAutomationPlansRequestSchema, {
          meta: meta(fixture.hostId),
          limit: 10,
        }),
      ),
    );
    expect(listed.status).toBe(200);
  });

  it("修订号对不上报冲突，页面据此重新载入", async () => {
    const fixture = setUp();
    const defined = await define(fixture);
    const snapshot = fromBinary(AutomationPlanSnapshotSchema, defined.wire);
    const activated = await fixture.call(
      "Activate",
      toBinary(
        ActivateAutomationRequestSchema,
        create(ActivateAutomationRequestSchema, {
          meta: meta(fixture.hostId),
          planId: "p1",
          configVersion: snapshot.plan!.configVersion,
          configSha256: snapshot.configSha256,
          // 手里拿着一个别人已经改过的修订号。
          expectedRevision: 9n,
        }),
      ),
    );
    expect(activated.code).toBe("CONFLICT");
  });

  it("指向另一台执行主机的计划报不支持", async () => {
    const fixture = setUp();
    const answer = await define(fixture, 0n, "0".repeat(32));
    expect(answer.code).toBe("UNSUPPORTED");
  });

  it("找不到的计划报 NOT_FOUND，不是一份空数据", async () => {
    const fixture = setUp();
    const answer = await fixture.call(
      "GetPayload",
      toBinary(
        GetAutomationPayloadRequestSchema,
        create(GetAutomationPayloadRequestSchema, {
          meta: meta(fixture.hostId),
          planId: "nope",
        }),
      ),
    );
    expect(answer.code).toBe("NOT_FOUND");
  });

  it("不认识的方法是 NOT_FOUND，不是一次静默的 200", async () => {
    const fixture = setUp();
    const answer = await fixture.call("Explode", new Uint8Array());
    expect(answer.code).toBe("NOT_FOUND");
  });

  it("命令会话列表空着也能读", async () => {
    const fixture = setUp();
    const answer = await fixture.call(
      "ListCommandSessions",
      toBinary(
        ListCommandSessionsRequestSchema,
        create(ListCommandSessionsRequestSchema, {
          meta: meta(fixture.hostId),
          limit: 50,
        }),
      ),
    );
    const page = fromBinary(ListCommandSessionsResponseSchema, answer.wire);
    expect(page.sessions).toHaveLength(0);
    expect(page.hasMore).toBe(false);
  });
});
