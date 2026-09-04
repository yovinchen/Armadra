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
  HelloRequestSchema,
  HelloResponseSchema,
  ErrorResponseSchema,
  CommandMetaSchema,
  StreamFrameSchema,
  HostControlRequestSchema,
  HostControlResponseSchema,
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
