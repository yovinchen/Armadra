import { describe, expect, it, vi } from "vitest";
import {
  create,
  toBinary,
  fromBinary,
  AutomationCommandSessionSchema,
  AutomationPlanSnapshotSchema,
  AutomationPlanState,
  AutomationRunSnapshotSchema,
  AutomationRunState,
  ActivateAutomationRequestSchema,
  DefineAutomationRequestSchema,
  DefineCommandSessionRequestSchema,
  ListAutomationPlansResponseSchema,
  ListAutomationRunsResponseSchema,
  ListCommandSessionsResponseSchema,
  RunAutomationNowRequestSchema,
} from "@armadra/protocol";
import {
  HostAutomationClient,
  HostAutomationError,
  classifyAutomationFailure,
  type HostAuthenticatedTransport,
} from "../src/automation.js";
import { HostIdentityError } from "../src/identity.js";

const hostId = "1".repeat(32);
const workspaceId = "workspace-1";
const digest = new Uint8Array(32).fill(3);

interface Sent {
  service: string;
  action: string;
  body: Uint8Array;
  mutation: boolean;
}

function transport(reply: (call: Sent) => Uint8Array | Promise<Uint8Array>) {
  const calls: Sent[] = [];
  const session: HostAuthenticatedTransport = {
    send: (service, action, body, mutation) => {
      const call = { service, action, body, mutation };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
  };
  return { session, calls };
}

function client(reply: (call: Sent) => Uint8Array | Promise<Uint8Array>) {
  const { session, calls } = transport(reply);
  return {
    api: new HostAutomationClient({ session, hostId, workspaceId }),
    calls,
  };
}

function planSnapshot(overrides: Record<string, unknown> = {}) {
  return new Uint8Array(
    toBinary(
      AutomationPlanSnapshotSchema,
      create(AutomationPlanSnapshotSchema, {
        plan: {
          id: "plan-1",
          configVersion: 2n,
          state: AutomationPlanState.ACTIVE,
          config: { workspaceId, title: "每晚构建" },
          ...(overrides.plan as object),
        },
        revision: 5n,
        configSha256: digest,
        ...overrides,
      }),
    ),
  );
}

function runSnapshot(overrides: Record<string, unknown> = {}) {
  return new Uint8Array(
    toBinary(
      AutomationRunSnapshotSchema,
      create(AutomationRunSnapshotSchema, {
        run: {
          id: "run-1",
          planId: "plan-1",
          workspaceId,
          state: AutomationRunState.DUE,
          dispatchAttempts: 1,
          ...(overrides.run as object),
        },
        revision: 1n,
      }),
    ),
  );
}

describe("HostAutomationClient", () => {
  it("scopes every request to this workspace and Host without carrying identity", async () => {
    const { api, calls } = client(() => planSnapshot());
    await api.definePlan({
      planId: "plan-1",
      config: {
        $typeName: "armadra.v1.AutomationPlanConfig",
        workspaceId: "ignored-by-host",
        title: "每晚构建",
        target: {
          $typeName: "armadra.v1.AutomationTarget",
          executionHostId: hostId,
          sessionId: "session-1",
          generation: 1n,
          kind: 1,
          nodeId: "",
          coldStartPolicy: 0,
        },
        payloadRef: "",
        payloadSha256: new Uint8Array(),
        misfirePolicy: 1,
        concurrencyPolicy: 1,
        misfireGraceMs: 0n,
        busyTtlMs: 300_000n,
        maxRuns: 0n,
        expiresAtUnixMs: 0n,
        safeRetryLimit: 0,
        retryBackoffMs: 0n,
      },
      payload: new TextEncoder().encode("echo 你好"),
      expectedRevision: 0n,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.service).toBe("AutomationService");
    expect(calls[0]!.action).toBe("Define");
    expect(calls[0]!.mutation).toBe(true);
    const request = fromBinary(DefineAutomationRequestSchema, calls[0]!.body);
    expect(request.meta?.scope?.workspaceId).toBe(workspaceId);
    expect(request.meta?.scope?.hostId).toBe(hostId);
    expect(request.meta?.scope?.executionHostId).toBe(hostId);
    expect(request.meta?.requestId).toBeTruthy();
    // The session owns the principal; nothing identity-shaped rides along.
    expect(request.meta?.idempotencyKey).toBe("");
    expect(request.meta?.expectedRevision).toBeUndefined();
  });

  it("sends reads without CSRF and mutations as mutations", async () => {
    const { api, calls } = client((call) =>
      call.action === "ListPlans"
        ? new Uint8Array(
            toBinary(
              ListAutomationPlansResponseSchema,
              create(ListAutomationPlansResponseSchema, {}),
            ),
          )
        : planSnapshot(),
    );
    await api.listPlans();
    await api.pausePlan({ planId: "plan-1", expectedRevision: 5n });
    expect(calls.map((call) => [call.action, call.mutation])).toEqual([
      ["ListPlans", false],
      ["Pause", true],
    ]);
  });

  it("passes the exact revision, version and digest the caller reviewed", async () => {
    const { api, calls } = client(() => planSnapshot());
    await api.activatePlan({
      planId: "plan-1",
      expectedRevision: 5n,
      configVersion: 2n,
      configSha256: digest,
    });
    const request = fromBinary(ActivateAutomationRequestSchema, calls[0]!.body);
    expect(request.expectedRevision).toBe(5n);
    expect(request.configVersion).toBe(2n);
    expect(request.configSha256).toEqual(digest);
  });

  it("refuses an activation whose digest is not a sha256", async () => {
    const { api, calls } = client(() => planSnapshot());
    await expect(
      api.activatePlan({
        planId: "plan-1",
        expectedRevision: 5n,
        configVersion: 2n,
        configSha256: new Uint8Array(16),
      }),
    ).rejects.toMatchObject({ failure: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("keeps RunNow bound to a revision so a stale card cannot fire a plan", async () => {
    const { api, calls } = client(() => runSnapshot());
    await api.runNow({ planId: "plan-1", expectedRevision: 7n });
    const request = fromBinary(RunAutomationNowRequestSchema, calls[0]!.body);
    expect(request.expectedRevision).toBe(7n);
    await expect(
      api.runNow({ planId: "plan-1", expectedRevision: 0n }),
    ).rejects.toMatchObject({ failure: "invalid" });
  });

  it("freezes a command session definition and validates what comes back", async () => {
    const { api, calls } = client(
      () =>
        new Uint8Array(
          toBinary(
            AutomationCommandSessionSchema,
            create(AutomationCommandSessionSchema, {
              sessionId: "session-1",
              workspaceId,
              executionHostId: hostId,
              rootPath: "/项目/仓库",
              launchSha256: new Uint8Array(32).fill(9),
              revision: 1n,
            }),
          ),
        ),
    );
    const session = await api.defineCommandSession({
      sessionId: "session-1",
      rootPath: "/项目/仓库",
      launch: {
        $typeName: "armadra.v1.CommandLaunchSpec",
        executable: "/bin/echo",
        args: ["值"],
        workingDirectory: ".",
        accountId: "default",
        timeoutMs: 60_000n,
      },
    });
    expect(session.sessionId).toBe("session-1");
    const request = fromBinary(
      DefineCommandSessionRequestSchema,
      calls[0]!.body,
    );
    expect(request.launch?.executable).toBe("/bin/echo");
  });

  it("rejects a session that claims another workspace or execution host", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            AutomationCommandSessionSchema,
            create(AutomationCommandSessionSchema, {
              sessionId: "session-1",
              workspaceId: "somebody-else",
              executionHostId: hostId,
              launchSha256: new Uint8Array(32).fill(9),
              revision: 1n,
            }),
          ),
        ),
    );
    await expect(
      api.defineCommandSession({
        sessionId: "session-1",
        rootPath: "/tmp/root",
        launch: {
          $typeName: "armadra.v1.CommandLaunchSpec",
          executable: "/bin/echo",
          args: [],
          workingDirectory: ".",
          accountId: "default",
          timeoutMs: 1n,
        },
      }),
    ).rejects.toMatchObject({ failure: "response" });
  });

  it("rejects a plan snapshot with no activation digest", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            AutomationPlanSnapshotSchema,
            create(AutomationPlanSnapshotSchema, {
              plan: { id: "plan-1", configVersion: 1n },
              revision: 1n,
            }),
          ),
        ),
    );
    await expect(api.listPlans()).rejects.toBeInstanceOf(HostAutomationError);
  });

  it("rejects a run listing that smuggles in another plan's runs", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            ListAutomationRunsResponseSchema,
            create(ListAutomationRunsResponseSchema, {
              runs: [
                {
                  run: { id: "run-1", planId: "other", workspaceId },
                  revision: 1n,
                },
              ],
            }),
          ),
        ),
    );
    await expect(api.listRuns("plan-1")).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("rejects a page longer than the limit it asked for", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            ListCommandSessionsResponseSchema,
            create(ListCommandSessionsResponseSchema, {
              sessions: [
                {
                  sessionId: "a",
                  workspaceId,
                  executionHostId: hostId,
                  launchSha256: new Uint8Array(32),
                  revision: 1n,
                },
                {
                  sessionId: "b",
                  workspaceId,
                  executionHostId: hostId,
                  launchSha256: new Uint8Array(32),
                  revision: 1n,
                },
              ],
            }),
          ),
        ),
    );
    await expect(api.listCommandSessions("", 1)).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("refuses a payload larger than the Host will store", async () => {
    const { api, calls } = client(() => planSnapshot());
    await expect(
      api.definePlan({
        planId: "plan-1",
        config: create(DefineAutomationRequestSchema, {}).config ?? {
          $typeName: "armadra.v1.AutomationPlanConfig",
          workspaceId,
          title: "",
          payloadRef: "",
          payloadSha256: new Uint8Array(),
          misfirePolicy: 1,
          concurrencyPolicy: 1,
          misfireGraceMs: 0n,
          busyTtlMs: 0n,
          maxRuns: 0n,
          expiresAtUnixMs: 0n,
          safeRetryLimit: 0,
          retryBackoffMs: 0n,
          target: {
            $typeName: "armadra.v1.AutomationTarget",
            executionHostId: hostId,
            sessionId: "session-1",
            generation: 1n,
            kind: 1,
            nodeId: "",
            coldStartPolicy: 0,
          },
        },
        payload: new Uint8Array(64 * 1024 + 1),
        expectedRevision: 0n,
      }),
    ).rejects.toMatchObject({ failure: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("refuses construction against an id that is not this Host", () => {
    const { session } = transport(() => new Uint8Array());
    expect(
      () => new HostAutomationClient({ session, hostId: "nope", workspaceId }),
    ).toThrow(HostAutomationError);
  });
});

describe("classifyAutomationFailure", () => {
  const cases: [string, HostIdentityError, string][] = [
    [
      "an expired session",
      new HostIdentityError("REMOTE_ERROR", false, 401, "UNAUTHENTICATED"),
      "unauthenticated",
    ],
    [
      "a scope the device does not hold",
      new HostIdentityError("REMOTE_ERROR", false, 403, "PERMISSION_DENIED"),
      "permission",
    ],
    [
      "a Host with no execution Worker",
      new HostIdentityError("REMOTE_ERROR", false, 501, "UNSUPPORTED"),
      "unsupported",
    ],
    [
      "a plan that moved on",
      new HostIdentityError("REMOTE_ERROR", false, 409, "CONFLICT"),
      "conflict",
    ],
    [
      "a plan that is gone",
      new HostIdentityError("REMOTE_ERROR", false, 404, "NOT_FOUND"),
      "notFound",
    ],
    [
      "a request the Host rejected",
      new HostIdentityError("REMOTE_ERROR", false, 400, "INVALID_ARGUMENT"),
      "invalid",
    ],
    [
      "an undecodable body",
      new HostIdentityError("MALFORMED_RESPONSE", false, 200),
      "response",
    ],
    ["a dropped connection", new HostIdentityError("NETWORK_ERROR"), "network"],
    ["an aborted call", new HostIdentityError("CANCELLED"), "cancelled"],
  ];
  for (const [name, error, failure] of cases) {
    it(`maps ${name} to ${failure}`, () => {
      expect(classifyAutomationFailure(error).failure).toBe(failure);
    });
  }

  it("never softens an unknown remote code into a client mistake", () => {
    const classified = classifyAutomationFailure(
      new HostIdentityError("REMOTE_ERROR", true, 500, "UNKNOWN_OUTCOME"),
    );
    expect(classified.failure).toBe("network");
    expect(classified.outcomeUnknown).toBe(true);
  });

  it("keeps a mutation whose result was never read flagged as unknown", () => {
    expect(
      classifyAutomationFailure(new HostIdentityError("TIMEOUT", true))
        .outcomeUnknown,
    ).toBe(true);
  });

  it("treats a foreign error as a transport failure, not a Host answer", () => {
    const classified = classifyAutomationFailure(new Error("boom"));
    expect(classified.failure).toBe("network");
    expect(classified.hostCode).toBeUndefined();
  });

  it("passes an already-classified failure through unchanged", () => {
    const original = new HostAutomationError("conflict");
    expect(classifyAutomationFailure(original)).toBe(original);
  });

  it("classifies a transport rejection raised inside a call", async () => {
    const session: HostAuthenticatedTransport = {
      send: vi
        .fn()
        .mockRejectedValue(
          new HostIdentityError("REMOTE_ERROR", false, 501, "UNSUPPORTED"),
        ),
    };
    const api = new HostAutomationClient({ session, hostId, workspaceId });
    await expect(api.listPlans()).rejects.toMatchObject({
      failure: "unsupported",
    });
  });
});
