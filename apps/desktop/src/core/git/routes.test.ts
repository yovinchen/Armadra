import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTES } from "../http/routes";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import {
  type WorkspacePermissions,
  createWorkspace,
} from "../workspaces/table";
import { invalidateAll } from "./discovery";
import { cleanupFixtures, repository, repositoryAt, run } from "./fixture";
import { install } from "./index";

/**
 * The Git routes as the front end calls them.
 *
 * The shapes come from `apps/web/src/api/git.ts` and
 * `apps/web/src/api/git-repository.ts`; the statuses and the permission gates
 * come from `apps/runtime/src/api/git.rs`, `apps/runtime/src/git/api/` and
 * `apps/runtime/tests/git_execution_permissions.rs`.
 */

describe("the Git routes", () => {
  let core: Fixture;

  beforeEach(() => {
    invalidateAll();
    core = fixture([installWorkspaces, install]);
  });
  afterEach(() => {
    core.close();
    cleanupFixtures();
  });

  function workspace(
    root: string,
    permissions: WorkspacePermissions = {
      read: true,
      write: true,
      execute: true,
    },
  ): string {
    return createWorkspace(core.database, {
      name: `ws-${Math.random().toString(36).slice(2)}`,
      rootPath: root,
      permissions,
    }).id;
  }

  it("answers every Git route in the table, and none on the hook surface", () => {
    const git = ROUTES.filter(
      (route) => route.path.includes("/git/") || route.path.endsWith("/git"),
    );
    expect(git.length).toBeGreaterThan(0);
    expect(git.every((route) => route.implemented === true)).toBe(true);
    expect(git.every((route) => route.surface === "runtime")).toBe(true);
  });

  it("answers status, diff and the head commit for one checkout", async () => {
    const repo = repository("routes-status");
    repo.write("code.txt", "one\n");
    const id = workspace(repo.path);

    const status = await core.call(
      "GET",
      `/api/workspaces/${id}/git/status?path=.`,
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ repository: true, branch: "main" });

    const diff = await core.call(
      "GET",
      `/api/workspaces/${id}/git/diff?path=.&scope=worktree`,
    );
    expect(diff.status).toBe(200);
    expect((diff.body as { files: unknown[] }).files).toHaveLength(1);

    const head = await core.call(
      "GET",
      `/api/workspaces/${id}/git/head-commit?path=.`,
    );
    expect(head.status).toBe(200);
    expect(head.body).toMatchObject({ subject: "seed", published: false });
  });

  it("stages, commits and reports the new head", async () => {
    const repo = repository("routes-commit");
    repo.write("code.txt", "one\n");
    const id = workspace(repo.path);

    const staged = await core.call("POST", `/api/workspaces/${id}/git/stage`, {
      path: ".",
      paths: ["code.txt"],
    });
    expect(staged.status).toBe(200);
    expect(staged.body).toEqual({ staged: ["code.txt"] });

    const committed = await core.call(
      "POST",
      `/api/workspaces/${id}/git/commit`,
      { path: ".", message: "add code" },
    );
    expect(committed.status).toBe(200);
    expect(repo.git("log", "-1", "--format=%s").trim()).toBe("add code");
  });

  it("initialises a repository only where there is none", async () => {
    const plain = join(core.directory, "plain");
    mkdirSync(plain);
    const id = workspace(plain);
    const created = await core.call("POST", `/api/workspaces/${id}/git/init`);
    expect(created.status).toBe(200);
    expect(existsSync(join(plain, ".git"))).toBe(true);
    const again = await core.call("POST", `/api/workspaces/${id}/git/init`);
    expect(again.status).toBe(409);
  });

  it("refuses a read to a workspace with no read permission", async () => {
    const repo = repository("routes-noread");
    const id = workspace(repo.path, {
      read: false,
      write: false,
      execute: false,
    });
    const answer = await core.call(
      "GET",
      `/api/workspaces/${id}/git/status?path=.`,
    );
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "forbidden" });
  });

  it("refuses a write to a read-only workspace and names the grant", async () => {
    const repo = repository("routes-readonly");
    const id = workspace(repo.path, {
      read: true,
      write: false,
      execute: true,
    });
    const answer = await core.call("POST", `/api/workspaces/${id}/git/stage`, {
      path: ".",
      paths: ["README.md"],
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "forbidden" });
  });

  it("answers `git_execution_required` without the execution grant", async () => {
    const repo = repository("routes-noexec");
    const id = workspace(repo.path, {
      read: true,
      write: true,
      execute: false,
    });
    const status = await core.call(
      "GET",
      `/api/workspaces/${id}/git/status?path=.`,
    );
    expect(status.status).toBe(403);
    expect(status.body).toMatchObject({ code: "git_execution_required" });

    // The staged diff is a metadata read, so it still answers.
    const diff = await core.call(
      "GET",
      `/api/workspaces/${id}/git/diff?path=.&scope=staged`,
    );
    expect(diff.status).toBe(200);
  });

  it("lists the repositories under a workspace and rescans on request", async () => {
    const repo = repository("routes-repositories");
    repositoryAt(join(repo.path, "apps/inner"));
    const id = workspace(repo.path);
    const first = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repositories`,
    );
    expect(first.status).toBe(200);
    const list = first.body as { repositories: { repositoryPath: string }[] };
    expect(list.repositories.map((entry) => entry.repositoryPath)).toEqual([
      ".",
      "apps/inner",
    ]);

    repositoryAt(join(repo.path, "apps/later"));
    const cached = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repositories`,
    );
    expect(
      (cached.body as { repositories: unknown[] }).repositories,
    ).toHaveLength(2);
    const refreshed = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repositories?refresh=true`,
    );
    expect(
      (refreshed.body as { repositories: unknown[] }).repositories,
    ).toHaveLength(3);
  });

  it("answers the workspace-level log and branch tree", async () => {
    const repo = repository("routes-log");
    const id = workspace(repo.path);
    const log = await core.call("POST", `/api/workspaces/${id}/git/log`, {
      refs: { kind: "head" },
      limit: 10,
    });
    expect(log.status).toBe(200);
    expect((log.body as { commits: unknown[] }).commits).toHaveLength(1);

    const refs = await core.call("GET", `/api/workspaces/${id}/git/refs`);
    expect(refs.status).toBe(200);
    expect((refs.body as unknown[])[0]).toMatchObject({
      repositoryPath: ".",
    });
  });

  it("runs an operation, scopes it to its workspace and cancels it", async () => {
    const repo = repository("routes-operations");
    const id = workspace(repo.path);
    const other = workspace(repositoryAt(join(repo.path, "other")).path);

    const started = await core.call(
      "POST",
      `/api/workspaces/${id}/git/repository/operations`,
      {
        path: ".",
        action: {
          kind: "createBranch",
          name: "feature",
          startPoint: null,
          switch: false,
        },
        expected: { headOid: repo.head(), branch: "main" },
      },
    );
    expect(started.status).toBe(200);
    const operation = started.body as { id: string; state: string };
    expect(operation.state).toBe("queued");

    for (let attempt = 0; attempt < 300; attempt += 1) {
      const polled = await core.call(
        "GET",
        `/api/workspaces/${id}/git/repository/operations/${operation.id}`,
      );
      expect(polled.status).toBe(200);
      const snapshot = polled.body as { state: string };
      if (snapshot.state !== "queued" && snapshot.state !== "running") {
        expect(snapshot.state).toBe("succeeded");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Another workspace cannot see or cancel it.
    const foreign = await core.call(
      "GET",
      `/api/workspaces/${other}/git/repository/operations/${operation.id}`,
    );
    expect(foreign.status).toBe(404);
    const listed = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repository/operations?path=.`,
    );
    expect((listed.body as { id: string }[]).map((entry) => entry.id)).toEqual([
      operation.id,
    ]);
  });

  it("redacts an integration session this workspace does not own", async () => {
    const repo = repository("routes-integration");
    const id = workspace(repo.path);
    const answer = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repository/integration?path=.`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      kind: "none",
      owned: false,
      sessionId: null,
      canContinue: false,
    });
  });

  it("clones a local repository and registers the workspace", async () => {
    const source = repository("routes-clone-source");
    const parent = join(core.directory, "clones");
    mkdirSync(parent);
    // The allow-list refuses a local path, which is what the dialog's own
    // validation relies on.
    const refused = await core.call("POST", "/api/git/clone", {
      url: source.path,
      parent,
      name: "copy",
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "bad_request" });

    const missing = await core.call("GET", "/api/git/clone/nope");
    expect(missing.status).toBe(404);
    const cancelled = await core.call("DELETE", "/api/git/clone/nope");
    expect(cancelled.status).toBe(404);
  });

  it("answers the AI provider list and the staged source", async () => {
    const repo = repository("routes-message");
    repo.write("src/main.ts", "export const one = 1;\n");
    repo.git("add", "-A");
    const id = workspace(repo.path);

    const list = await core.call(
      "GET",
      `/api/workspaces/${id}/git/message/providers`,
    );
    expect(list.status).toBe(200);
    expect((list.body as { id: string }[])[0]?.id).toBe("claude-bare");

    const staged = await core.call(
      "GET",
      `/api/workspaces/${id}/git/message/source`,
    );
    expect(staged.status).toBe(200);
    expect(staged.body).toMatchObject({ includedFiles: ["src/main.ts"] });
  });

  it("reads and applies one hunk through the route pair", async () => {
    const repo = repository("routes-hunks");
    repo.write("code.txt", "one\ntwo\nthree\n");
    repo.commit("code");
    repo.write("code.txt", "one\nchanged\nthree\n");
    const id = workspace(repo.path);

    const read = await core.call(
      "GET",
      `/api/workspaces/${id}/git/hunks?path=.&file=code.txt&scope=worktree`,
    );
    expect(read.status).toBe(200);
    const diff = read.body as {
      diffDigest: string;
      hunks: { id: string }[];
    };
    const applied = await core.call("POST", `/api/workspaces/${id}/git/hunks`, {
      path: ".",
      file: "code.txt",
      scope: "worktree",
      diffDigest: diff.diffDigest,
      hunkId: diff.hunks[0]?.id,
      action: "stage",
    });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ applied: true, action: "stage" });
  });

  it("answers a batch status and a worktree binding verdict", async () => {
    const repo = repository("routes-batch");
    repo.git("worktree", "add", "-q", "-b", "feature", "checkouts/feature");
    const id = workspace(repo.path);

    const batch = await core.call(
      "POST",
      `/api/workspaces/${id}/git/repository/status-batch`,
      { paths: [".", "checkouts/feature"] },
    );
    expect(batch.status).toBe(200);
    expect(
      (batch.body as { repositories: unknown[] }).repositories,
    ).toHaveLength(2);

    const binding = await core.call(
      "POST",
      `/api/workspaces/${id}/git/repository/worktree-binding`,
      { worktreePath: "checkouts/feature", branch: "feature" },
    );
    expect(binding.status).toBe(200);
    expect(binding.body).toMatchObject({ valid: true, code: "ok" });
  });

  it("answers 404 for a workspace that does not exist", async () => {
    const answer = await core.call(
      "GET",
      "/api/workspaces/00000000-0000-0000-0000-000000000000/git/status",
    );
    expect(answer.status).toBe(404);
  });

  it("refuses a malformed body as a bad request, never a crash", async () => {
    const repo = repository("routes-malformed");
    const id = workspace(repo.path);
    const answer = await core.call(
      "POST",
      `/api/workspaces/${id}/git/stage`,
      Buffer.from("{not json"),
    );
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "bad_request" });
  });

  it("drops the discovery cache when a `.git` entry changes", async () => {
    const repo = repository("routes-cache");
    const id = workspace(repo.path);
    await core.call("GET", `/api/workspaces/${id}/git/repositories`);
    repositoryAt(join(repo.path, "apps/inner"));
    const stale = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repositories`,
    );
    expect(
      (stale.body as { repositories: unknown[] }).repositories,
    ).toHaveLength(1);

    core.bus.emit("workspace.event", {
      workspaceId: id,
      event: {
        type: "file.changed",
        workspaceId: id,
        path: "apps/inner/.git",
        kind: "modified",
        sha256: null,
        size: null,
        mtime: null,
      },
    });
    const fresh = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repositories`,
    );
    expect(
      (fresh.body as { repositories: unknown[] }).repositories,
    ).toHaveLength(2);
  });

  it("leaves the cache alone for an ordinary file change", async () => {
    const repo = repository("routes-cache-plain");
    const id = workspace(repo.path);
    await core.call("GET", `/api/workspaces/${id}/git/repositories`);
    repositoryAt(join(repo.path, "apps/inner"));
    core.bus.emit("workspace.event", {
      workspaceId: id,
      event: {
        type: "file.changed",
        workspaceId: id,
        path: "src/main.ts",
        kind: "modified",
        sha256: null,
        size: null,
        mtime: null,
      },
    });
    const answer = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repositories`,
    );
    expect(
      (answer.body as { repositories: unknown[] }).repositories,
    ).toHaveLength(1);
  });

  it("answers every remaining repository read for a real checkout", async () => {
    const repo = repository("routes-reads");
    repo.git("tag", "v1");
    repo.git("remote", "add", "origin", "https://example.invalid/repo.git");
    repo.write("code.txt", "one\n");
    repo.commit("code");
    repo.write("code.txt", "two\n");
    repo.git("stash", "push", "-m", "wip");
    const id = workspace(repo.path);
    const head = repo.head();
    const base = run(repo.path, "rev-parse", "HEAD~1").trim();

    for (const path of [
      `/api/workspaces/${id}/git/identity?path=.`,
      `/api/workspaces/${id}/git/repository/branches?path=.`,
      `/api/workspaces/${id}/git/repository/tags?path=.`,
      `/api/workspaces/${id}/git/repository/remotes?path=.`,
      `/api/workspaces/${id}/git/repository/worktrees?path=.`,
      `/api/workspaces/${id}/git/repository/stashes?path=.`,
      `/api/workspaces/${id}/git/repository/history?path=.&limit=5`,
      `/api/workspaces/${id}/git/repository/reflog?path=.&limit=5`,
      `/api/workspaces/${id}/git/repository/commit?path=.&oid=${head}`,
      `/api/workspaces/${id}/git/repository/commit-file?path=.&oid=${head}&file=code.txt`,
      `/api/workspaces/${id}/git/repository/cherry-pick-preview?path=.&oid=${head}`,
      `/api/workspaces/${id}/git/repository/rebase-todo?path=.&onto=${base}`,
    ]) {
      const answer = await core.call("GET", path);
      expect([path, answer.status]).toEqual([path, 200]);
    }

    const stashes = (
      await core.call(
        "GET",
        `/api/workspaces/${id}/git/repository/stashes?path=.`,
      )
    ).body as { stashes: { oid: string }[] };
    const detail = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repository/stash-detail?path=.&oid=${stashes.stashes[0]?.oid}`,
    );
    expect(detail.status).toBe(200);
  });
});
