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
