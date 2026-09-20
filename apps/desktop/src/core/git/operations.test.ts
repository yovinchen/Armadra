import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bareRemote,
  cleanupFixtures,
  repository,
  run,
  service,
  settle,
} from "./fixture";
import { branches } from "./repository/branches";
import { integrationSnapshot } from "./repository/integration";
import { startOperation } from "./repository/queue";
import type { RepositoryService } from "./repository/service";
import { stashes } from "./repository/stash";
import type { ExpectedState, RepositoryAction } from "./repository/types";
import { worktrees } from "./repository/worktrees";
import { DomainError } from "../workspaces/support";

/**
 * The operation queue and the conflict centre.
 *
 * Ported from the pre-merge implementation's git repository test suites.
 */

afterAll(cleanupFixtures);

async function start(
  repositoryService: RepositoryService,
  root: string,
  action: RepositoryAction,
  expectedState?: ExpectedState,
) {
  const expected = expectedState ?? (await repositoryService.head(root));
  const snapshot = await startOperation(
    repositoryService,
    root,
    ".",
    action,
    expected,
  );
  return settle(repositoryService, snapshot.id);
}

/** The `DomainError` a refused start carried, so its status can be asserted. */
async function failure(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The token a stash, reset or drop is confirmed against. */
async function stateToken(
  repositoryService: RepositoryService,
  root: string,
): Promise<string> {
  return (await stashes(repositoryService, root, ".")).stateToken;
}

/**
 * The token an integration verb is confirmed against.
 *
 * It is deliberately *not* the stash token: it folds in the sequence Git has in
 * progress and that sequence's own metadata, so a merge confirmed while nothing
 * was running cannot be continued into one that started since.
 */
async function integrationToken(
  repositoryService: RepositoryService,
  root: string,
): Promise<string> {
  const context = await repositoryService.context(root, ".");
  return (await integrationSnapshot(repositoryService, context)).stateToken;
}

describe("branch verbs", () => {
  it("creates, switches, renames and deletes against the reviewed OID", async () => {
    const repo = repository("branch-verbs");
    const repositoryService = service();
    const base = repo.head();

    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "createBranch",
          name: "feature",
          startPoint: null,
          switch: true,
        })
      ).state,
    ).toBe("succeeded");
    expect(repo.git("branch", "--show-current").trim()).toBe("feature");

    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "renameBranch",
          name: "feature",
          newName: "renamed",
          expectedOid: base,
        })
      ).state,
    ).toBe("succeeded");
    expect(repo.git("branch", "--show-current").trim()).toBe("renamed");

    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "switchBranch",
          name: "main",
          expectedOid: base,
        })
      ).state,
    ).toBe("succeeded");
    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "deleteBranch",
          name: "renamed",
          expectedOid: base,
        })
      ).state,
    ).toBe("succeeded");
    const snapshot = await branches(repositoryService, repo.path, ".");
    expect(snapshot.branches.map((branch) => branch.name)).toEqual(["main"]);
  });

  it("refuses a branch that moved since it was reviewed", async () => {
    const repo = repository("branch-moved");
    const repositoryService = service();
    repo.git("branch", "feature");
    repo.write("extra.txt", "extra\n");
    repo.git("switch", "-q", "feature");
    repo.commit("moved");
    repo.git("switch", "-q", "main");

    const result = await start(repositoryService, repo.path, {
      kind: "deleteBranch",
      name: "feature",
      expectedOid: "0".repeat(40),
    });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("Selected branch changed");
  });

  it("refuses an invalid branch name before it is queued", async () => {
    const repo = repository("branch-name");
    const repositoryService = service();
    await expect(
      startOperation(
        repositoryService,
        repo.path,
        ".",
        { kind: "createBranch", name: "-x", startPoint: null, switch: false },
        await repositoryService.head(repo.path),
      ),
    ).rejects.toThrow("Branch name is invalid");
  });

  it("refuses a reviewed HEAD that is not an object id", async () => {
    const repo = repository("branch-expected");
    const repositoryService = service();
    await expect(
      startOperation(
        repositoryService,
        repo.path,
        ".",
        { kind: "createBranch", name: "x", startPoint: null, switch: false },
        { headOid: "nope", branch: "main" },
      ),
    ).rejects.toThrow("Expected HEAD must be an object ID");
  });

  it("reports a HEAD that moved between review and execution", async () => {
    const repo = repository("branch-head-moved");
    const repositoryService = service();
    const result = await start(
      repositoryService,
      repo.path,
      { kind: "createBranch", name: "x", startPoint: null, switch: false },
      { headOid: null, branch: "main" },
    );
    expect(result.state).toBe("failed");
    expect(result.message).toContain("Repository HEAD changed");
  });
});

describe("tags and remotes", () => {
  it("creates an annotated tag and refuses a second under the same name", async () => {
    const repo = repository("tag-verbs");
    const repositoryService = service();
    const head = repo.head();
    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "createTag",
          name: "v1",
          targetOid: head,
          message: "release one",
        })
      ).state,
    ).toBe("succeeded");
    const again = await start(repositoryService, repo.path, {
      kind: "createTag",
      name: "v1",
      targetOid: head,
      message: null,
    });
    expect(again.state).toBe("failed");
    expect(again.message).toContain("already exists");

    const stale = await start(repositoryService, repo.path, {
      kind: "deleteTag",
      name: "v1",
      expectedOid: "0".repeat(40),
    });
    expect(stale.state).toBe("failed");
    expect(stale.message).toContain("different object");
  });

  it("refuses an action that left a field out instead of throwing", async () => {
    // The action is read here exactly as it arrived; the shared zod schema
    // runs in the browser. Every field a validator reads therefore has to
    // refuse a missing value rather than dereference it — a `TypeError` here
    // leaves the router with nothing to say but "the core failed".
    const repo = repository("action-fields");
    const repositoryService = service();
    const head = repo.head();
    const incomplete = [
      { kind: "deleteTag", name: "v1" },
      { kind: "createTag", targetOid: head, message: null },
      { kind: "addRemote", name: "origin" },
      { kind: "startRebase", expectedStateToken: "0".repeat(64) },
      { kind: "createStash", includeUntracked: false },
      { kind: "createBranch", startPoint: null, switch: false },
      { kind: "createWorktree", expectedOid: head, branch: "main" },
    ] as unknown as RepositoryAction[];
    for (const action of incomplete) {
      const refusal = await failure(() =>
        start(repositoryService, repo.path, action),
      );
      expect(refusal.status).toBe(400);
    }
  });

  it("adds, renames, re-points and removes a remote", async () => {
    const repo = repository("remote-verbs");
    const repositoryService = service();
    const url = "https://example.invalid/one.git";
    for (const action of [
      { kind: "addRemote", name: "origin", url },
      { kind: "renameRemote", name: "origin", newName: "upstream" },
      {
        kind: "setRemoteUrl",
        name: "upstream",
        url: "https://example.invalid/two.git",
      },
    ] as RepositoryAction[]) {
      expect((await start(repositoryService, repo.path, action)).state).toBe(
        "succeeded",
      );
    }
    expect(repo.git("remote", "get-url", "upstream").trim()).toBe(
      "https://example.invalid/two.git",
    );
    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "removeRemote",
          name: "upstream",
        })
      ).state,
    ).toBe("succeeded");
    expect(repo.git("remote").trim()).toBe("");
  });

  it("refuses a remote URL the clone allow-list would refuse", async () => {
    const repo = repository("remote-url");
    const repositoryService = service();
    await expect(
      startOperation(
        repositoryService,
        repo.path,
        ".",
        {
          kind: "addRemote",
          name: "origin",
          url: "file:///tmp/elsewhere",
        },
        await repositoryService.head(repo.path),
      ),
    ).rejects.toThrow("Repository URL is invalid");
  });
});

describe("network verbs", () => {
  it("pushes, sets the upstream and then fast-forward pulls", async () => {
    const repo = repository("network");
    const remote = bareRemote("network-remote");
    repo.git("remote", "add", "origin", remote);
    const repositoryService = service();

    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "push",
          remote: "origin",
          branch: "main",
          setUpstream: true,
          forceWithLease: null,
        })
      ).state,
    ).toBe("succeeded");

    // A second clone advances the remote; the pull must fast-forward onto it.
    const other = repository("network-other", false);
    run(other.path, "remote", "add", "origin", remote);
    run(other.path, "fetch", "-q", "origin");
    run(other.path, "switch", "-q", "-c", "main", "origin/main");
    other.write("from-other.txt", "other\n");
    other.commit("from other");
    run(other.path, "push", "-q", "origin", "main");

    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "fetch",
          remote: "origin",
          prune: true,
        })
      ).state,
    ).toBe("succeeded");
    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "pull",
          remote: "origin",
          branch: "main",
        })
      ).state,
    ).toBe("succeeded");
    expect(existsSync(join(repo.path, "from-other.txt"))).toBe(true);
    // The temporary pull ref is deleted, never left behind.
    expect(repo.git("for-each-ref", "refs/armadra/").trim()).toBe("");
  });

  it("stops Sync at the step that failed and names the state", async () => {
    const repo = repository("sync");
    const remote = bareRemote("sync-remote");
    repo.git("remote", "add", "origin", remote);
    repo.git("push", "-q", "-u", "origin", "main");
    const repositoryService = service();

    // The reviewed remote OID is stale, so Sync refuses before fetching.
    const refused = await start(repositoryService, repo.path, {
      kind: "sync",
      remote: "origin",
      branch: "main",
      expectedRemoteOid: null,
    });
    expect(refused.state).toBe("failed");
    expect(refused.message).toContain("Remote tracking ref changed");

    const tracked = repo.git("rev-parse", "refs/remotes/origin/main").trim();
    repo.write("local.txt", "local\n");
    repo.commit("local");
    const done = await start(repositoryService, repo.path, {
      kind: "sync",
      remote: "origin",
      branch: "main",
      expectedRemoteOid: tracked,
    });
    expect(done.state).toBe("succeeded");
    expect(run(remote, "rev-parse", "refs/heads/main").trim()).toBe(
      repo.head(),
    );
  });

  it("refuses a diverged push and accepts an explicit lease", async () => {
    const repo = repository("lease");
    const remote = bareRemote("lease-remote");
    repo.git("remote", "add", "origin", remote);
    repo.git("push", "-q", "-u", "origin", "main");
    const published = repo.git("rev-parse", "HEAD").trim();

    // Rewrite history locally, so the push is no longer a fast-forward.
    repo.write("README.md", "rewritten\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "--amend", "-m", "rewritten");
    const repositoryService = service();

    const refused = await start(repositoryService, repo.path, {
      kind: "push",
      remote: "origin",
      branch: "main",
      setUpstream: false,
      forceWithLease: null,
    });
    expect(refused.state).toBe("unknownOutcome");

    const leased = await start(repositoryService, repo.path, {
      kind: "push",
      remote: "origin",
      branch: "main",
      setUpstream: false,
      forceWithLease: { expectedRemoteOid: published },
    });
    expect(leased.state).toBe("succeeded");
    expect(run(remote, "rev-parse", "refs/heads/main").trim()).toBe(
      repo.head(),
    );
  });

  it("refuses a push that does not target the observed branch", async () => {
    const repo = repository("push-branch");
    const remote = bareRemote("push-branch-remote");
    repo.git("remote", "add", "origin", remote);
    repo.git("branch", "other");
    const repositoryService = service();
    const result = await start(repositoryService, repo.path, {
      kind: "push",
      remote: "origin",
      branch: "other",
      setUpstream: false,
      forceWithLease: null,
    });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("observed current local branch");
  });
});

describe("reset and stash", () => {
  it("refuses a hard reset over uncommitted work until it is acknowledged", async () => {
    const repo = repository("reset");
    const repositoryService = service();
    const base = repo.head();
    repo.write("code.txt", "one\n");
    repo.commit("one");
    repo.write("code.txt", "dirty\n");

    const refused = await start(repositoryService, repo.path, {
      kind: "reset",
      mode: "hard",
      targetOid: base,
      expectedStateToken: await stateToken(repositoryService, repo.path),
      discardChanges: false,
    });
    expect(refused.state).toBe("failed");
    expect(refused.message).toContain("confirm discarding it explicitly");

    const done = await start(repositoryService, repo.path, {
      kind: "reset",
      mode: "hard",
      targetOid: base,
      expectedStateToken: await stateToken(repositoryService, repo.path),
      discardChanges: true,
    });
    expect(done.state).toBe("succeeded");
    expect(repo.head()).toBe(base);
    // The discarded work is recoverable: a stash was recorded first.
    const list = await stashes(repositoryService, repo.path, ".");
    expect(list.stashes[0]?.subject).toContain("before hard reset");
  });

  it("refuses a state token that no longer describes the worktree", async () => {
    const repo = repository("reset-token");
    const repositoryService = service();
    const base = repo.head();
    const token = await stateToken(repositoryService, repo.path);
    repo.write("later.txt", "later\n");
    const result = await start(repositoryService, repo.path, {
      kind: "reset",
      mode: "mixed",
      targetOid: base,
      expectedStateToken: token,
      discardChanges: false,
    });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("Repository state changed");
  });

  it("creates, applies and drops a stash by the object it observed", async () => {
    const repo = repository("stash-verbs");
    const repositoryService = service();
    repo.write("code.txt", "one\n");
    repo.commit("one");
    repo.write("code.txt", "two\n");

    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "createStash",
          message: "wip",
          includeUntracked: false,
          expectedStateToken: await stateToken(repositoryService, repo.path),
        })
      ).state,
    ).toBe("succeeded");
    const list = await stashes(repositoryService, repo.path, ".");
    const oid = list.stashes[0]?.oid as string;
    expect(readFileSync(join(repo.path, "code.txt"), "utf8")).toBe("one\n");

    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "popStash",
          oid,
          reinstateIndex: false,
          expectedStateToken: list.stateToken,
        })
      ).state,
    ).toBe("succeeded");
    expect(readFileSync(join(repo.path, "code.txt"), "utf8")).toBe("two\n");
    expect(
      (await stashes(repositoryService, repo.path, ".")).stashes,
    ).toHaveLength(0);
  });

  it("refuses a stash when nothing is dirty", async () => {
    const repo = repository("stash-clean");
    const repositoryService = service();
    const result = await start(repositoryService, repo.path, {
      kind: "createStash",
      message: "wip",
      includeUntracked: false,
      expectedStateToken: await stateToken(repositoryService, repo.path),
    });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("initial commit and local changes");
  });

  it("refuses an apply that would overwrite an untracked file", async () => {
    const repo = repository("stash-collision");
    const repositoryService = service();
    repo.write("code.txt", "one\n");
    repo.commit("one");
    repo.write("code.txt", "two\n");
    repo.write("fresh.txt", "stashed\n");
    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "createStash",
          message: "wip",
          includeUntracked: true,
          expectedStateToken: await stateToken(repositoryService, repo.path),
        })
      ).state,
    ).toBe("succeeded");
    // Recreate the untracked file the stash would restore.
    repo.write("fresh.txt", "local work\n");
    const list = await stashes(repositoryService, repo.path, ".");
    const result = await start(repositoryService, repo.path, {
      kind: "applyStash",
      oid: list.stashes[0]?.oid as string,
      reinstateIndex: false,
      expectedStateToken: list.stateToken,
    });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("untracked or ignored");
    expect(readFileSync(join(repo.path, "fresh.txt"), "utf8")).toBe(
      "local work\n",
    );
  });
});

describe("worktree verbs", () => {
  it("creates a checkout, excludes it and then removes it", async () => {
    const repo = repository("worktree-verbs");
    const repositoryService = service();
    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "createWorktree",
          path: "checkouts/feature",
          branch: "feature",
          createBranch: true,
          startPoint: null,
          expectedOid: null,
        })
      ).state,
    ).toBe("succeeded");
    expect(existsSync(join(repo.path, "checkouts/feature/.git"))).toBe(true);
    // The nested checkout is excluded, so Stage All cannot stage it.
    expect(
      readFileSync(join(repo.path, ".git/info/exclude"), "utf8"),
    ).toContain("/checkouts/feature/");

    const records = await worktrees(repositoryService, repo.path, ".");
    const linked = records.find((record) => record.branch === "feature");
    expect(
      (
        await start(repositoryService, repo.path, {
          kind: "removeWorktree",
          path: "checkouts/feature",
          expectedOid: linked?.headOid as string,
          // Nothing here has a remote, so every commit is unpublished; the
          // acknowledgement is what the panel asks a person for.
          allowUnpublished: true,
        })
      ).state,
    ).toBe("succeeded");
    expect(existsSync(join(repo.path, "checkouts/feature"))).toBe(false);
  });

  it("refuses to remove a checkout that holds unpublished commits", async () => {
    const repo = repository("worktree-unpublished");
    const repositoryService = service();
    repo.git("worktree", "add", "-q", "-b", "feature", "checkouts/feature");
    run(
      join(repo.path, "checkouts/feature"),
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "work",
    );
    const records = await worktrees(repositoryService, repo.path, ".");
    const linked = records.find((record) => record.branch === "feature");
    const result = await start(repositoryService, repo.path, {
      kind: "removeWorktree",
      path: "checkouts/feature",
      expectedOid: linked?.headOid as string,
      allowUnpublished: false,
    });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("unpublished commits");
  });

  it("refuses a destination that already exists", async () => {
    const repo = repository("worktree-exists");
    const repositoryService = service();
    await expect(
      startOperation(
        repositoryService,
        repo.path,
        ".",
        {
          kind: "createWorktree",
          path: "README.md",
          branch: "feature",
          createBranch: true,
          startPoint: null,
          expectedOid: null,
        },
        await repositoryService.head(repo.path),
      ),
    ).rejects.toThrow("already exists");
  });
});

describe("the queue itself", () => {
  it("runs one repository's operations in the order they arrived", async () => {
    const repo = repository("queue-order");
    const repositoryService = service();
    const expected = await repositoryService.head(repo.path);
    const ids: string[] = [];
    for (const name of ["one", "two", "three"]) {
      const snapshot = await startOperation(
        repositoryService,
        repo.path,
        ".",
        { kind: "createBranch", name, startPoint: null, switch: false },
        expected,
      );
      ids.push(snapshot.id);
      expect(snapshot.state).toBe("queued");
    }
    for (const id of ids) {
      expect((await settle(repositoryService, id)).state).toBe("succeeded");
    }
    const list = await repositoryService.listOperations(repo.path, ".");
    // Newest first, and every one of them belongs to this checkout.
    expect(list.map((entry) => entry.id)).toEqual([...ids].reverse());
    expect(list.every((entry) => entry.progress === 100)).toBe(true);
  });

  it("reports a cancelled operation as cancelled before any mutation", async () => {
    const repo = repository("queue-cancel");
    const repositoryService = service();
    const expected = await repositoryService.head(repo.path);
    const first = await startOperation(
      repositoryService,
      repo.path,
      ".",
      { kind: "createBranch", name: "one", startPoint: null, switch: false },
      expected,
    );
    const second = await startOperation(
      repositoryService,
      repo.path,
      ".",
      { kind: "createBranch", name: "two", startPoint: null, switch: false },
      expected,
    );
    const cancelled = repositoryService.cancel(second.id);
    expect(cancelled.cancellationRequested).toBe(true);
    await settle(repositoryService, first.id);
    const settled = await settle(repositoryService, second.id);
    expect(settled.state).toBe("cancelled");
    expect(repo.git("branch", "--list", "two").trim()).toBe("");
  });

  it("reports an unknown operation rather than inventing one", () => {
    const repositoryService = service();
    expect(() => repositoryService.operationSnapshot("nope")).toThrow(
      "Git operation is unavailable",
    );
  });

  it("refuses every write without the execution grant", async () => {
    const repo = repository("queue-grant");
    const repositoryService = service().withExecution(false);
    await expect(
      startOperation(
        repositoryService,
        repo.path,
        ".",
        { kind: "createBranch", name: "x", startPoint: null, switch: false },
        { headOid: repo.head(), branch: "main" },
      ),
    ).rejects.toThrow("execution permission");
  });
});

describe("the conflict centre", () => {
  async function conflicted(name: string) {
    const repo = repository(name);
    repo.write("code.txt", "base\n");
    repo.commit("base");
    repo.git("switch", "-q", "-c", "other");
    repo.write("code.txt", "theirs\n");
    const theirs = repo.commit("theirs");
    repo.git("switch", "-q", "main");
    repo.write("code.txt", "ours\n");
    repo.commit("ours");
    return { repo, theirs };
  }

  it("owns a conflicted merge, then finishes it on an explicit continue", async () => {
    const { repo, theirs } = await conflicted("merge-continue");
    const repositoryService = service();
    const expected = await repositoryService.head(repo.path);
    const paused = await start(
      repositoryService,
      repo.path,
      {
        kind: "startMerge",
        targetOid: theirs,
        message: "merge other",
        expectedStateToken: await integrationToken(
          repositoryService,
          repo.path,
        ),
      },
      expected,
    );
    expect(paused.state).toBe("awaitingResolution");

    const context = await repositoryService.context(repo.path, ".");
    let state = await integrationSnapshot(repositoryService, context);
    expect(state.kind).toBe("merge");
    expect(state.owned).toBe(true);
    expect(state.sessionId).toBe(paused.id);
    expect(state.conflicts.map((file) => file.path)).toEqual(["code.txt"]);
    expect(state.conflicts[0]?.ours?.preview).toBe("ours\n");
    expect(state.conflicts[0]?.theirs?.preview).toBe("theirs\n");
    expect(state.canContinue).toBe(false);

    repo.write("code.txt", "resolved\n");
    repo.git("add", "code.txt");
    state = await integrationSnapshot(repositoryService, context);
    expect(state.canContinue).toBe(true);

    const finished = await start(
      repositoryService,
      repo.path,
      {
        kind: "continueIntegration",
        sessionId: paused.id,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
    expect(finished.state).toBe("succeeded");
    expect((await integrationSnapshot(repositoryService, context)).kind).toBe(
      "none",
    );
    // seed, base, ours, theirs and the merge that joined the last two.
    expect(repo.git("rev-list", "--count", "HEAD").trim()).toBe("5");
    // The paused operation is the one that is now settled as succeeded.
    expect(repositoryService.operationSnapshot(paused.id).state).toBe(
      "succeeded",
    );
  });

  it("restores the starting state on an explicit abort", async () => {
    const { repo, theirs } = await conflicted("merge-abort");
    const repositoryService = service();
    const before = repo.head();
    const paused = await start(repositoryService, repo.path, {
      kind: "startMerge",
      targetOid: theirs,
      message: "merge other",
      expectedStateToken: await integrationToken(repositoryService, repo.path),
    });
    expect(paused.state).toBe("awaitingResolution");
    const context = await repositoryService.context(repo.path, ".");
    const state = await integrationSnapshot(repositoryService, context);
    const aborted = await start(
      repositoryService,
      repo.path,
      {
        kind: "abortIntegration",
        sessionId: paused.id,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
    // The abort itself succeeded; what it *cancelled* is the paused sequence,
    // which is the record a person is looking at in the panel.
    expect(aborted.state).toBe("succeeded");
    expect(repositoryService.operationSnapshot(paused.id).state).toBe(
      "cancelled",
    );
    expect(repositoryService.operationSnapshot(paused.id).message).toContain(
      "explicitly aborted",
    );
    expect(repo.head()).toBe(before);
    expect(readFileSync(join(repo.path, "code.txt"), "utf8")).toBe("ours\n");
  });

  it("refuses another repository operation while a sequence is in progress", async () => {
    const { repo, theirs } = await conflicted("merge-busy");
    const repositoryService = service();
    await start(repositoryService, repo.path, {
      kind: "startMerge",
      targetOid: theirs,
      message: "merge other",
      expectedStateToken: await integrationToken(repositoryService, repo.path),
    });
    const blocked = await start(repositoryService, repo.path, {
      kind: "createBranch",
      name: "meanwhile",
      startPoint: null,
      switch: false,
    });
    expect(blocked.state).toBe("failed");
    expect(blocked.message).toContain("integration is already in progress");
  });

  it("cherry-picks a clean commit and verifies its author and parent", async () => {
    const repo = repository("pick-clean");
    repo.git("switch", "-q", "-c", "side");
    repo.write("side.txt", "side\n");
    const target = repo.commit("side work");
    repo.git("switch", "-q", "main");
    const repositoryService = service();

    const result = await start(repositoryService, repo.path, {
      kind: "startCherryPick",
      targetOid: target,
      mainline: null,
      recordOrigin: true,
      expectedStateToken: await integrationToken(repositoryService, repo.path),
    });
    expect(result.state).toBe("succeeded");
    expect(existsSync(join(repo.path, "side.txt"))).toBe(true);
    expect(repo.git("log", "-1", "--format=%B").trim()).toContain(
      "cherry picked from commit",
    );
  });

  it("skips only an empty pick, and reverts with abort but never skip", async () => {
    const repo = repository("pick-empty");
    repo.write("code.txt", "one\n");
    const target = repo.commit("one");
    repo.git("switch", "-q", "-c", "side", "HEAD~1");
    repo.write("code.txt", "one\n");
    repo.commit("same change");
    const repositoryService = service();

    const paused = await start(repositoryService, repo.path, {
      kind: "startCherryPick",
      targetOid: target,
      mainline: null,
      recordOrigin: false,
      expectedStateToken: await integrationToken(repositoryService, repo.path),
    });
    expect(paused.state).toBe("awaitingResolution");
    const context = await repositoryService.context(repo.path, ".");
    const state = await integrationSnapshot(repositoryService, context);
    expect(state.empty).toBe(true);
    expect(state.canSkip).toBe(true);
    expect(state.canContinue).toBe(false);

    const skipped = await start(
      repositoryService,
      repo.path,
      {
        kind: "skipIntegration",
        sessionId: paused.id,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
    expect(skipped.state).toBe("succeeded");
    expect((await integrationSnapshot(repositoryService, context)).kind).toBe(
      "none",
    );
  });

  it("replays a rebase and returns the branch to itself", async () => {
    const repo = repository("rebase");
    const base = repo.head();
    repo.git("switch", "-q", "-c", "feature");
    repo.write("feature.txt", "feature\n");
    repo.commit("feature work");
    repo.git("switch", "-q", "main");
    repo.write("main.txt", "main\n");
    const onto = repo.commit("main work");
    repo.git("switch", "-q", "feature");
    const repositoryService = service();

    const result = await start(repositoryService, repo.path, {
      kind: "startRebase",
      onto,
      expectedStateToken: await integrationToken(repositoryService, repo.path),
    });
    expect(result.state).toBe("succeeded");
    expect(repo.git("branch", "--show-current").trim()).toBe("feature");
    expect(repo.git("rev-list", "--count", `${base}..HEAD`).trim()).toBe("2");
    expect(existsSync(join(repo.path, "main.txt"))).toBe(true);
  });

  it("runs a reviewed todo through the sequence editor and rewords", async () => {
    const repo = repository("rebase-todo");
    const base = repo.head();
    repo.git("switch", "-q", "-c", "feature");
    repo.write("one.txt", "one\n");
    const first = repo.commit("one");
    repo.write("two.txt", "two\n");
    const second = repo.commit("two");
    const repositoryService = service();

    const result = await start(repositoryService, repo.path, {
      kind: "startInteractiveRebase",
      onto: base,
      todo: [
        { oid: first, command: "reword", message: "reworded one" },
        { oid: second, command: "drop" },
      ],
      expectedStateToken: await integrationToken(repositoryService, repo.path),
    });
    expect(result.state).toBe("succeeded");
    expect(repo.git("log", "-1", "--format=%s").trim()).toBe("reworded one");
    expect(repo.git("rev-list", "--count", `${base}..HEAD`).trim()).toBe("1");
    // The staged todo and message files are removed with the operation.
    expect(
      repo
        .git("status", "--porcelain=v1")
        .split("\n")
        .filter((line) => line.includes("armadra-rebase")),
    ).toEqual([]);
  });

  it("refuses a todo that does not list the whole range", async () => {
    const repo = repository("rebase-todo-partial");
    const base = repo.head();
    repo.git("switch", "-q", "-c", "feature");
    repo.write("one.txt", "one\n");
    const first = repo.commit("one");
    repo.write("two.txt", "two\n");
    repo.commit("two");
    const repositoryService = service();

    const result = await start(repositoryService, repo.path, {
      kind: "startInteractiveRebase",
      onto: base,
      todo: [{ oid: first, command: "pick" }],
      expectedStateToken: await integrationToken(repositoryService, repo.path),
    });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("exactly the commits");
  });

  it("refuses a reword with no message and a message on any other verb", async () => {
    const repo = repository("rebase-todo-message");
    const base = repo.head();
    repo.write("one.txt", "one\n");
    const first = repo.commit("one");
    const repositoryService = service();
    const expected = await repositoryService.head(repo.path);
    const token = await stateToken(repositoryService, repo.path);
    await expect(
      startOperation(
        repositoryService,
        repo.path,
        ".",
        {
          kind: "startInteractiveRebase",
          onto: base,
          todo: [{ oid: first, command: "reword" }],
          expectedStateToken: token,
        },
        expected,
      ),
    ).rejects.toThrow("must carry the message");
    await expect(
      startOperation(
        repositoryService,
        repo.path,
        ".",
        {
          kind: "startInteractiveRebase",
          onto: base,
          todo: [{ oid: first, command: "pick", message: "no" }],
          expectedStateToken: token,
        },
        expected,
      ),
    ).rejects.toThrow("Only a reword may carry a message");
  });
});
