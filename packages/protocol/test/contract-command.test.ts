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
  CommandPhase,
  CommandReceiptSchema,
  CommandRequestSchema,
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

describe("the command executor", () => {
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
});
