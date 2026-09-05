import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeApi } from "./client";
const oid = "a".repeat(40);
const operation = {
  id: "operation/id",
  repositoryId: "repo",
  workspaceRoot: "/repo",
  repositoryPath: "/repo",
  action: { kind: "fetch", remote: "origin", prune: false },
  state: "queued",
  cancellationRequested: false,
  createdAt: "now",
  finishedAt: null,
  message: null,
};
afterEach(() => vi.unstubAllGlobals());
describe("repository API client", () => {
  it("encodes scope and opaque cursors and validates actual response DTOs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          repositoryId: "repo",
          repositoryPath: "/repo",
          head: { headOid: oid, branch: "main" },
          branches: [],
          remotes: [],
          observedAt: "now",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          reference: "feature/a",
          anchorOid: oid,
          commits: [],
          nextCursor: null,
          shallow: false,
        }),
      )
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetch);
    await runtimeApi.gitRepositoryBranches("workspace/id");
    await runtimeApi.gitRepositoryHistory(
      "workspace/id",
      "feature/a",
      "cursor&next=bad",
    );
    await runtimeApi.gitRepositoryWorktrees("workspace/id");
    expect(fetch.mock.calls[0]![0]).toContain(
      "/workspaces/workspace%2Fid/git/repository/branches?path=.",
    );
    expect(fetch.mock.calls[1]![0]).toContain(
      "reference=feature%2Fa&limit=50&cursor=cursor%26next%3Dbad",
    );
    expect(fetch.mock.calls[2]![0]).toContain("/worktrees?path=.");
  });
  it("submits explicit CAS and distinct scoped cancel once, without a force field", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => Response.json(operation));
    vi.stubGlobal("fetch", fetch);
    await runtimeApi.gitRepositoryOperate(
      "workspace",
      { kind: "fetch", remote: "origin", prune: false },
      { headOid: oid, branch: "main" },
    );
    await runtimeApi.gitRepositoryOperation("workspace", "operation/id");
    await runtimeApi.gitRepositoryCancel("workspace", "operation/id");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      path: ".",
      action: { kind: "fetch", remote: "origin", prune: false },
      expected: { headOid: oid, branch: "main" },
    });
    expect(fetch.mock.calls[2]![0]).toContain(
      "/operations/operation%2Fid/cancel",
    );
    expect(fetch.mock.calls[2]![1].method).toBe("POST");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("rejects malformed success instead of reporting a completed operation", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      runtimeApi.gitRepositoryOperate(
        "workspace",
        { kind: "fetch", remote: "origin", prune: false },
        { headOid: null, branch: null },
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
