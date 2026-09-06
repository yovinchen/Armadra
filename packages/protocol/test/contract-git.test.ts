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
  EnqueueGitOperationRequestSchema,
  EventDomain,
  EventEnvelopeSchema,
  GitActionKind,
  GitCloneJobSchema,
  GitCloneState,
  GitDomainSnapshotSchema,
  GitOperationSchema,
  GitOperationState,
  GitReadMethod,
  GitWorkerRequestSchema,
  GitWorkerResponseSchema,
  RepositoryScopeSchema,
  RepositoryStateSchema,
  WorkerRequestSchema,
  WorkerUpcallSchema,
  WorkerGitUpcallKind,
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

const scope = {
  workspaceId: "0123456789abcdef0123456789abcdef",
  repositoryId:
    "3b1f0a2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
  repositoryPath: "/home/用户/项目/armadra",
};

// The git domain (Go Host 业务所有权迁移 §2.8, Git 设计 §2, §10).
//
// The browser is where a person presses "push", and it is where the answer
// "we do not know whether that push reached the remote" has to be rendered as
// something other than a failure. So it reads the same fixtures the Go and
// Rust sides do, and the states stay distinguishable all the way to the UI.
describe("git operations", () => {
  it("keeps a queued push's action body, digest and expectations", () => {
    check("git_operation_queued", GitOperationSchema, {
      operationId: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f",
      scope,
      action: new TextEncoder().encode(
        '{"kind":"push","remote":"origin","branch":"功能/推送"}',
      ),
      actionSha256: new Uint8Array(32).fill(9),
      expected: {
        headOid: "1f2e3d4c5b6a798807162534435261708f9e0d1c",
        refName: "refs/heads/功能/推送",
        refOid: "aabbccddeeff00112233445566778899aabbccdd",
      },
      kind: GitActionKind.PUSH,
      state: GitOperationState.QUEUED,
      createdAtUnixMs: 1_788_557_000_000n,
      revision: 1n,
    });
  });

  it("keeps an interrupted push as its own state", () => {
    check("git_operation_unknown_outcome", GitOperationSchema, {
      operationId: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f",
      scope,
      actionSha256: new Uint8Array(32).fill(9),
      affected: ["refs/heads/功能/推送"],
      progress: 60,
      kind: GitActionKind.PUSH,
      state: GitOperationState.UNKNOWN_OUTCOME,
      messageCode: "git.operation.interrupted",
      createdAtUnixMs: 1_788_557_000_000n,
      startedAtUnixMs: 1_788_557_000_500n,
      finishedAtUnixMs: 1_788_557_900_000n,
      revision: 4n,
    });
    expect(GitOperationState.UNKNOWN_OUTCOME).not.toBe(
      GitOperationState.FAILED,
    );
  });

  it("keeps a repository snapshot's observation time and conflict state", () => {
    check("git_repository_state_conflict", RepositoryStateSchema, {
      scope,
      headOid: "1f2e3d4c5b6a798807162534435261708f9e0d1c",
      detached: true,
      indexFingerprint: new Uint8Array(32).fill(3),
      worktreeFingerprint: new Uint8Array(32).fill(4),
      upstream: "origin/main",
      ahead: 2,
      behind: 7,
      operationState: GitOperationState.AWAITING_RESOLUTION,
      observedAtUnixMs: 1_788_557_900_000n,
      // Past 2^53: a revision that arrived as a JavaScript number would
      // compare equal to its predecessor and the CAS would stop protecting
      // anything.
      revision: 9_007_199_254_740_993n,
    });
  });

  it("carries a clone by digest and redacted URL, never by URL", () => {
    check("git_clone_job", GitCloneJobSchema, {
      jobId: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8ea0",
      workspaceId: "0123456789abcdef0123456789abcdef",
      urlSha256: new Uint8Array(32).fill(5),
      displayUrl: "https://example.invalid/组织/仓库.git",
      targetPath: "/home/用户/项目/仓库",
      progress: 42,
      state: GitCloneState.RUNNING,
      createdAtUnixMs: 1_788_557_000_000n,
      updatedAtUnixMs: 1_788_557_900_000n,
      revision: 2n,
    });
    expect(Object.keys(create(GitCloneJobSchema, {}))).not.toContain("url");
  });

  it("reports what the Worker still holds before a switch", () => {
    check("git_worker_snapshot", GitWorkerResponseSchema, {
      result: {
        case: "snapshot",
        value: {
          queued: 1,
          running: 1,
          cloneJobs: 0,
          activeOperationIds: ["0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f"],
        },
      },
    });
    // An empty snapshot is the only one a switch may proceed on, and it is a
    // real message rather than an absent one.
    const drained = create(GitDomainSnapshotSchema, {});
    expect(drained.queued + drained.running + drained.cloneJobs).toBe(0);
  });

  it("forwards a read with the status the Runtime route would have returned", () => {
    check("git_worker_read", GitWorkerRequestSchema, {
      action: {
        case: "read",
        value: {
          scope,
          requestJson: new TextEncoder().encode(
            '{"path":".","reference":"HEAD"}',
          ),
          workspaceRoot: "/home/用户/项目",
          method: GitReadMethod.HISTORY,
        },
      },
    });
  });

  it("routes every write through one enqueue entry", () => {
    check("git_enqueue_request", EnqueueGitOperationRequestSchema, {
      meta: {
        requestId: "git-1",
        scope: { workspaceId: "0123456789abcdef0123456789abcdef" },
      },
      operationId: "git/0123456789abcdef0123456789abcdef/stage-1",
      scope,
      action: new TextEncoder().encode(
        '{"kind":"stage","paths":["源码/主.rs"]}',
      ),
      actionSha256: new Uint8Array(32).fill(6),
      expected: { indexFingerprint: new Uint8Array(32).fill(3) },
      kind: GitActionKind.STAGE,
    });
  });

  it("travels on worker action 29 and event envelope members 220-222", () => {
    const request = create(WorkerRequestSchema, {
      requestId: "h-git-1",
      hostId: "0123456789abcdef0123456789abcdef",
      action: {
        case: "git",
        value: { action: { case: "snapshot", value: {} } },
      },
    });
    expect(
      WorkerRequestSchema.fields.find((field) => field.name === "git")?.number,
    ).toBe(29);
    expect(
      fromBinary(WorkerRequestSchema, toBinary(WorkerRequestSchema, request)),
    ).toEqual(request);

    for (const [name, number] of [
      ["git_operation", 220],
      ["git_repository_state", 221],
      ["git_clone_job", 222],
    ] as const) {
      expect(
        EventEnvelopeSchema.fields.find((field) => field.name === name)?.number,
      ).toBe(number);
    }

    const envelope = create(EventEnvelopeSchema, {
      sequence: 41n,
      domain: EventDomain.GIT,
      kind: "operation",
      entityId: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f",
      workspaceId: "0123456789abcdef0123456789abcdef",
      revision: 4n,
      entity: {
        case: "gitOperation",
        value: {
          operationId: "0193b5c0-8f6a-7c31-9d2e-4a5b6c7d8e9f",
          scope,
          kind: GitActionKind.PUSH,
          state: GitOperationState.UNKNOWN_OUTCOME,
        },
      },
    });
    expect(
      fromBinary(EventEnvelopeSchema, toBinary(EventEnvelopeSchema, envelope)),
    ).toEqual(envelope);
  });

  it("reports an externally changed repository on channel member 180", () => {
    check("git_upcall_repository_changed", WorkerUpcallSchema, {
      requestId: "w-7",
      workerInstanceId: "abcdef0123456789abcdef0123456789",
      sequence: 7n,
      attempt: 1,
      emittedAtUnixMs: 1_788_557_900_000n,
      event: {
        case: "git",
        value: {
          workspaceId: "0123456789abcdef0123456789abcdef",
          repositoryPath: "/home/用户/项目/armadra",
          kind: WorkerGitUpcallKind.REPOSITORY_CHANGED,
          reasonCode: "git.repository.external",
          observedAtUnixMs: 1_788_557_900_000n,
          repository: {
            scope,
            headOid: "aabbccddeeff00112233445566778899aabbccdd",
            branch: "main",
            observedAtUnixMs: 1_788_557_900_000n,
          },
        },
      },
    });
    expect(
      WorkerUpcallSchema.fields.find((field) => field.name === "git")?.number,
    ).toBe(180);
  });

  // A linked worktree and its main checkout are one repository, so the id is
  // shared and only the path says which working tree is being written. A
  // caller that keyed a queue on the id alone would serialize two independent
  // checkouts against each other.
  it("keeps the repository id and the checkout path as separate facts", () => {
    const main = create(RepositoryScopeSchema, scope);
    const linked = create(RepositoryScopeSchema, {
      ...scope,
      repositoryPath: "/home/用户/项目/armadra-功能",
      worktreeId: "功能",
    });
    expect(linked.repositoryId).toBe(main.repositoryId);
    expect(linked.repositoryPath).not.toBe(main.repositoryPath);
  });
});
