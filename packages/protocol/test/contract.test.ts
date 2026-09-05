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
  WorkerServiceOperation,
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
  CanvasDocumentSchema,
  CanvasNodeSchema,
  CanvasOperationReceiptSchema,
  CanvasEventEnvelopeSchema,
  CanvasEventPageSchema,
  CanvasOwnershipSchema,
  CanvasConsistencyReportSchema,
  CanvasCursorStatus,
  CanvasEdgeKind,
  CanvasEntityKind,
  CanvasOwnershipOwner,
  CanvasOwnershipPhase,
  SaveCanvasDocumentRequestSchema,
  GetGithubPullResponseSchema,
  GithubCheckConclusion,
  GithubCredentialSource,
  GithubCredentialStatusSchema,
  GithubExternalReferenceSchema,
  GithubIssueSchema,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMergeMethod,
  GithubMergeableState,
  GithubPullState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubSecretStore,
  GithubStatusMappingSchema,
  GithubStatusSource,
  GithubWriteState,
  MergeGithubPullRequestSchema,
  MoveGithubIssueResponseSchema,
  UpdateGithubIssueRequestSchema,
  BrowserSessionSchema,
  BrowserSessionState,
  BrowserFrameSchema,
  BrowserInputRequestSchema,
  BrowserInputKind,
  BrowserReadResponseSchema,
  BrowserActionSchema,
  BrowserDownloadSchema,
  BrowserDownloadState,
  SubscribePresenceResponseSchema,
  AgentPromptPhase,
  AgentPromptReceiptSchema,
  AgentPromptRequestSchema,
  AgentTargetRequestSchema,
  AgentTargetState,
  AgentTargetStatusSchema,
  AutomationColdStartPolicy,
  AutomationTargetKind,
  AutomationTargetSchema,
  CheckForUpdateResponseSchema,
  ReleaseChannel,
  UpdateArtifactSchema,
  UpdateCheckState,
  UpdateSignatureState,
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
  it("keeps the controlled browser surface byte-identical across runtimes", () => {
    check("browser_session", BrowserSessionSchema, {
      sessionId: "browser-1",
      generation: maxUint64,
      workspaceId: "workspace-1",
      nodeId: "node-1",
      url: "http://127.0.0.1:8080/表单",
      title: "受控浏览器 😀",
      viewport: { width: 1000, height: 700, deviceScaleFactor: 2 },
      state: BrowserSessionState.READY,
      navigationEpoch: 9007199254740993n,
      headful: false,
      keepAlive: true,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
    });
    check("browser_frame", BrowserFrameSchema, {
      sessionId: "browser-1",
      generation: 2n,
      frameSeq: 9007199254740993n,
      navigationEpoch: maxUint64,
      viewportWidth: 1000,
      viewportHeight: 700,
      deviceScaleFactor: 1.5,
      encoding: "jpeg",
      data: new Uint8Array([0, 255, 0xd8, 0xff]),
      capturedAtUnixMs: 1788557900000n,
    });
    check("browser_input", BrowserInputRequestSchema, {
      sessionId: "browser-1",
      navigationEpoch: maxUint64,
      frameSeq: 7n,
      events: [
        {
          kind: BrowserInputKind.MOUSE_PRESSED,
          x: 12.5,
          y: 40,
          button: "left",
          clickCount: 1,
          modifiers: 15,
        },
        { kind: BrowserInputKind.WHEEL, x: 500, y: 550, deltaY: 400 },
        { kind: BrowserInputKind.TEXT, text: "Hello 中文 😀" },
      ],
    });
    check("browser_read", BrowserReadResponseSchema, {
      sessionId: "browser-1",
      navigationEpoch: 3n,
      url: "http://127.0.0.1:8080/",
      title: "Armadra 受控浏览器",
      text: "正文 😀",
      elements: [
        {
          elementRef: "e1",
          role: "button",
          name: "提交",
          selector: "#submit",
          visible: true,
          x: 10,
          y: 20,
          width: 80,
          height: 32,
        },
      ],
      console: [
        {
          atUnixMs: 1788557900000n,
          level: "error",
          text: "boom",
          url: "http://127.0.0.1:8080/",
          line: 12,
        },
      ],
      network: [
        {
          atUnixMs: 1788557900000n,
          method: "GET",
          url: "http://127.0.0.1:8080/a",
          status: 404,
          mimeType: "text/html",
          encodedBytes: 9007199254740993n,
          fromCache: true,
        },
      ],
      truncated: true,
    });
    check("browser_action_capture", BrowserActionSchema, {
      action: {
        case: "capture",
        value: {
          meta: { requestId: "请求-1" },
          sessionId: "browser-1",
          fullPage: true,
          format: "png",
        },
      },
    });
    check("browser_unsupported", BrowserSessionSchema, {
      sessionId: "browser-2",
      state: 999 as BrowserSessionState,
      reasonCode: "chrome_not_found",
    });
    expect(
      fromBinary(BrowserSessionSchema, fixture("browser_unsupported")).state,
    ).toBe(999);
    check("browser_download", BrowserDownloadSchema, {
      downloadId: "d-1",
      sessionId: "browser-1",
      url: "http://127.0.0.1:8080/报告.pdf",
      suggestedFilename: "报告.pdf",
      state: BrowserDownloadState.PENDING,
      path: ".armadra/downloads/报告.pdf",
      totalBytes: 9007199254740993n,
      receivedBytes: 0n,
      createdAtUnixMs: 1788557000000n,
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

  it("keeps an absent remote content version distinct from a present one", () => {
    // Absent means create-only. If `optional` collapsed to "" here, a save
    // that must refuse to overwrite would silently overwrite instead (H02).
    check("worker_write", WorkerRequestSchema, {
      requestId: "write-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1788557900000n,
      action: {
        case: "writeFile",
        value: {
          rootId: "root-1",
          path: "正文.txt",
          content: "内容\n",
          expectedSha256: "a".repeat(64),
          bom: true,
        },
      },
    });
    check("worker_write_new", WorkerRequestSchema, {
      requestId: "write-2",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1788557900000n,
      action: {
        case: "writeFile",
        value: { rootId: "root-1", path: "new.txt" },
      },
    });
  });

  it("carries a proxied operation and the execution host's own status", () => {
    expect(WorkerServiceOperation.UNSPECIFIED).toBe(0);
    expect(WorkerServiceOperation.GIT_COMMIT).toBe(17);
    check("worker_service", WorkerRequestSchema, {
      requestId: "service-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1788557900000n,
      action: {
        case: "service",
        value: {
          rootId: "root-1",
          operation: WorkerServiceOperation.GIT_COMMIT,
          requestJson: new TextEncoder().encode(
            '{"path":".","message":"提交"}',
          ),
          allowWrite: true,
          allowExecute: true,
        },
      },
    });
    check("worker_service_reply", WorkerResponseSchema, {
      requestId: "service-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "service",
        value: {
          httpStatus: 409,
          responseJson: new TextEncoder().encode(
            '{"code":"conflict","message":"版本不匹配"}',
          ),
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

  it("keeps prompt delivery evidence separable from proven non-delivery", () => {
    check("agent_target_status", AgentTargetStatusSchema, {
      state: AgentTargetState.ABSENT,
      sessionId: "会话-1",
      generation: maxUint64,
      reasonCode: "SESSION_ABSENT",
    });
    check("agent_target_request", AgentTargetRequestSchema, {
      workspaceId: "workspace-1",
      nodeId: "node-1",
      sessionId: "session-1",
      generation: 9007199254740993n,
      expected: {
        agentId: "claude",
        workingDirectory: "/项目/仓库",
        accountId: "default",
      },
      coldStart: {
        agentId: "claude",
        workingDirectory: "/项目/仓库",
        args: ["--flag", "值📦"],
        permissionMode: "acceptEdits",
        modelId: "sonnet",
        accountId: "default",
      },
    });
    check("agent_prompt_request", AgentPromptRequestSchema, {
      operationId:
        "automation/principal-1/host-0123456789abcdef0123456789abcdef/workspace-1/dispatch/run-1",
      requestSha256: new Uint8Array(32).fill(5),
      workspaceId: "workspace-1",
      nodeId: "node-1",
      sessionId: "session-1",
      generation: 9007199254740993n,
      prompt: new TextEncoder().encode("每晚复盘：读取 diff 后写结论\n"),
      expected: {
        agentId: "claude",
        workingDirectory: "/项目/仓库",
        args: ["--flag", "值📦"],
        permissionMode: "acceptEdits",
        modelId: "sonnet",
        accountId: "default",
      },
    });
    check("agent_prompt_not_written", AgentPromptReceiptSchema, {
      operationId: "operation-1",
      requestSha256: new Uint8Array(32).fill(6),
      phase: AgentPromptPhase.NOT_WRITTEN,
      sequence: 1n,
      observedAtUnixMs: 1788557000000n,
      reasonCode: "TARGET_BUSY",
      sessionId: "session-1",
      generation: 3n,
      noEffectProven: true,
    });
    check("agent_prompt_unknown", AgentPromptReceiptSchema, {
      operationId: "operation-1",
      requestSha256: new Uint8Array(32).fill(6),
      phase: 999 as AgentPromptPhase,
      sequence: maxUint64,
      observedAtUnixMs: 1788557900000n,
      reasonCode: "UNATTRIBUTED",
      sessionId: "session-2",
      generation: maxUint64,
      coldStarted: true,
    });
    check("automation_agent_target", AutomationTargetSchema, {
      executionHostId: "0123456789abcdef0123456789abcdef",
      sessionId: "session-1",
      generation: 7n,
      kind: AutomationTargetKind.AGENT_SESSION_PROMPT,
      nodeId: "node-1",
      coldStartPolicy: AutomationColdStartPolicy.LAUNCH_FROZEN,
      agentLaunch: {
        agentId: "codex",
        workingDirectory: "/项目/仓库",
        accountId: "default",
      },
    });
    // A plan frozen before the field existed stays a command target.
    const legacy = fromBinary(
      AutomationTargetSchema,
      toBinary(
        AutomationTargetSchema,
        create(AutomationTargetSchema, {
          executionHostId: "host-1",
          sessionId: "session-1",
          generation: 1n,
        }),
      ),
    );
    expect(legacy.kind).toBe(AutomationTargetKind.UNSPECIFIED);
    expect(legacy.nodeId).toBe("");
    expect(legacy.agentLaunch).toBeUndefined();
  });

  it("distinguishes an unchecked update from an up-to-date one", () => {
    check("update_unsupported", CheckForUpdateResponseSchema, {
      state: UpdateCheckState.UNSUPPORTED,
      channel: ReleaseChannel.STABLE,
      installedVersion: { major: 0, minor: 1, patch: 0 },
      reasonCode: "UPDATES_NOT_CONFIGURED",
      checkedAtUnixMs: 1788557000000n,
    });
    check("update_available", CheckForUpdateResponseSchema, {
      state: UpdateCheckState.AVAILABLE,
      channel: ReleaseChannel.BETA,
      installedVersion: { major: 0, minor: 1, patch: 0 },
      release: {
        version: { major: 0, minor: 2, patch: 1, prerelease: "beta.1" },
        channel: ReleaseChannel.BETA,
        publishedAtUnixMs: 1788557900000n,
        notesUrl: "https://example.invalid/发布说明",
        compatibility: {
          minimumInstalled: { minor: 1 },
          maximumInstalled: { major: 1 },
          protocolMajor: 1,
          minimumProtocolMinor: 1,
        },
        artifacts: [
          {
            target: "darwin-aarch64",
            url: "https://example.invalid/Armadra.tar.gz",
            sizeBytes: 9007199254740993n,
            sha256: new Uint8Array(32).fill(4),
            signature: {
              state: UpdateSignatureState.PRESENT,
              value: "dW50cnVzdGVkIGNvbW1lbnQ",
              keyId: "key-1",
            },
          },
        ],
      },
      checkedAtUnixMs: 1788557900000n,
      retryAfterMs: 3600000n,
    });
    check("update_unconfigured_signature", UpdateArtifactSchema, {
      target: "windows-x86_64",
      url: "https://example.invalid/Armadra.msi",
      sizeBytes: 1n,
      sha256: new Uint8Array(32).fill(2),
      signature: { state: UpdateSignatureState.UNCONFIGURED },
    });
  });
});

describe("GitHub Issues and Pull requests", () => {
  const enterprise = {
    owner: "组织",
    name: "仓库-x",
    apiBase: "https://ghe.example.com/api/v3",
    host: "ghe.example.com",
  };

  it("carries a credential status that can never hold a token", () => {
    check("github_credential_status", GithubCredentialStatusSchema, {
      source: GithubCredentialSource.TOKEN_REF,
      store: GithubSecretStore.FILE_FALLBACK,
      available: false,
      apiBase: "https://ghe.example.com/api/v3",
      enterprise: true,
      accountLogin: "octo-用户",
      tokenScopes: ["repo", "read:org"],
      checkedAtUnixMs: 1788557900000n,
      reasonCode: "TOKEN_REJECTED",
      revision: 9007199254740993n,
    });
  });

  it("keeps external Issue content, mapping and conflict flags byte-identical", () => {
    check("github_issue_mapped", GithubIssueSchema, {
      repository: enterprise,
      number: 4321n,
      id: 9223372036854775807n,
      title: "修复 📦 上传",
      body: "外部内容\n<script>",
      state: GithubIssueState.OPEN,
      stateReason: GithubIssueStateReason.REOPENED,
      author: { login: "作者", id: 7n },
      assignees: [{ login: "负责人", id: 8n }],
      labels: [
        { name: "status/in progress", color: "ededed" },
        { name: "bug", color: "d73a4a" },
      ],
      milestone: { number: 3n, title: "M5" },
      commentCount: 12n,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
      htmlUrl: "https://ghe.example.com/组织/仓库-x/issues/4321",
      statusGroupId: "in-progress",
      statusConflict: true,
      observedAtUnixMs: 1788557900001n,
    });
    check("github_status_mapping", GithubStatusMappingSchema, {
      repository: enterprise,
      source: GithubStatusSource.PROJECT_FIELD,
      projectId: "PVT_kwDO",
      projectFieldId: "PVTSSF_lADO",
      groups: [
        {
          id: "todo",
          title: "待办",
          label: "status/todo",
          projectOptionId: "f75ad846",
        },
        {
          id: "done",
          title: "完成",
          label: "status/done",
          projectOptionId: "98236657",
          couplesIssueState: GithubIssueState.CLOSED,
        },
      ],
      stateGroups: [{ state: GithubIssueState.CLOSED, groupId: "done" }],
      revision: 9007199254740993n,
      updatedAtUnixMs: 1788557900000n,
    });
  });

  it("reports each write of a partly applied move on its own", () => {
    check("github_move_outcomes", MoveGithubIssueResponseSchema, {
      outcomes: [
        {
          actionId: "action-1",
          target: "labels",
          state: GithubWriteState.APPLIED,
          previousValue: "status/todo",
          requestedValue: "status/done",
        },
        {
          actionId: "action-2",
          target: "project_field",
          state: GithubWriteState.PENDING,
          reasonCode: "UNKNOWN_OUTCOME",
        },
        {
          actionId: "action-3",
          target: "issue_state",
          state: GithubWriteState.CONFLICTED,
          reasonCode: "REMOTE_CHANGED",
        },
      ],
      rateLimit: {
        limit: 5000n,
        remaining: 0n,
        resetsAtUnixMs: 1788558000000n,
        throttled: true,
        retryAfterUnixMs: 1788557960000n,
      },
    });
  });

  it("binds a merge to the head SHA and check rollup the reader saw", () => {
    check("github_merge_request", MergeGithubPullRequestSchema, {
      meta: {
        requestId: "merge-1",
        scope: {
          hostId: "0123456789abcdef0123456789abcdef",
          workspaceId: "workspace-1",
          executionHostId: "0123456789abcdef0123456789abcdef",
        },
      },
      repository: enterprise,
      number: 99n,
      expectedHeadSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
      method: GithubMergeMethod.SQUASH,
      commitTitle: "feat: 合并 📦",
      commitMessage: "正文",
      expectedCheckRollup: GithubCheckConclusion.SUCCESS,
    });
    check("github_pull_checks", GetGithubPullResponseSchema, {
      pull: {
        repository: enterprise,
        number: 99n,
        title: "合并请求",
        state: GithubPullState.OPEN,
        draft: true,
        baseRef: "main",
        headRef: "feature/上传",
        headSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
        headRepoFullName: "fork-owner/仓库-x",
        fromFork: true,
        mergeable: GithubMergeableState.BLOCKED,
        allowedMergeMethods: [
          GithubMergeMethod.SQUASH,
          GithubMergeMethod.REBASE,
        ],
        changedFiles: 3n,
        observedAtUnixMs: 1788557900000n,
      },
      checks: {
        headSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
        runs: [
          {
            name: "build",
            app: "GitHub Actions",
            conclusion: GithubCheckConclusion.FAILURE,
            detailsUrl: "https://ghe.example.com/runs/1",
            rerunnable: true,
            workflowRunId: 4242n,
          },
          {
            name: "外部检查",
            conclusion: GithubCheckConclusion.PENDING,
          },
        ],
        rollup: GithubCheckConclusion.FAILURE,
        observedAtUnixMs: 1788557900000n,
      },
      pollIntervalMs: 30000n,
    });
  });

  it("links an Issue or Pull request to one local target", () => {
    check("github_reference", GithubExternalReferenceSchema, {
      referenceId: "0123456789abcdef0123456789abcdef",
      workspaceId: "workspace-1",
      repository: enterprise,
      kind: GithubReferenceKind.PULL_REQUEST,
      number: 99n,
      targetKind: GithubReferenceTargetKind.WORKTREE,
      targetId: "worktree-上传",
      title: "合并请求",
      revision: 9007199254740993n,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
    });
  });

  // Leaving a field alone and clearing it are different edits, so an absent
  // optional must not decode as an empty string.
  it("distinguishes an absent patch field from a present empty one", () => {
    check("github_issue_patch_absent", UpdateGithubIssueRequestSchema, {
      repository: enterprise,
      number: 4321n,
      patch: { replaceLabels: true, labels: ["status/done"] },
      expectedUpdatedAtUnixMs: 1788557900000n,
    });
    check("github_issue_patch_empty_body", UpdateGithubIssueRequestSchema, {
      repository: enterprise,
      number: 4321n,
      patch: { body: "" },
      expectedUpdatedAtUnixMs: 1788557900000n,
    });
    expect(
      fromBinary(
        UpdateGithubIssueRequestSchema,
        fixture("github_issue_patch_absent"),
      ).patch?.body,
    ).toBeUndefined();
    expect(
      fromBinary(
        UpdateGithubIssueRequestSchema,
        fixture("github_issue_patch_empty_body"),
      ).patch?.body,
    ).toBe("");
  });
});

describe("canvas ownership and document wire contracts", () => {
  const minInt64 = -9_223_372_036_854_775_808n;
  const beyondDouble = 9_007_199_254_740_993n;
  const canvasNode = () => ({
    nodeId: "node-终端",
    canvasId: "canvas-1",
    type: "terminal",
    title: "构建 📦",
    color: "#0a84ff",
    position: { x: -1024.5, y: 2048.25 },
    size: { width: 640, height: 480 },
    collapsed: false,
    expandedHeight: 0,
    // Frame nesting is a plain parent reference, so a migration can compare it
    // without understanding what a frame draws like.
    parentId: "node-frame",
    dataJson: new TextEncoder().encode('{"sessionId":"session-1"}'),
    assets: [
      {
        assetId: "asset-1",
        workspaceId: "workspace-1",
        relativePath: ".armadra/assets/ab/cd/图片.png",
        sha256: new Uint8Array(32).fill(5),
        bytes: beyondDouble,
        mimeType: "image/png",
      },
    ],
    createdAtUnixMs: 1788557000000n,
    updatedAtUnixMs: 1788557900000n,
    revision: beyondDouble,
  });

  it("keeps a whole canvas document byte-identical across runtimes", () => {
    check("canvas_document", CanvasDocumentSchema, {
      canvas: {
        canvasId: "canvas-1",
        workspaceId: "workspace-1",
        name: "默认画布",
        sortOrder: minInt64,
        viewport: { x: -0.5, y: 12.25, zoom: 1.5 },
        whiteboard: {
          schemaVersion: 2,
          engineVersion: "tldraw-5",
          snapshot: new Uint8Array([0x00, 0x9f, 0x99, 0x82]),
          sha256: new Uint8Array(32).fill(1),
          bytes: 4n,
        },
        createdAtUnixMs: 1788557000000n,
        updatedAtUnixMs: 1788557900000n,
        revision: maxUint64,
      },
      nodes: [
        canvasNode(),
        {
          nodeId: "node-frame",
          canvasId: "canvas-1",
          type: "group",
          title: "Frame",
          position: {},
          createdAtUnixMs: 1788557000000n,
          updatedAtUnixMs: 1788557000000n,
          revision: 1n,
        },
      ],
      edges: [
        {
          edgeId: "edge-1",
          canvasId: "canvas-1",
          sourceNodeId: "node-终端",
          targetNodeId: "node-frame",
          kind: CanvasEdgeKind.LINK,
          createdAtUnixMs: 1788557000000n,
          updatedAtUnixMs: 1788557000000n,
          revision: 1n,
        },
      ],
      annotations: [
        {
          annotationId: "annotation-1",
          canvasId: "canvas-1",
          nodeId: "node-终端",
          labels: ["构建", "夜间"],
          note: "备注 🈶",
          createdAtUnixMs: 1788557000000n,
          updatedAtUnixMs: 1788557900000n,
          revision: 2n,
        },
      ],
      eventSequence: beyondDouble,
    });
  });

  it("names the operation and the revision a save was written against", () => {
    check("canvas_save_request", SaveCanvasDocumentRequestSchema, {
      meta: {
        requestId: "save-1",
        scope: {
          hostId: "0123456789abcdef0123456789abcdef",
          workspaceId: "workspace-1",
          executionHostId: "0123456789abcdef0123456789abcdef",
        },
        idempotencyKey: "canvas/workspace-1/canvas-1/7",
      },
      operationId: "canvas/workspace-1/canvas-1/7",
      canvas: {
        canvasId: "canvas-1",
        workspaceId: "workspace-1",
        name: "默认画布",
        viewport: { zoom: 1 },
      },
      expectedRevision: beyondDouble,
      nodes: [canvasNode()],
    });
    check("canvas_receipt", CanvasOperationReceiptSchema, {
      operationId: "canvas/workspace-1/canvas-1/7",
      transactionId: beyondDouble,
      firstSequence: beyondDouble,
      lastSequence: maxUint64,
      replayed: true,
      revisions: [
        {
          kind: CanvasEntityKind.CANVAS,
          entityId: "canvas-1",
          revision: 2n,
        },
        {
          kind: CanvasEntityKind.NODE,
          entityId: "node-终端",
          revision: maxUint64,
          deleted: true,
        },
      ],
    });
  });

  it("carries the whole entity with the event that changed it", () => {
    check("canvas_event", CanvasEventEnvelopeSchema, {
      sequence: beyondDouble,
      transactionId: 42n,
      operationId: "canvas/workspace-1/canvas-1/7",
      transactionIndex: 1,
      transactionSize: 3,
      workspaceId: "workspace-1",
      kind: CanvasEntityKind.NODE,
      entityId: "node-终端",
      revision: maxUint64,
      entity: { case: "node", value: canvasNode() },
    });
  });

  /**
   * A cursor below the retained floor is answered with a status, not with a
   * silently shortened history: an empty page here would read as "nothing
   * changed" and leave the client permanently behind.
   */
  it("answers an unusable cursor with a status rather than an empty page", () => {
    check("canvas_event_snapshot_required", CanvasEventPageSchema, {
      status: CanvasCursorStatus.SNAPSHOT_REQUIRED,
      nextCursor: 0n,
      minCursor: beyondDouble,
      highWatermark: maxUint64,
    });
  });

  it("records the ownership epoch and the verification it rests on", () => {
    check("canvas_ownership_switching", CanvasOwnershipSchema, {
      domain: "canvas",
      owner: CanvasOwnershipOwner.RUNTIME,
      epoch: beyondDouble,
      phase: CanvasOwnershipPhase.SWITCHING,
      importId: "0123456789abcdef0123456789abcdef",
      reasonCode: "ownership.switch.verified",
      updatedAtUnixMs: 1788557900000n,
      revision: 3n,
    });
    check("canvas_consistency_report", CanvasConsistencyReportSchema, {
      importId: "0123456789abcdef0123456789abcdef",
      exportId: "导出-1",
      manifestSha256: new Uint8Array(32).fill(2),
      checks: [
        { check: "nodes", expectedCount: 2n, actualCount: 2n, matched: true },
        {
          check: "assets",
          expectedCount: 1n,
          actualCount: 0n,
          matched: false,
          differences: ["asset-1"],
        },
      ],
      matched: false,
      entityCount: beyondDouble,
      verifiedAtUnixMs: 1788557900000n,
    });
  });

  it("hands write ownership over by naming both epochs", () => {
    check("worker_set_ownership", WorkerRequestSchema, {
      requestId: "ownership-1",
      hostId: "0123456789abcdef0123456789abcdef",
      action: {
        case: "setWriteOwnership",
        value: {
          domain: "canvas",
          owner: CanvasOwnershipOwner.HOST,
          epoch: beyondDouble,
          expectedEpoch: 9_007_199_254_740_992n,
          reasonCode: "ownership.switch.verified",
        },
      },
    });
    check("worker_write_ownership", WorkerResponseSchema, {
      requestId: "ownership-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "writeOwnership",
        value: {
          domain: "canvas",
          owner: CanvasOwnershipOwner.HOST,
          epoch: beyondDouble,
          updatedAtUnixMs: 1788557900000n,
          reasonCode: "ownership.switch.verified",
        },
      },
    });
  });

  /**
   * A node whose size was never set and one explicitly stored at zero are
   * different documents. Losing the distinction silently resizes canvases the
   * next time they are read back.
   */
  it("distinguishes an absent node size from an explicit zero", () => {
    check("canvas_node_absent_size", CanvasNodeSchema, {
      nodeId: "node-裸",
      canvasId: "canvas-1",
      type: "sticky",
      position: { x: 0, y: 0 },
      revision: 1n,
    });
    const absent = create(CanvasNodeSchema, { nodeId: "n", canvasId: "c" });
    const zero = create(CanvasNodeSchema, {
      nodeId: "n",
      canvasId: "c",
      size: {},
      collapsed: false,
      expandedHeight: 0,
    });
    expect(toBinary(CanvasNodeSchema, absent)).not.toEqual(
      toBinary(CanvasNodeSchema, zero),
    );
    const back = fromBinary(
      CanvasNodeSchema,
      toBinary(CanvasNodeSchema, absent),
    );
    expect(back.size).toBeUndefined();
    expect(back.collapsed).toBeUndefined();
    expect(back.expandedHeight).toBeUndefined();
  });

  // Zero is reserved everywhere: a default-constructed message never claims to
  // be a real entity kind, edge kind, cursor status, owner or phase.
  it("reserves 0 in every canvas enumeration", () => {
    expect(CanvasEntityKind.UNSPECIFIED).toBe(0);
    expect(CanvasEdgeKind.UNSPECIFIED).toBe(0);
    expect(CanvasCursorStatus.UNSPECIFIED).toBe(0);
    expect(CanvasOwnershipOwner.UNSPECIFIED).toBe(0);
    expect(CanvasOwnershipPhase.UNSPECIFIED).toBe(0);
  });
});
