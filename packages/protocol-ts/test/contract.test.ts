import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  MigrationExportManifestSchema,
  ImportedSqlRowSchema,
  HelloRequestSchema,
  HelloResponseSchema,
  ErrorResponseSchema,
  CommandMetaSchema,
  StreamFrameSchema,
  HostControlRequestSchema,
  HostControlResponseSchema,
  HostManagementResultSchema,
  DesktopRuntimeControlSchema,
  AuthenticatedSessionSchema,
  WorkerRequestSchema,
  WorkerResponseSchema,
  CommandRequestSchema,
  CommandReceiptSchema,
  CommandPhase,
  AutomationReceiptSchema,
  AutomationRunSchema,
  AutomationRunState,
  AutomationCommandSessionSchema,
  AutomationCommandSessionState,
  AutomationPlanSnapshotSchema,
  AutomationPlanState,
  DefineAutomationRequestSchema,
  type AutomationOutcome,
  SessionMetricsSchema,
  HostMetricsSchema,
  PlatformComponentMetricsSchema,
  PlatformComponentKind,
  ProcessSampleSchema,
  SubscribeResourcesRequestSchema,
  ResourceLocation,
  ResourceUnknownReason,
  AcquireWriterLeaseRequestSchema,
  BindNodeAccountRequestSchema,
  CapabilityState,
  CredentialBindingSchema,
  CredentialScope,
  MutationKind,
  MutationSchema,
  NodeAccountBindingSchema,
  PresenceState,
  SubscribePresenceResponseSchema,
} from "../src/index.js";

function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

const maxUint64 = 18_446_744_073_709_551_615n;

describe("shared Go / Rust / TypeScript wire contracts", () => {
  it("preserves unknown executor outcomes and irreversible delivery evidence", () => {
    check("automation_unknown_receipt", AutomationReceiptSchema, {
      operationId: "operation-1",
      requestSha256: new Uint8Array(32).fill(7),
      outcome: 999 as AutomationOutcome,
      sequence: maxUint64,
      observedAtUnixMs: 1788557900000n,
    });
    check("automation_delivery_evidence", AutomationRunSchema, {
      id: "run-1",
      planId: "plan-1",
      workspaceId: "workspace-1",
      configVersion: 9007199254740993n,
      state: AutomationRunState.UNKNOWN,
      deliveryObserved: true,
    });
  });
  it("keeps the authenticated automation surface byte-identical across runtimes", () => {
    check("automation_command_session", AutomationCommandSessionSchema, {
      sessionId: "session/夜间",
      workspaceId: "workspace-1",
      executionHostId: "0123456789abcdef0123456789abcdef",
      rootPath: "/项目/仓库",
      launch: {
        executable: "/bin/echo",
        args: ["--flag", "值📦"],
        workingDirectory: ".",
        accountId: "default",
        timeoutMs: 86_400_000n,
      },
      generation: maxUint64,
      launchSha256: new Uint8Array(32).fill(9),
      state: AutomationCommandSessionState.UNREBUILDABLE,
      reasonCode: "GENERATION_CHANGED",
      revision: 9007199254740993n,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
    });
    check("automation_define_request", DefineAutomationRequestSchema, {
      meta: {
        requestId: "define-1",
        scope: {
          hostId: "0123456789abcdef0123456789abcdef",
          workspaceId: "workspace-1",
          executionHostId: "0123456789abcdef0123456789abcdef",
        },
      },
      planId: "plan-1",
      config: {
        workspaceId: "workspace-1",
        title: "每晚构建",
        target: {
          executionHostId: "0123456789abcdef0123456789abcdef",
          sessionId: "session-1",
          generation: 1n,
        },
        schedule: {
          kind: {
            case: "cron",
            value: { expression: "0 3 * * *", timezone: "Asia/Shanghai" },
          },
        },
      },
      payload: new Uint8Array([0x00, 0x9f, 0x99, 0x82]),
      expectedRevision: 9007199254740993n,
    });
    check("automation_plan_snapshot", AutomationPlanSnapshotSchema, {
      plan: {
        id: "plan-1",
        configVersion: 2n,
        state: AutomationPlanState.ACTIVE,
      },
      revision: maxUint64,
      configSha256: new Uint8Array(32).fill(3),
    });
    check("automation_needs_attention", AutomationPlanSnapshotSchema, {
      plan: {
        id: "plan-1",
        configVersion: 2n,
        state: AutomationPlanState.ACTIVE,
        needsAttention: true,
        attentionReasonCode: "TARGET_UNSUPPORTED",
        attentionStreak: 4294967295,
      },
      revision: maxUint64,
      configSha256: new Uint8Array(32).fill(3),
    });
  });
  it("preserves private Worker identity and partial UTF-8 byte chunks", () => {
    check("worker_hello", WorkerRequestSchema, {
      requestId: "request-worker",
      hostId: "0123456789abcdef0123456789abcdef",
      deadlineUnixMs: 1788557900000n,
      action: { case: "hello", value: { protocol: { major: 1 } } },
    });
    check("worker_chunk", WorkerResponseSchema, {
      requestId: "chunk-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "fileChunk",
        value: {
          rootId: "root-1",
          path: "正文.txt",
          mimeType: "text/plain",
          sha256: new Uint8Array(32).fill(7),
          totalBytes: 4n,
          offset: 1n,
          data: new Uint8Array([0x9f, 0x99, 0x82]),
          eof: true,
        },
      },
    });
  });
  it("binds bootstrap to Host, instance and origin and preserves device revision", () => {
    check("identity_bootstrap", HostControlRequestSchema, {
      requestId: "pair-1",
      action: {
        case: "bootstrap",
        value: {
          expectedHostId: "host-1",
          expectedInstanceId: "instance-1",
          origin: "https://armadra.example",
          deviceName: "手机📱",
          scopes: [
            { permission: "canvas:read" },
            { permission: "terminal:write", workspaceId: "workspace-1" },
          ],
        },
      },
    });
    check("identity_session", AuthenticatedSessionSchema, {
      hostId: "host-1",
      device: {
        deviceId: "device-1",
        principalId: "owner-1",
        displayName: "手机📱",
        role: "owner",
        createdAtUnixMs: 1788557000000n,
        revision: maxUint64,
      },
      scopes: [{ permission: "canvas:read" }],
      csrfToken: "fixture-not-a-secret",
      expiresAtUnixMs: 1788557900000n,
    });
  });
  it("preserves migration manifests and every SQLite value storage class", () => {
    check("migration_manifest", MigrationExportManifestSchema, {
      formatVersion: 1,
      exportId: "导出-1",
      exportedAtUnixMs: 1_788_557_000_000n,
      producerVersion: "0.1.0",
      databaseFile: "source.sqlite",
      databaseBytes: 9_007_199_254_740_993n,
      databaseSha256: new Uint8Array(32).fill(1),
      migrations: [
        {
          version: 1n,
          checksum: new Uint8Array(48).fill(2),
          success: true,
          description: "initial",
        },
      ],
      tables: [
        {
          name: "boards",
          rowCount: 2n,
          readable: true,
          schemaSha256: new Uint8Array(32).fill(3),
        },
      ],
      assetsComplete: true,
    });
    check("imported_sql_row", ImportedSqlRowSchema, {
      table: "测试",
      columns: [
        { name: "null", value: { case: "nullValue", value: {} } },
        { name: "text", value: { case: "textValue", value: "会话😀" } },
        {
          name: "integer",
          value: { case: "integerValue", value: -9_223_372_036_854_775_808n },
        },
        { name: "real", value: { case: "realValue", value: 1.5 } },
        {
          name: "blob",
          value: { case: "blobValue", value: new Uint8Array([0, 255]) },
        },
      ],
    });
  });
  it("encodes explicit private desktop shutdown, separate from empty input", () => {
    check("desktop_shutdown", DesktopRuntimeControlSchema, {
      action: { case: "shutdown", value: {} },
    });
    expect(
      fromBinary(DesktopRuntimeControlSchema, new Uint8Array()).action.case,
    ).toBeUndefined();
  });
  it("distinguishes running and completed-stop binary CLI results", () => {
    check("management_running", HostManagementResultSchema, {
      state: {
        case: "running",
        value: {
          hostId: "host-1",
          hostInstanceId: "instance-1",
          httpEndpoint: "http://127.0.0.1:43121",
          startedAtUnixMs: 1_788_556_300_000n,
          processId: 321,
        },
      },
    });
    check("management_stopped", HostManagementResultSchema, {
      state: { case: "stopped", value: {} },
    });
  });
  it("encodes local control requests and acknowledgements across runtimes", () => {
    check("control_status", HostControlRequestSchema, {
      requestId: "控制请求",
      action: { case: "status", value: {} },
    });
    check("control_stop", HostControlRequestSchema, {
      requestId: "停止请求",
      action: { case: "stop", value: { expectedInstanceId: "instance-1" } },
    });
    check("control_status_reply", HostControlResponseSchema, {
      requestId: "控制请求",
      result: {
        case: "status",
        value: {
          hostId: "host-1",
          hostInstanceId: "instance-1",
          httpEndpoint: "http://127.0.0.1:43121",
          startedAtUnixMs: 1_788_556_300_000n,
          processId: 321,
        },
      },
    });
    check("control_stop_reply", HostControlResponseSchema, {
      requestId: "停止请求",
      result: { case: "stopped", value: { accepted: true } },
    });
  });
  it("preserves UTF-8 and handshake fields", () => {
    check("hello", HelloRequestSchema, {
      clientId: "客户端📡",
      protocol: { major: 1 },
    });
    check("hello_response", HelloResponseSchema, {
      protocol: { major: 1 },
      hostInstanceId: "主机",
      capabilities: ["protocol.hello"],
      maxFrameBytes: 1_048_576,
    });
    check("error", ErrorResponseSchema, {
      code: "UNSUPPORTED",
      message: "尚未实现",
    });
  });

  it("keeps durable identity separate from a process incarnation", () => {
    check("hello_identity", HelloResponseSchema, {
      protocol: { major: 1, minor: 1 },
      hostInstanceId: "新进程",
      hostId: "0123456789abcdef0123456789abcdef",
      capabilities: ["protocol.hello.v1", "host.identity.v1"],
      maxFrameBytes: 1_048_576,
    });
    expect(
      fromBinary(HelloResponseSchema, fixture("hello_response")).hostId,
    ).toBe("");
  });

  it("distinguishes absent and zero optional values", () => {
    check("meta_absent", CommandMetaSchema, { requestId: "请求" });
    check("meta_zero", CommandMetaSchema, {
      requestId: "请求",
      expectedRevision: 0n,
    });
    expect(
      fromBinary(CommandMetaSchema, fixture("meta_absent")).expectedRevision,
    ).toBeUndefined();
    expect(
      fromBinary(CommandMetaSchema, fixture("meta_zero")).expectedRevision,
    ).toBe(0n);
  });

  it("preserves uint64 max and int64 min as bigint", () => {
    check("meta_large", CommandMetaSchema, {
      requestId: "请求",
      scope: {
        hostId: "主机",
        workspaceId: "工作区",
        executionHostId: "执行主机",
      },
      idempotencyKey: "唯一",
      expectedRevision: maxUint64,
      deadlineUnixMs: -9_223_372_036_854_775_808n,
    });
    const decoded = fromBinary(CommandMetaSchema, fixture("meta_large"));
    expect(typeof decoded.expectedRevision).toBe("bigint");
    expect(decoded.expectedRevision).toBe(maxUint64);
  });

  it("round-trips every oneof member and binary bytes", () => {
    check("frame_input", StreamFrameSchema, {
      streamId: "流",
      sequence: maxUint64,
      epoch: "纪元",
      payload: {
        case: "terminalInput",
        value: {
          session: { sessionId: "会话", generation: 9_007_199_254_740_993n },
          inputId: "输入",
          data: new Uint8Array([0, 255, 27, 10]),
          writerLeaseId: "租约",
        },
      },
    });
    check("frame_output", StreamFrameSchema, {
      sequence: 9_007_199_254_740_993n,
      payload: {
        case: "terminalOutput",
        value: new Uint8Array([0, 255, 27, 10]),
      },
    });
    check("frame_ack", StreamFrameSchema, {
      payload: {
        case: "ack",
        value: { receivedThrough: maxUint64, availableCreditBytes: 1_048_576 },
      },
    });
  });

  it("uses the last wire member of a oneof", () => {
    const wire = new Uint8Array([
      ...fixture("frame_input"),
      ...fixture("frame_ack"),
    ]);
    expect(fromBinary(StreamFrameSchema, wire).payload.case).toBe("ack");
  });

  it("preserves unknown fields across a binary round trip", () => {
    const wire = fixture("hello_unknown");
    const decoded = fromBinary(HelloRequestSchema, wire);
    expect(decoded.clientId).toBe("客户端📡");
    expect(toBinary(HelloRequestSchema, decoded)).toEqual(wire);
  });

  it("rejects truncated wire data", () => {
    expect(() =>
      fromBinary(HelloRequestSchema, new Uint8Array([0x0a, 0xff])),
    ).toThrow();
  });
});

it("preserves command input bytes, optional exit and unknown execution phases", () => {
  check("command_run", CommandRequestSchema, {
    action: {
      case: "run",
      value: {
        operationId: "operation-1",
        sessionId: "会话-1",
        requestSha256: new Uint8Array(32).fill(8),
        expectedGeneration: maxUint64,
        stdin: new Uint8Array([0, 255, 27, 10]),
      },
    },
  });
  check("command_receipt", CommandReceiptSchema, {
    operationId: "operation-1",
    sessionId: "会话-1",
    generation: 9007199254740993n,
    phase: 999 as CommandPhase,
    sequence: maxUint64,
    exitCode: 0,
    stdout: new Uint8Array([0, 255, 10]),
    stdoutTotalBytes: 9007199254740993n,
    stdoutTruncated: true,
  });
  check("command_absent_exit", CommandReceiptSchema, {
    operationId: "operation-2",
    phase: CommandPhase.NOT_DISPATCHED,
    noEffectProven: true,
    cleanupConfirmed: true,
  });
  expect(
    fromBinary(CommandReceiptSchema, fixture("command_absent_exit")).exitCode,
  ).toBeUndefined();
});

// Resource sampling (design §8, roadmap §4.3): the panel renders an absent
// metric as an em dash and a measured zero as "0". Those two must stay
// distinguishable all the way down to the bytes.
it("keeps unmeasured resource metrics apart from measured zeros", () => {
  check("resources_session", SessionMetricsSchema, {
    sessionId: "会话-1",
    generation: maxUint64,
    pid: 4242n,
    rssBytes: 9007199254740993n,
    cpuPercent: 0,
    childCount: 2,
    cwd: "/工作区/项目",
    agentId: "claude",
    sampledAtUnixMs: 1788557000000n,
    location: ResourceLocation.LOCAL,
    startTimeUnixMs: 1788556300000n,
    children: [
      {
        identity: { pid: 4243n, startTimeUnixMs: 1788556301000n },
        name: "node",
        rssBytes: 1048576n,
        cpuPercent: 12.5,
        parentPid: 4242n,
      },
      { identity: { pid: 4244n }, name: "rg" },
    ],
  });
  check("resources_session_unknown", SessionMetricsSchema, {
    sessionId: "会话-2",
    generation: 1n,
    cwd: "/tmp",
    sampledAtUnixMs: 1788557000000n,
    location: ResourceLocation.REMOTE,
    unknownReason: ResourceUnknownReason.REMOTE,
  });
  check("resources_host", HostMetricsSchema, {
    hostId: "local",
    location: ResourceLocation.LOCAL,
    platform: "macos",
    cpuCores: 10,
    memory: { totalBytes: 68719476736n, usedBytes: 9007199254740993n },
    uptimeSeconds: 0n,
    sampledAtUnixMs: 1788557000000n,
  });
  check("resources_component", PlatformComponentMetricsSchema, {
    kind: PlatformComponentKind.COMMAND_WORKER,
    process: {
      identity: {
        pid: 9223372036854775807n,
        startTimeUnixMs: 1788556300000n,
      },
      name: "armadra-runtime",
      rssBytes: 33554432n,
    },
    tree: true,
    childCount: 0,
  });
  check("resources_subscribe", SubscribeResourcesRequestSchema, {
    workspaceId: "workspace-1",
    intervalMs: 30000n,
  });

  const host = fromBinary(HostMetricsSchema, fixture("resources_host"));
  expect(host.cpuPercent).toBeUndefined();
  expect(host.uptimeSeconds).toBe(0n);
  expect(host.loadAverage).toBeUndefined();
  const measured = toBinary(
    ProcessSampleSchema,
    create(ProcessSampleSchema, { identity: { pid: 1n }, cpuPercent: 0 }),
  );
  const absent = toBinary(
    ProcessSampleSchema,
    create(ProcessSampleSchema, { identity: { pid: 1n } }),
  );
  expect(measured).not.toEqual(absent);
  expect(fromBinary(ProcessSampleSchema, absent).cpuPercent).toBeUndefined();
});

describe("reserved account and presence contracts", () => {
  it("carries an account reference and a credential name, never a secret", () => {
    check("account_bind_request", BindNodeAccountRequestSchema, {
      meta: {
        requestId: "绑定-1",
        scope: { hostId: "host-1", workspaceId: "workspace-1" },
        expectedRevision: 0n,
      },
      nodeId: "node-1",
      account: {
        accountId: "default",
        providerId: "claude",
        label: "工作账号📇",
      },
      credential: {
        credentialRef: "keychain://armadra/claude/default",
        scope: CredentialScope.EXECUTION_HOST,
        authorizationId: "grant-1",
      },
    });
    // The schema has no field a secret could travel in.
    expect(Object.keys(CredentialBindingSchema.field).sort()).toEqual([
      "authorizationId",
      "credentialRef",
      "scope",
    ]);
  });

  it("keeps an unknown credential scope instead of decoding it to zero", () => {
    check("account_binding", NodeAccountBindingSchema, {
      nodeId: "node-1",
      account: { accountId: "default" },
      credential: {
        credentialRef: "keychain://armadra/claude/default",
        scope: 999 as CredentialScope,
      },
      revision: maxUint64,
      boundAtUnixMs: 9007199254740993n,
    });
  });

  it("separates an absent last-seen time from a zero one", () => {
    check("presence_snapshot", SubscribePresenceResponseSchema, {
      participants: [
        {
          participantId: "principal-1",
          deviceId: "device-1",
          displayName: "手机📱",
          canvasId: "canvas-1",
          focusNodeId: "node-1",
          state: PresenceState.ACTIVE,
          observedAtUnixMs: 1788557900000n,
        },
        {
          participantId: "principal-2",
          state: PresenceState.DISCONNECTED,
          lastSeenUnixMs: 0n,
        },
      ],
      lease: {
        leaseId: "lease-1",
        canvasId: "canvas-1",
        holderParticipantId: "principal-1",
        revision: 9007199254740993n,
        expiresAtUnixMs: 1788557900000n,
      },
      revision: maxUint64,
    });
    const decoded = fromBinary(
      SubscribePresenceResponseSchema,
      fixture("presence_snapshot"),
    );
    expect(decoded.participants[0]?.lastSeenUnixMs).toBeUndefined();
    expect(decoded.participants[1]?.lastSeenUnixMs).toBe(0n);
  });

  it("keeps a mutation payload opaque and its CAS expectation explicit", () => {
    check("presence_mutation", MutationSchema, {
      mutationId: "mutation-1",
      canvasId: "canvas-1",
      actorId: "principal-1",
      leaseId: "lease-1",
      expectedRevision: 0n,
      revision: 9007199254740993n,
      kind: MutationKind.WHITEBOARD_BLOB,
      payloadType: "tldraw/snapshot",
      payload: new Uint8Array([0, 255, 27, 10]),
      observedAtUnixMs: -9223372036854775808n,
    });
    check("presence_acquire", AcquireWriterLeaseRequestSchema, {
      meta: { requestId: "租约-1" },
      canvasId: "canvas-1",
      requestedTtlMs: 300000,
    });
    expect(
      fromBinary(AcquireWriterLeaseRequestSchema, fixture("presence_acquire"))
        .expectedRevision,
    ).toBeUndefined();
  });

  it("reads the Host's explicitly unsupported surfaces", () => {
    check("hello_unsupported", HelloResponseSchema, {
      protocol: { major: 1, minor: 1 },
      hostInstanceId: "新进程",
      hostId: "0123456789abcdef0123456789abcdef",
      capabilities: ["protocol.hello.v1", "host.identity.v1"],
      maxFrameBytes: 1048576,
      capabilityStatus: [
        {
          name: "presence",
          state: CapabilityState.UNSUPPORTED,
          reason: "host.capability.reserved",
        },
        {
          name: "accountBinding",
          state: CapabilityState.UNSUPPORTED,
          reason: "host.capability.reserved",
        },
      ],
    });
    // An older Host says nothing, which is not a promise of support either.
    expect(
      fromBinary(HelloResponseSchema, fixture("hello_identity"))
        .capabilityStatus,
    ).toEqual([]);
  });
});
