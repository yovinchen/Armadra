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
  EventDomain,
  EventEnvelopeSchema,
  ReverseExportRecordSchema,
  SessionAttachState,
  SessionKind,
  SessionRunSchema,
  SessionSchema,
  SessionStatus,
  SessionWorkerResponseSchema,
  TerminationIntent,
  WorkerRequestSchema,
  WorkerSessionUpcallKind,
  WorkerSessionUpcallSchema,
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

const beyondDouble = 9_007_199_254_740_993n;
const maxUint64 = 18_446_744_073_709_551_615n;

// The session domain (Go Host 业务所有权迁移 §2.6).
//
// The browser reads these because it is the side that decides whether to draw a
// terminal as running, waiting to be started, or lost. Those are three
// different pictures, and reading a LOST session as EXITED would offer the user
// a second process on top of one that is very likely still alive.
describe("sessions", () => {
  it("keeps a running agent session's frozen launch", () => {
    check("session_agent_running", SessionSchema, {
      sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
      workspaceId: "0123456789abcdef0123456789abcdef",
      executionHostId: "构建机",
      sessionKey: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      ownerNodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      launch: {
        shell: "/bin/zsh",
        command: "claude",
        args: ["--permission-mode", "plan"],
        agent: {
          agentId: "claude",
          workingDirectory: "/srv/项目/armadra",
          args: ["--permission-mode", "plan"],
          permissionMode: "plan",
        },
        envRefs: ["ANTHROPIC_API_KEY"],
        launchSha256: new TextEncoder().encode(
          "0123456789abcdef0123456789abcdef",
        ),
        workingDirectory: "/srv/项目/armadra",
      },
      backendKind: "tmux",
      generation: 7n,
      kind: SessionKind.AGENT,
      status: SessionStatus.RUNNING,
      attachState: SessionAttachState.ATTACHED,
      terminationIntent: TerminationIntent.NONE,
      createdAtUnixMs: 1_788_557_000_000n,
      updatedAtUnixMs: 1_788_557_900_000n,
      lastOutputAtUnixMs: 1_788_557_800_000n,
      revision: beyondDouble,
    });
  });

  it("keeps a run's opaque backend reference and its exit code", () => {
    check("session_run", SessionRunSchema, {
      sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
      generation: 7n,
      workerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      backendRef: "armadra-3f7c0a12:0.0",
      exitCode: 130,
      reasonCode: "session.terminated.process",
      startedAtUnixMs: 1_788_557_000_000n,
      endedAtUnixMs: 1_788_557_900_000n,
      revision: maxUint64,
    });
  });

  it("keeps the revision on a closed session's tombstone", () => {
    check("session_tombstone", SessionSchema, {
      sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
      workspaceId: "0123456789abcdef0123456789abcdef",
      sessionKey: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      updatedAtUnixMs: 1_788_557_900_000n,
      revision: 4n,
      deleted: true,
    });
  });

  it("reads the Worker's own listing of its sessions", () => {
    check("session_worker_states", SessionWorkerResponseSchema, {
      result: {
        case: "sessions",
        value: {
          workerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
          sessions: [
            {
              sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
              workspaceId: "0123456789abcdef0123456789abcdef",
              sessionKey: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
              ownerNodeId: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
              backendKind: "tmux",
              backendRef: "armadra-3f7c0a12:0.0",
              generation: 7n,
              kind: SessionKind.TERMINAL,
              status: SessionStatus.RUNNING,
              attachState: SessionAttachState.DETACHED,
              launch: {
                shell: "/bin/zsh",
                workingDirectory: "/home/用户/项目",
              },
            },
          ],
        },
      },
    });
  });

  it("reports a lost run as lost, with no exit code", () => {
    check("session_upcall_run_lost", WorkerSessionUpcallSchema, {
      sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
      workspaceId: "0123456789abcdef0123456789abcdef",
      sessionKey: "3f7c0a12-9b5e-4d21-8a6f-2c1b0d9e8a77",
      generation: 7n,
      workerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      kind: WorkerSessionUpcallKind.RUN_LOST,
      reasonCode: "session.run.unreachable",
      observedAtUnixMs: 1_788_557_900_000n,
    });
  });

  // A program that finished with status zero and one nobody watched end are
  // different facts. Only the second is worth offering to restart.
  it("distinguishes an exit code of zero from an absent one", () => {
    const finished = create(SessionSchema, { sessionId: "s", exitCode: 0 });
    const unknown = create(SessionSchema, { sessionId: "s" });
    expect(toBinary(SessionSchema, finished)).not.toEqual(
      toBinary(SessionSchema, unknown),
    );
    expect(
      fromBinary(SessionSchema, toBinary(SessionSchema, unknown)).exitCode,
    ).toBeUndefined();
    expect(
      fromBinary(SessionSchema, toBinary(SessionSchema, finished)).exitCode,
    ).toBe(0);
  });

  it("travels on worker action 27, upcall member 140 and envelope 160/161", () => {
    const request = create(WorkerRequestSchema, {
      requestId: "h-session-1",
      hostId: "0123456789abcdef0123456789abcdef",
      action: {
        case: "session",
        value: { action: { case: "listSessions", value: {} } },
      },
    });
    expect(
      WorkerRequestSchema.fields.find((field) => field.name === "session")
        ?.number,
    ).toBe(27);
    expect(
      fromBinary(WorkerRequestSchema, toBinary(WorkerRequestSchema, request)),
    ).toEqual(request);

    const upcall = create(WorkerUpcallSchema, {
      requestId: "w-session-1",
      workerInstanceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      sequence: 3n,
      attempt: 1,
      event: {
        case: "session",
        value: {
          sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
          generation: 7n,
          kind: WorkerSessionUpcallKind.RUN_STARTED,
        },
      },
    });
    expect(
      WorkerUpcallSchema.fields.find((field) => field.name === "session")
        ?.number,
    ).toBe(140);
    expect(
      fromBinary(WorkerUpcallSchema, toBinary(WorkerUpcallSchema, upcall)),
    ).toEqual(upcall);

    const envelope = create(EventEnvelopeSchema, {
      sequence: 12n,
      domain: EventDomain.SESSION,
      kind: "session",
      entityId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8",
      workspaceId: "0123456789abcdef0123456789abcdef",
      revision: 3n,
      entity: {
        case: "session",
        value: { sessionId: "8f2d1c4a6b7e40a9b1c2d3e4f5a6b7c8", revision: 3n },
      },
    });
    expect(
      EventEnvelopeSchema.fields.find((field) => field.name === "session")
        ?.number,
    ).toBe(160);
    expect(
      EventEnvelopeSchema.fields.find((field) => field.name === "session_run")
        ?.number,
    ).toBe(161);
    expect(
      fromBinary(EventEnvelopeSchema, toBinary(EventEnvelopeSchema, envelope)),
    ).toEqual(envelope);

    for (const record of [
      create(ReverseExportRecordSchema, {
        entity: { case: "session", value: { sessionId: "s", revision: 1n } },
      }),
      create(ReverseExportRecordSchema, {
        entity: {
          case: "sessionRun",
          value: { sessionId: "s", generation: 1n },
        },
      }),
    ]) {
      expect(
        fromBinary(
          ReverseExportRecordSchema,
          toBinary(ReverseExportRecordSchema, record),
        ),
      ).toEqual(record);
    }
  });
});
