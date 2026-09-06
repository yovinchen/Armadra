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
  WorkerRequestSchema,
  WorkerResponseSchema,
  WorkerServiceOperation,
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

describe("the private Worker surface", () => {
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
});
