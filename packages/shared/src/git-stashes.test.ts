import { describe, expect, it } from "vitest";
import {
  gitRepositoryActionSchema,
  gitStashDetailSchema,
  gitStashSnapshotSchema,
} from "./git-repository";
const oid = "a".repeat(40);
const token = "b".repeat(64);
describe("stash request boundaries", () => {
  it("requires a fixed object and complete state token for destructive actions", () => {
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "dropStash",
        oid,
        expectedStateToken: token,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { kind: "dropStash", oid },
      { kind: "dropStash", oid: "stash@{0}", expectedStateToken: token },
      { kind: "dropStash", oid, expectedStateToken: "old" },
      { kind: "dropStash", oid, expectedStateToken: token, force: true },
    ])
      expect(gitRepositoryActionSchema.safeParse(invalid).success).toBe(false);
  });
  it("requires explicit untracked and index behavior instead of silently defaulting", () => {
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "createStash",
        message: "保存",
        expectedStateToken: token,
      }).success,
    ).toBe(false);
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "popStash",
        oid,
        expectedStateToken: token,
      }).success,
    ).toBe(false);
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "createStash",
        message: "保存",
        includeUntracked: true,
        expectedStateToken: token,
      }).success,
    ).toBe(true);
    expect(
      gitRepositoryActionSchema.safeParse({
        kind: "applyStash",
        oid,
        reinstateIndex: false,
        expectedStateToken: token,
      }).success,
    ).toBe(true);
  });
  it("rejects incomplete snapshots and malformed stash topology", () => {
    expect(
      gitStashSnapshotSchema.safeParse({
        repositoryId: "repo",
        repositoryPath: "/project",
        head: { headOid: oid, branch: "main" },
        dirty: true,
        hasConflicts: false,
        stashes: [],
      }).success,
    ).toBe(false);
    expect(
      gitStashDetailSchema.safeParse({
        oid,
        parents: [oid],
        patch: "",
        stagedPatch: "",
        untrackedPatch: "",
      }).success,
    ).toBe(false);
    expect(
      gitStashDetailSchema.safeParse({
        oid,
        parents: [oid, oid],
        patch: "",
        stagedPatch: "",
        untrackedPatch: "",
      }).success,
    ).toBe(true);
  });
});
