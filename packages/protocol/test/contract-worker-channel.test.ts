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
  WorkerAgentUpcallKind,
  WorkerChannelCapabilitySchema,
  WorkerChannelState,
  WorkerHelloResponseSchema,
  WorkerUpcallDisposition,
  WorkerUpcallReplySchema,
  WorkerUpcallSchema,
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
const minInt64 = -9_223_372_036_854_775_808n;

describe("resident Worker channel upcalls", () => {
  it("carries an agent report with its own opaque payload and digest", () => {
    check("worker_upcall_agent", WorkerUpcallSchema, {
      requestId: "w-0123456789abcdef",
      workerInstanceId: "abcdef0123456789abcdef0123456789",
      sequence: 9_007_199_254_740_993n,
      attempt: 1,
      emittedAtUnixMs: 1_788_557_900_000n,
      event: {
        case: "agent",
        value: {
          workspaceId: "workspace-1",
          nodeId: "节点-1",
          sessionId: "会话-1",
          payload: new Uint8Array([0, 255, 27, 10]),
          payloadSha256: new Uint8Array(32).fill(5),
          schemaVersion: 1,
          kind: WorkerAgentUpcallKind.HOOK_TURN,
          observedAtUnixMs: 1_788_557_899_000n,
        },
      },
    });
  });

  // A replay differs from the first send only in `attempt`. Losing that
  // distinction would make a redelivered event indistinguishable from a
  // second observation of the same thing.
  it("keeps the replay attempt and the sequence extremes", () => {
    check("worker_upcall_replay", WorkerUpcallSchema, {
      requestId: "w-replay-1",
      workerInstanceId: "abcdef0123456789abcdef0123456789",
      sequence: maxUint64,
      attempt: 4_294_967_295,
      emittedAtUnixMs: minInt64,
      event: {
        case: "agent",
        value: {
          nodeId: "节点-2",
          kind: WorkerAgentUpcallKind.APPROVAL_REQUESTED,
          reasonCode: "agent.approval.pending",
        },
      },
    });
  });

  it("keeps an unrecognized upcall kind as the number it was", () => {
    check("worker_upcall_unknown_kind", WorkerUpcallSchema, {
      requestId: "w-unknown-1",
      workerInstanceId: "abcdef0123456789abcdef0123456789",
      sequence: 1n,
      attempt: 1,
      event: {
        case: "agent",
        value: { kind: 999 as WorkerAgentUpcallKind },
      },
    });
  });

  it("acknowledges, deduplicates and rejects with distinguishable receipts", () => {
    check("worker_upcall_accepted", WorkerUpcallReplySchema, {
      requestId: "w-0123456789abcdef",
      hostId: "0123456789abcdef0123456789abcdef",
      workerInstanceId: "abcdef0123456789abcdef0123456789",
      ackSequence: 9_007_199_254_740_993n,
      disposition: WorkerUpcallDisposition.ACCEPTED,
      receivedAtUnixMs: 1_788_557_900_001n,
    });
    check("worker_upcall_duplicate", WorkerUpcallReplySchema, {
      requestId: "w-replay-1",
      hostId: "0123456789abcdef0123456789abcdef",
      workerInstanceId: "abcdef0123456789abcdef0123456789",
      ackSequence: maxUint64,
      disposition: WorkerUpcallDisposition.DUPLICATE,
      reasonCode: "worker.upcall.duplicate",
    });
    // A rejection carries no ack: the frame is dropped, and the sequence it
    // occupied must not read as accepted by a client that only looks here.
    check("worker_upcall_rejected", WorkerUpcallReplySchema, {
      requestId: "w-bad-1",
      hostId: "0123456789abcdef0123456789abcdef",
      workerInstanceId: "abcdef0123456789abcdef0123456789",
      disposition: WorkerUpcallDisposition.REJECTED,
      reasonCode: "worker.upcall.malformed",
    });
  });

  it("reports the channel in the handshake, and its absence stays absent", () => {
    check("worker_hello_channel", WorkerHelloResponseSchema, {
      protocol: { major: 1, minor: 0 },
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      platform: "macos",
      architecture: "aarch64",
      capabilities: ["worker.roots.v1", "worker.upcall.v1"],
      maxFrameBytes: 1 << 20,
      maxFileChunkBytes: 256 << 10,
      maxTextFileBytes: 1 << 20,
      runtimeVersion: "0.1.0",
      channel: {
        workerInstanceId: "abcdef0123456789abcdef0123456789",
        socket: "/tmp/状态/worker-upcall.sock",
        highestSequence: 9_007_199_254_740_993n,
        unacknowledged: 3,
        maxUnacknowledged: 1024,
        state: WorkerChannelState.REPLAYING,
        reasonCode: "worker.upcall.replaying",
      },
    });
    // The first-phase Hello fixture predates the field and must decode with
    // no channel at all, not with a default one that claims a disabled
    // channel this Worker never described.
    const legacy = fromBinary(
      WorkerHelloResponseSchema,
      toBinary(
        WorkerHelloResponseSchema,
        create(WorkerHelloResponseSchema, { instanceId: "no-channel" }),
      ),
    );
    expect(legacy.channel).toBeUndefined();
    expect(create(WorkerChannelCapabilitySchema, {}).state).toBe(
      WorkerChannelState.UNSPECIFIED,
    );
  });
});
