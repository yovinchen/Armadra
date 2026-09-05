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
      {
        kind: "push",
        remote: "origin",
        branch: "main",
        setUpstream: false,
        forceWithLease: null,
      },
      {
        kind: "sync",
        remote: "origin",
        branch: "main",
        expectedRemoteOid: oid,
      },
      {
        kind: "sync",
        remote: "origin",
        branch: "main",
        expectedRemoteOid: null,
      },
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
  it("overwrites remote history only through a lease naming the remote OID", () => {
    const push = {
      kind: "push",
      remote: "origin",
      branch: "main",
      setUpstream: false,
    };
    expect(
      gitRepositoryActionSchema.parse({
        ...push,
        forceWithLease: { expectedRemoteOid: oid },
      }),
    ).toEqual({ ...push, forceWithLease: { expectedRemoteOid: oid } });
    for (const rejected of [
      push,
      { ...push, forceWithLease: {} },
      { ...push, forceWithLease: { expectedRemoteOid: "HEAD" } },
      { ...push, forceWithLease: { expectedRemoteOid: oid, force: true } },
    ])
      expect(gitRepositoryActionSchema.safeParse(rejected).success).toBe(false);
  });
  it("binds sync to the reviewed remote position and offers no strategy escape", () => {
    const sync = { kind: "sync", remote: "origin", branch: "main" };
    expect(gitRepositoryActionSchema.safeParse(sync).success).toBe(false);
    expect(
      gitRepositoryActionSchema.safeParse({
        ...sync,
        expectedRemoteOid: null,
        strategy: "merge",
      }).success,
    ).toBe(false);
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
