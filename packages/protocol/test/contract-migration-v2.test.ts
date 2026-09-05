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
  ApplyReverseExportRequestSchema,
  ReverseExportFileSchema,
  ReverseExportIndexSchema,
  ReverseExportRecordSchema,
  ReverseImportReportSchema,
  WorkerRequestSchema,
  WorkerResponseSchema,
} from "../src/index.js";

// Reverse export package v2 (Go Host 业务所有权迁移 §2.12). The web client never
// writes one of these, but it reads the rollback report the Host publishes, so
// the same fixtures have to decode here byte for byte.

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
const encoder = new TextEncoder();

describe("reverse export package v2", () => {
  it("carries the domain, the epoch and both digests in its index", () => {
    check("reverse_export_index", ReverseExportIndexSchema, {
      formatVersion: 2,
      hostId: "0123456789abcdef0123456789abcdef",
      epoch: 9007199254740993n,
      eventSequence: maxUint64,
      domain: "canvas",
      entityCount: 3n,
      files: [
        {
          name: "6ff1d1de4b2ba01b7b0e4b2a6cbb0a51.pb",
          workspaceId: "工作区-1",
          bytes: 512n,
          sha256: new Uint8Array(32).fill(4),
          contentSha256: new Uint8Array(32).fill(5),
          entityCount: 3n,
        },
      ],
    });
  });

  it("keeps an entity record's single member and its empty form apart", () => {
    check("reverse_export_record", ReverseExportRecordSchema, {
      entity: {
        case: "node",
        value: {
          nodeId: "节点-1",
          canvasId: "canvas-1",
          type: "sticky",
          title: "便签📌",
          color: "#0a84ff",
          position: { x: -1.5, y: 2 },
          parentId: "frame-1",
          dataJson: encoder.encode('{"text":"内容"}'),
          createdAtUnixMs: 1788557000000n,
          updatedAtUnixMs: 1788557000001n,
        },
      },
    });
    check("reverse_export_record_absent", ReverseExportRecordSchema, {});
    expect(fixture("reverse_export_record_absent").length).toBe(0);
  });

  it("separates the on-disk digest from the canonical content digest", () => {
    const onDisk = create(ReverseExportFileSchema, {
      sha256: new Uint8Array(32).fill(1),
    });
    const content = create(ReverseExportFileSchema, {
      contentSha256: new Uint8Array(32).fill(1),
    });
    expect(toBinary(ReverseExportFileSchema, onDisk)).not.toEqual(
      toBinary(ReverseExportFileSchema, content),
    );
    expect(
      fromBinary(
        ReverseExportFileSchema,
        toBinary(ReverseExportFileSchema, onDisk),
      ).contentSha256.length,
    ).toBe(0);
  });

  it("round-trips the Worker action and the report it answers with", () => {
    check("reverse_apply_request", WorkerRequestSchema, {
      requestId: "reverse-1",
      hostId: "0123456789abcdef0123456789abcdef",
      expectedInstanceId: "abcdef0123456789abcdef0123456789",
      deadlineUnixMs: 1788557900000n,
      action: {
        case: "applyReverseExport",
        value: create(ApplyReverseExportRequestSchema, {
          domain: "canvas",
          packagePath: "/data/reverse-export",
          indexSha256: new Uint8Array(32).fill(6),
          expectedEpoch: 2n,
          importId: "reverse-import-1",
        }),
      },
    });
    check("reverse_import_report", WorkerResponseSchema, {
      requestId: "reverse-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "reverseImport",
        value: create(ReverseImportReportSchema, {
          importId: "reverse-import-1",
          domain: "canvas",
          epoch: 2n,
          indexSha256: new Uint8Array(32).fill(6),
          entityCount: 3n,
          replayed: true,
          appliedAtUnixMs: 1788557000000n,
          reexported: [
            {
              workspaceId: "工作区-1",
              contentSha256: new Uint8Array(32).fill(5),
              entityCount: 3n,
            },
          ],
          tables: [{ name: "nodes", rowCount: 1n, readable: true }],
          issues: [
            {
              code: "reverse.unsupported_entity",
              severity: "error",
              entity: "nodes/节点-2",
              detail: "记录类型未知",
            },
          ],
        }),
      },
    });
  });
});
