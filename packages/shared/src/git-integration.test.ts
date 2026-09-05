import { describe, expect, it } from "vitest";
import {
  gitRepositoryActionSchema,
  gitRepositoryOperationSchema,
} from "./git-repository";
import {
  gitConflictSideSchema,
  gitIntegrationSnapshotSchema,
} from "./git-integration";
const oid = "a".repeat(40),
  token = "b".repeat(64);
describe("integration contracts", () => {
  it("requires a fixed target and state for begin, and an owner session for recovery", () => {
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "startMerge",
        targetOid: "topic",
        message: "",
        expectedStateToken: token,
      }).success,
    ).toBe(false);
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "startMerge",
        targetOid: oid,
        message: "",
        expectedStateToken: token,
      }).success,
    ).toBe(true);
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "abortIntegration",
        expectedStateToken: token,
      }).success,
    ).toBe(false);
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "abortIntegration",
        sessionId: "11111111-1111-4111-8111-111111111111",
        expectedStateToken: token,
        force: true,
      }).success,
    ).toBe(false);
  });
  it("represents bounded binary and missing-side conflict information", () => {
    expect(
      gitConflictSideSchema.safeParse({
        oid,
        mode: "160000",
        size: 120,
        preview: "",
        binary: null,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      gitConflictSideSchema.safeParse({
        oid,
        mode: "100644",
        size: -1,
        preview: "",
        binary: null,
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      gitIntegrationSnapshotSchema.safeParse({
        repositoryId: "r",
        repositoryPath: "/p",
        head: { headOid: oid, branch: "main" },
        stateToken: token,
        kind: "merge",
        owned: false,
        sessionId: null,
        originalHead: oid,
        targetOid: oid,
        message: "Merge",
        dirty: true,
        canContinue: false,
        conflicts: [
          {
            path: "new file",
            base: null,
            ours: null,
            theirs: {
              oid,
              mode: "100644",
              size: 0,
              preview: "",
              binary: false,
              truncated: false,
            },
          },
        ],
      }).success,
    ).toBe(true);
  });
  it("distinguishes awaiting resolution from completed success", () => {
    const op = {
      id: "operation",
      repositoryId: "r",
      repositoryPath: "/p",
      workspaceRoot: "/p",
      action: {
        kind: "startMerge",
        targetOid: oid,
        message: "",
        expectedStateToken: token,
      },
      state: "awaitingResolution",
      cancellationRequested: false,
      createdAt: "now",
      finishedAt: "now",
      message: "Merge paused",
    };
    expect(gitRepositoryOperationSchema.parse(op).state).toBe(
      "awaitingResolution",
    );
  });
});
