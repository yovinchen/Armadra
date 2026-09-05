import { describe, expect, it } from "vitest";
import {
  gitExpectedStateSchema,
  gitHistoryPageSchema,
  gitRepositoryActionSchema,
  gitRepositoryOperationSchema,
  gitWorktreeRecordSchema,
} from "./git-repository";
const oid = "a".repeat(40);
describe("Git repository wire contract", () => {
  it("requires explicit unborn/detached state and rejects implicit CAS bypass", () => {
    expect(
      gitExpectedStateSchema.parse({ headOid: null, branch: null }),
    ).toEqual({ headOid: null, branch: null });
    expect(gitExpectedStateSchema.safeParse({}).success).toBe(false);
    expect(
      gitExpectedStateSchema.safeParse({ headOid: "HEAD", branch: "main" })
        .success,
    ).toBe(false);
  });
  it("supports every bounded action and rejects force-shaped fields", () => {
    for (const action of [
      {
        kind: "createBranch",
        name: "feature",
        startPoint: null,
        switch: false,
      },
      { kind: "switchBranch", name: "feature", expectedOid: oid },
      { kind: "deleteBranch", name: "feature", expectedOid: oid },
      { kind: "fetch", remote: "origin", prune: false },
      { kind: "pull", remote: "origin", branch: "main" },
      { kind: "push", remote: "origin", branch: "main", setUpstream: false },
      {
        kind: "createWorktree",
        expectedOid: null,
        path: "trees/feature",
        branch: "feature",
        createBranch: true,
        startPoint: null,
      },
      {
        kind: "removeWorktree",
        path: "trees/feature",
        expectedOid: oid,
        allowUnpublished: false,
      },
    ]) {
      expect(gitRepositoryActionSchema.safeParse(action).success).toBe(true);
      expect(
        gitRepositoryActionSchema.safeParse({ ...action, force: true }).success,
      ).toBe(false);
    }
  });
  it("preserves unknown outcomes, missing dirty state and page boundary identity", () => {
    const value = gitRepositoryOperationSchema.parse({
      id: "operation",
      repositoryId: "repo",
      workspaceRoot: "/repo",
      repositoryPath: "/repo",
      action: { kind: "fetch", remote: "origin", prune: false },
      state: "unknownOutcome",
      cancellationRequested: true,
      createdAt: "now",
      finishedAt: null,
      message: null,
    });
    expect(value.state).toBe("unknownOutcome");
    expect(
      gitWorktreeRecordSchema.parse({
        path: "/outside",
        headOid: null,
        branch: null,
        detached: true,
        bare: false,
        isMain: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        accessible: false,
        dirty: null,
      }).dirty,
    ).toBeNull();
    expect(
      gitHistoryPageSchema.parse({
        reference: "HEAD",
        anchorOid: oid,
        commits: [],
        nextCursor: "opaque",
        shallow: true,
      }).nextCursor,
    ).toBe("opaque");
  });
});
