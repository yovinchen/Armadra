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
  ImportedSqlRowSchema,
  MigrationExportManifestSchema,
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

describe("migration export manifests", () => {
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
});
