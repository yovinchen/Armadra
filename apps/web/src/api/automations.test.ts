/**
 * 自动化的 JSON 调用面。
 *
 * 最重要的一条：**写入侧发的是普通 JSON**，不再是 base64 的 protobuf。日程在
 * 线上是摊平的，在页面里是 `{ case, value }`，两边的来回必须是同一件事。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AutomationApi,
  AutomationApiError,
  AutomationPlanState,
  AutomationTargetKind,
  automationPlanConfig,
  automationPlanSchema,
  commandLaunchSpec,
} from "./automations";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

function serve(status: number, payload: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const config = automationPlanConfig({
  workspaceId: "ws-1",
  title: "每天九点跑一次",
  schedule: {
    kind: { case: "cron", value: { expression: "0 9 * * *", timezone: "UTC" } },
  },
  target: {
    executionHostId: "host-1",
    sessionId: "",
    generation: 0n,
    kind: AutomationTargetKind.AGENT_SESSION_PROMPT,
    nodeId: "node-1",
    coldStartPolicy: "AUTOMATION_COLD_START_POLICY_SKIP",
  },
});

describe("AutomationApi 的解析", () => {
  it("摊平的日程解回 { case, value }，bytes 解回 Uint8Array", () => {
    const plan = automationPlanSchema.parse({
      id: "plan-1",
      configVersion: "2",
      state: "AUTOMATION_PLAN_STATE_ACTIVE",
      activationSha256: btoa(""),
      nextDueUnixMs: "1788557900000",
      config: {
        workspaceId: "ws-1",
        title: "t",
        schedule: { interval: { anchorUnixMs: "1", intervalMs: "1000" } },
      },
    });
    expect(plan.state).toBe(AutomationPlanState.ACTIVE);
    expect(plan.nextDueUnixMs).toBe(1_788_557_900_000n);
    expect([...plan.activationSha256]).toEqual([1, 2]);
    const schedule = plan.config?.schedule;
    expect(schedule?.kind.case).toBe("interval");
    expect(schedule?.kind.case === "interval" && schedule.kind.value).toEqual({
      anchorUnixMs: 1n,
      intervalMs: 1000n,
    });
    // 没有日程的计划读出来是一个明确的「没有」，不是一个缺席的字段。
    expect(
      automationPlanSchema.parse({ config: { schedule: {} } }).config?.schedule
        ?.kind.case,
    ).toBeUndefined();
  });

  it("工作空间不合法的客户端建不出来", () => {
    expect(() => new AutomationApi({ workspaceId: "" })).toThrow(
      AutomationApiError,
    );
  });
});

describe("AutomationApi 的请求", () => {
  it("定义一个计划发的是普通 JSON 配置与 UTF-8 载荷", async () => {
    const calls = serve(200, {
      plan: { id: "plan-1" },
      revision: "1",
      configSha256: btoa("x".repeat(32)),
    });
    const api = new AutomationApi({ workspaceId: "ws-1" });
    const snapshot = await api.definePlan({
      planId: "plan-1",
      config,
      payload: "跑一次检查",
      expectedRevision: 0n,
    });
    expect(snapshot.revision).toBe(1n);
    expect(snapshot.plan?.id).toBe("plan-1");

    expect(calls[0]?.url).toContain("/api/automations/plans?workspaceId=ws-1");
    const sent = JSON.parse(String(calls[0]?.init?.body)) as {
      config: { schedule: Record<string, unknown>; misfireGraceMs: string };
      payload: string;
    };
    // 日程摊平回线上的形状。
    expect(sent.config.schedule).toEqual({
      cron: { expression: "0 9 * * *", timezone: "UTC" },
    });
    // `int64` 是十进制字符串，载荷是原文——不是 base64。
    expect(sent.config.misfireGraceMs).toBe("0");
    expect(sent.payload).toBe("跑一次检查");
    expect(String(calls[0]?.init?.body)).not.toContain("configBase64");
  });

  it("激活要求一个 32 字节的摘要，短了就在发出去之前被拒", async () => {
    serve(200, {});
    const api = new AutomationApi({ workspaceId: "ws-1" });
    await expect(
      api.activatePlan({
        planId: "plan-1",
        expectedRevision: 1n,
        configVersion: 1n,
        configSha256: new Uint8Array(4),
      }),
    ).rejects.toMatchObject({ failure: "invalid" });
  });

  it("载荷读回来是原文，另一个计划的答案被拒", async () => {
    serve(200, { planId: "plan-2", payload: "别人的", payloadSha256: "" });
    const api = new AutomationApi({ workspaceId: "ws-1" });
    await expect(api.planPayload("plan-1")).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("冻结一个命令会话发的是普通 JSON 启动定义", async () => {
    const calls = serve(200, { sessionId: "session-1" });
    const api = new AutomationApi({ workspaceId: "ws-1" });
    await api.defineCommandSession({
      sessionId: "session-1",
      rootPath: "/tmp/ws",
      launch: commandLaunchSpec({
        executable: "/bin/echo",
        args: ["hello"],
        timeoutMs: 60_000n,
      }),
    });
    const sent = JSON.parse(String(calls[0]?.init?.body)) as {
      launch: { executable: string; timeoutMs: string };
    };
    expect(sent.launch.executable).toBe("/bin/echo");
    expect(sent.launch.timeoutMs).toBe("60000");
  });
});

describe("AutomationApi 的错误分档", () => {
  const cases: [string, number, string][] = [
    ["unauthenticated", 401, "unauthenticated"],
    ["permission", 403, "forbidden"],
    ["unsupported", 409, "unsupported"],
    ["notFound", 404, "not_found"],
    ["conflict", 409, "conflict"],
    ["invalid", 400, "bad_request"],
  ];

  for (const [failure, status, code] of cases) {
    it(`${code} → ${failure}`, async () => {
      serve(status, { code, message: "nope" });
      const api = new AutomationApi({ workspaceId: "ws-1" });
      await expect(api.listPlans()).rejects.toMatchObject({
        name: "AutomationApiError",
        failure,
      });
    });
  }
});
