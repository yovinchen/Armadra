import { describe, expect, it } from "vitest";
import {
  gitExpectedStateSchema,
  gitHistoryPageSchema,
  gitRepositoryActionSchema,
  gitRepositoryOperationSchema,
  gitRepositoryListSchema,
  gitRepositoryRecordSchema,
  gitWorktreeRecordSchema,
} from "./git-repository";
import { frameBindingSchema, groupNodeDataSchema } from "./domain";
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
  it("keeps an unknown dirty count distinct from a clean repository", () => {
    const base = {
      repositoryId: "a".repeat(64),
      repositoryPath: "apps/inner",
      name: "inner",
      kind: "nested" as const,
      parentRepositoryId: "b".repeat(64),
      headBranch: "main",
    };
    // Null means "not counted" — no execution grant — and must never be read
    // as "no changes"; the panel renders the two differently.
    expect(
      gitRepositoryRecordSchema.parse({ ...base, dirtyCount: null }).dirtyCount,
    ).toBeNull();
    expect(
      gitRepositoryRecordSchema.parse({ ...base, dirtyCount: 0 }).dirtyCount,
    ).toBe(0);
    expect(
      gitRepositoryRecordSchema.safeParse({ ...base, dirtyCount: -1 }).success,
    ).toBe(false);
    expect(
      gitRepositoryRecordSchema.safeParse({ ...base, kind: "linked" }).success,
    ).toBe(false);
    // The workspace root is addressed as `.` and has no parent.
    expect(
      gitRepositoryListSchema.parse({
        workspaceRoot: "/workspace",
        maxDepth: 4,
        repositories: [
          {
            ...base,
            repositoryPath: ".",
            kind: "root",
            parentRepositoryId: null,
            dirtyCount: 3,
          },
        ],
        truncated: false,
        observedAt: "2026-09-06T00:00:00Z",
      }).repositories[0]!.repositoryPath,
    ).toBe(".");
  });
  it("binds a Frame to a checkout without implying the script has run", () => {
    const binding = frameBindingSchema.parse({
      worktreePath: "checkouts/feature",
      branch: "feature",
      repositoryId: "c".repeat(64),
    });
    expect(binding.initScript).toBeNull();
    expect(binding.initScriptState).toBe("none");
    expect(binding.initScriptNodeId).toBeNull();
    // A Frame with no binding is the ordinary case and must stay parseable:
    // the key is simply absent, exactly as it is on every board saved so far.
    expect(
      groupNodeDataSchema.parse({ kind: "group" }).binding,
    ).toBeUndefined();
    expect(
      groupNodeDataSchema.parse({ kind: "group", binding }).binding?.branch,
    ).toBe("feature");
    expect(
      frameBindingSchema.safeParse({
        worktreePath: "checkouts/feature",
        branch: "",
        repositoryId: "c".repeat(64),
      }).success,
    ).toBe(false);
  });
});
