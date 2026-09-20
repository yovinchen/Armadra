import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bareRemote,
  cleanupFixtures,
  repository,
  repositoryAt,
  temporaryDirectory,
  run,
  service,
} from "./fixture";
import { branches, identity, remoteRecords, tags } from "./repository/branches";
import { cherryPickPreview } from "./repository/cherrypick";
import { commitDetail, commitFileDiff } from "./repository/commits";
import { history, reflog, splitSubject } from "./repository/history";
import { log } from "./repository/log";
import { rebaseTodoPreview } from "./repository/rebase";
import { stashes, stashDetail } from "./repository/stash";
import { refsSnapshot } from "./repository/tree";
import { verifyWorktreeBinding, worktrees } from "./repository/worktrees";
import { invalidateAll, scan } from "./discovery";
import { DomainError } from "../workspaces/support";

/**
 * Every repository-level read, against real checkouts.
 *
 * Ported from `apps/runtime/tests/git_repository_{branches,history,refs,
 * remotes,stash,worktrees}.rs`, `git_workspace_log.rs`,
 * `git_reflog_pathspec.rs` and `git_multi_repository_api.rs`.
 */

afterAll(cleanupFixtures);

/** The `DomainError` a read refused with, so its status can be asserted. */
async function failure(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("branches, tags, remotes and identity", () => {
  it("reports the current branch, its upstream and the divergence", async () => {
    const repo = repository("branches");
    const remote = bareRemote("branches-remote");
    repo.git("remote", "add", "origin", remote);
    repo.git("push", "-q", "-u", "origin", "main");
    repo.write("extra.txt", "extra\n");
    repo.commit("ahead");

    const snapshot = await branches(service(), repo.path, ".");
    const main = snapshot.branches.find((branch) => branch.name === "main");
    expect(main?.current).toBe(true);
    expect(main?.upstream).toBe("refs/remotes/origin/main");
    expect(main?.ahead).toBe(1);
    expect(main?.behind).toBe(0);
    expect(snapshot.remotes).toEqual(["origin"]);
    expect(snapshot.head.branch).toBe("main");
  });

  it("says `null`, not zero, for a branch with nowhere to push", async () => {
    const repo = repository("branches-untracked");
    const snapshot = await branches(service(), repo.path, ".");
    const main = snapshot.branches.find((branch) => branch.name === "main");
    expect(main?.upstream).toBeNull();
    expect(main?.ahead).toBeNull();
    expect(main?.behind).toBeNull();
  });

  it("peels an annotated tag to the commit it names", async () => {
    const repo = repository("tags");
    const head = repo.head();
    repo.git("tag", "light");
    repo.git("tag", "-a", "-m", "release one", "heavy");

    const snapshot = await tags(service(), repo.path, ".");
    const light = snapshot.tags.find((tag) => tag.name === "light");
    const heavy = snapshot.tags.find((tag) => tag.name === "heavy");
    expect(light?.annotated).toBe(false);
    expect(light?.oid).toBe(head);
    expect(light?.targetOid).toBe(head);
    expect(heavy?.annotated).toBe(true);
    expect(heavy?.oid).not.toBe(head);
    expect(heavy?.targetOid).toBe(head);
    expect(heavy?.subject).toBe("release one");
  });

  it("redacts a credential in a remote URL and says it did", async () => {
    const repo = repository("remotes");
    repo.git(
      "remote",
      "add",
      "origin",
      "https://alice:private-pass@example.invalid/repo.git",
    );
    const records = await remoteRecords(service(), repo.path, ".");
    expect(records[0]?.redacted).toBe(true);
    expect(records[0]?.fetchUrl).not.toContain("private-pass");
    expect(records[0]?.fetchUrl).toContain("example.invalid");
  });

  it("reads the identity a commit here would carry", async () => {
    const repo = repository("identity");
    repo.git("config", "user.email", "someone@example.invalid");
    repo.git("config", "user.name", "Someone");
    const configured = await identity(service(), repo.path, ".");
    expect(configured).toEqual({
      name: "Someone",
      email: "someone@example.invalid",
    });
  });

  it("treats a key configured to the empty string as unset", async () => {
    const repo = repository("identity-empty");
    repo.git("config", "user.email", "");
    expect((await identity(service(), repo.path, ".")).email).toBeNull();
  });
});

describe("history", () => {
  it("pages by an anchor that survives the ref moving", async () => {
    const repo = repository("history");
    for (let index = 0; index < 5; index += 1) {
      repo.write(`file${index}.txt`, `${index}\n`);
      repo.commit(`commit ${index}`);
    }
    const repositoryService = service();
    const first = await history(repositoryService, repo.path, ".", {
      reference: "HEAD",
      limit: 2,
      cursor: null,
      paths: [],
    });
    expect(first.commits).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.shallow).toBe(false);

    // A new commit must not shift the page the reader already has.
    repo.write("later.txt", "later\n");
    repo.commit("after the page");

    const second = await history(repositoryService, repo.path, ".", {
      reference: "HEAD",
      limit: 2,
      cursor: first.nextCursor,
      paths: [],
    });
    expect(second.anchorOid).toBe(first.anchorOid);
    expect(second.commits[0]?.subject).toBe("commit 2");
  });

  it("refuses a cursor taken under a different filter", async () => {
    const repo = repository("history-cursor");
    repo.write("apps/one.txt", "a\n");
    repo.commit("apps");
    repo.write("libs/two.txt", "b\n");
    repo.commit("libs");
    const repositoryService = service();
    const page = await history(repositoryService, repo.path, ".", {
      reference: "HEAD",
      limit: 1,
      cursor: null,
      paths: [],
    });
    await expect(
      history(repositoryService, repo.path, ".", {
        reference: "HEAD",
        limit: 1,
        cursor: page.nextCursor,
        paths: ["apps"],
      }),
    ).rejects.toThrow("reload the first page");
  });

  it("reports the parents every row of the graph is drawn from", async () => {
    const repo = repository("history-parents");
    const base = repo.head();
    repo.git("switch", "-q", "-c", "side");
    repo.write("side.txt", "side\n");
    repo.commit("side");
    repo.git("switch", "-q", "main");
    repo.write("main.txt", "main\n");
    repo.commit("main");
    repo.git("merge", "--no-ff", "-m", "merge side", "side");

    const page = await history(service(), repo.path, ".", {
      reference: "HEAD",
      limit: 10,
      cursor: null,
      paths: [],
    });
    const merge = page.commits[0];
    expect(merge?.subject).toBe("merge side");
    expect(merge?.parents).toHaveLength(2);
    expect(page.commits[page.commits.length - 1]?.oid).toBe(base);
  });

  it("answers an empty page for an unborn branch", async () => {
    const repo = repository("history-unborn", false);
    const page = await history(service(), repo.path, ".", {
      reference: "HEAD",
      limit: 10,
      cursor: null,
      paths: [],
    });
    expect(page.anchorOid).toBeNull();
    expect(page.commits).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("refuses a page size outside one and two hundred", async () => {
    const repo = repository("history-limit");
    await expect(
      history(service(), repo.path, ".", {
        reference: "HEAD",
        limit: 0,
        cursor: null,
        paths: [],
      }),
    ).rejects.toThrow("1–200");
  });
});

describe("reflog", () => {
  it("carries the selector, the previous value and the verb", async () => {
    const repo = repository("reflog");
    repo.write("one.txt", "one\n");
    repo.commit("one");
    repo.git("switch", "-q", "-c", "other");
    repo.git("switch", "-q", "main");

    const page = await reflog(service(), repo.path, ".", {
      reference: "HEAD",
      limit: 10,
      cursor: null,
    });
    expect(page.entries[0]?.selector).toBe("HEAD@{0}");
    expect(page.entries[0]?.action).toBe("checkout");
    expect(page.entries[0]?.previousOid).toBe(page.entries[1]?.oid);
    expect(page.entries[0]?.loggedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses a commit id, which has no reflog to read", async () => {
    const repo = repository("reflog-oid");
    await expect(
      reflog(service(), repo.path, ".", {
        reference: repo.head(),
        limit: 10,
        cursor: null,
      }),
    ).rejects.toThrow("read for a reference");
  });

  it("splits a subject into its verb and the rest", () => {
    expect(splitSubject("checkout: moving from a to b")).toEqual([
      "checkout",
      "moving from a to b",
    ]);
    expect(splitSubject("commit (initial): one")).toEqual([
      "commit",
      "(initial) one",
    ]);
    expect(splitSubject("no colon here")).toEqual(["", "no colon here"]);
  });
});

describe("commit detail", () => {
  it("lists a commit's files and answers one file's patch", async () => {
    const repo = repository("commit-detail");
    repo.write("one.txt", "one\n");
    repo.write("two.txt", "two\n");
    const oid = repo.commit("two files");
    const repositoryService = service();

    const detail = await commitDetail(
      repositoryService,
      repo.path,
      ".",
      oid,
      undefined,
    );
    expect(detail.files.map((file) => file.path)).toEqual([
      "one.txt",
      "two.txt",
    ]);
    expect(detail.files[0]?.additions).toBe(1);
    expect(detail.truncated).toBe(false);

    const patch = await commitFileDiff(
      repositoryService,
      repo.path,
      ".",
      oid,
      undefined,
      "one.txt",
    );
    expect(patch.patch).toContain("+one");
    expect(patch.truncated).toBe(false);
  });

  it("treats a root commit as all additions", async () => {
    const repo = repository("commit-root");
    const first = run(repo.path, "rev-list", "--max-parents=0", "HEAD").trim();
    const detail = await commitDetail(
      service(),
      repo.path,
      ".",
      first,
      undefined,
    );
    expect(detail.baseOid).toBeNull();
    expect(detail.files).toEqual([
      { status: "A", path: "README.md", additions: 1, deletions: 0 },
    ]);
  });

  it("reports a well-formed but unknown object as not found", async () => {
    const repo = repository("commit-unknown");
    await expect(
      commitDetail(service(), repo.path, ".", "a".repeat(40), undefined),
    ).rejects.toThrow("Commit not found");
  });
});

describe("cherry-pick preview", () => {
  it("withholds the patch of a merge commit until a mainline is chosen", async () => {
    const repo = repository("pick-preview");
    repo.git("switch", "-q", "-c", "side");
    repo.write("side.txt", "side\n");
    repo.commit("side");
    repo.git("switch", "-q", "main");
    repo.write("main.txt", "main\n");
    repo.commit("main");
    repo.git("merge", "--no-ff", "-m", "merge side", "side");
    const merge = repo.head();
    const repositoryService = service();

    const blind = await cherryPickPreview(
      repositoryService,
      repo.path,
      ".",
      merge,
      undefined,
    );
    expect(blind.parents).toHaveLength(2);
    expect(blind.patch).toBeNull();

    const chosen = await cherryPickPreview(
      repositoryService,
      repo.path,
      ".",
      merge,
      1,
    );
    expect(chosen.mainline).toBe(1);
    expect(chosen.patch).toContain("side.txt");
  });

  it("refuses a mainline on a commit that has only one parent", async () => {
    const repo = repository("pick-mainline");
    await expect(
      cherryPickPreview(service(), repo.path, ".", repo.head(), 1),
    ).rejects.toThrow("only used when picking a merge commit");
  });

  it("answers 404 for a revision this repository does not have", async () => {
    // A panel holding an object ID or a branch name that another window has
    // since removed is asking about something that is not there — not
    // reporting an internal failure the user should file a bug for.
    const repo = repository("pick-missing");
    const repositoryService = service();
    const gone = await failure(() =>
      cherryPickPreview(
        repositoryService,
        repo.path,
        ".",
        "0".repeat(40),
        undefined,
      ),
    );
    expect(gone.status).toBe(404);
    const onto = await failure(() =>
      rebaseTodoPreview(repositoryService, repo.path, ".", "no-such-branch"),
    );
    expect(onto.status).toBe(404);
  });
});

describe("stashes", () => {
  it("lists the stack and shows one entry's three patches", async () => {
    const repo = repository("stash");
    repo.write("code.txt", "one\n");
    repo.commit("code");
    repo.write("code.txt", "two\n");
    repo.write("fresh.txt", "new\n");
    repo.git("stash", "push", "--include-untracked", "-m", "wip");
    const repositoryService = service();

    const snapshot = await stashes(repositoryService, repo.path, ".");
    expect(snapshot.stashes).toHaveLength(1);
    expect(snapshot.stashes[0]?.selector).toBe("stash@{0}");
    expect(snapshot.dirty).toBe(false);
    expect(snapshot.stateToken).toMatch(/^[0-9a-f]{64}$/);

    const detail = await stashDetail(
      repositoryService,
      repo.path,
      ".",
      snapshot.stashes[0]?.oid as string,
    );
    expect(detail.parents.length).toBe(3);
    expect(detail.patch).toContain("code.txt");
    expect(detail.untrackedPatch).toContain("fresh.txt");
  });

  it("changes the state token when an already dirty file is edited again", async () => {
    const repo = repository("stash-token");
    repo.write("code.txt", "one\n");
    repo.commit("code");
    repo.write("code.txt", "two\n");
    const repositoryService = service();
    const first = await stashes(repositoryService, repo.path, ".");
    repo.write("code.txt", "three\n");
    const second = await stashes(repositoryService, repo.path, ".");
    // `git status` reports the same row both times; the binary diff is what
    // notices the second edit.
    expect(second.stateToken).not.toBe(first.stateToken);
  });
});

describe("worktrees", () => {
  it("lists the main checkout and a linked one", async () => {
    const repo = repository("worktrees");
    repo.git("worktree", "add", "-q", "-b", "feature", "checkouts/feature");
    const records = await worktrees(service(), repo.path, ".");
    expect(records).toHaveLength(2);
    expect(records[0]?.isMain).toBe(true);
    // The new checkout is an untracked directory in the main worktree, and the
    // dirty read counts ignored files too — so "dirty" here is the truth.
    expect(records[0]?.dirty).toBe(true);
    const linked = records.find((record) => record.branch === "feature");
    expect(linked?.accessible).toBe(true);
    expect(linked?.isMain).toBe(false);
    expect(linked?.dirty).toBe(false);
  });

  it("names why a binding no longer describes anything", async () => {
    const repo = repository("binding");
    repo.git("worktree", "add", "-q", "-b", "feature", "checkouts/feature");
    const repositoryService = service();

    const ok = await verifyWorktreeBinding(repositoryService, repo.path, {
      worktreePath: "checkouts/feature",
      branch: "feature",
      repositoryId: null,
    });
    expect(ok.valid).toBe(true);
    expect(ok.code).toBe("ok");

    const moved = await verifyWorktreeBinding(repositoryService, repo.path, {
      worktreePath: "checkouts/feature",
      branch: "main",
      repositoryId: null,
    });
    expect(moved.code).toBe("branchChanged");

    const mismatched = await verifyWorktreeBinding(
      repositoryService,
      repo.path,
      {
        worktreePath: "checkouts/feature",
        branch: null,
        repositoryId: "0".repeat(64),
      },
    );
    expect(mismatched.code).toBe("repositoryMismatch");

    // A directory inside the repository that is not a registered checkout is
    // `notAWorktree`; `pathMissing` is the answer when the directory itself
    // belongs to no repository at all.
    mkdirSync(join(repo.path, "checkouts/stale"), { recursive: true });
    const stale = await verifyWorktreeBinding(repositoryService, repo.path, {
      worktreePath: "checkouts/stale",
      branch: null,
      repositoryId: null,
    });
    expect(stale.code).toBe("notAWorktree");
    expect(stale.valid).toBe(false);

    const plain = temporaryDirectory("binding-plain");
    mkdirSync(join(plain, "checkout"));
    const gone = await verifyWorktreeBinding(repositoryService, plain, {
      worktreePath: "checkout",
      branch: null,
      repositoryId: null,
    });
    expect(gone.code).toBe("pathMissing");

    // A path that does not exist at all is a 404 before any repository is
    // read, which is the same refusal every other Git read makes.
    await expect(
      verifyWorktreeBinding(repositoryService, repo.path, {
        worktreePath: "checkouts/never",
        branch: null,
        repositoryId: null,
      }),
    ).rejects.toThrow("does not exist");
  });

  it("refuses a binding that leaves the workspace", async () => {
    const repo = repository("binding-escape");
    await expect(
      verifyWorktreeBinding(service(), repo.path, {
        worktreePath: "../elsewhere",
        branch: null,
        repositoryId: null,
      }),
    ).rejects.toThrow();
  });
});

describe("discovery and the branch tree", () => {
  it("finds nested repositories, submodule-style links and worktrees", async () => {
    invalidateAll();
    const repo = repository("discovery");
    repositoryAt(join(repo.path, "apps/inner"));
    repo.git("worktree", "add", "-q", "-b", "feature", "checkouts/feature");
    mkdirSync(join(repo.path, "node_modules/pkg"), { recursive: true });
    repositoryAt(join(repo.path, "node_modules/pkg"));

    const list = await scan(repo.path, 4, false);
    const paths = list.repositories.map((record) => record.repositoryPath);
    expect(paths).toContain(".");
    expect(paths).toContain("apps/inner");
    expect(paths).toContain("checkouts/feature");
    // The fixed skip list is applied; `.gitignore` is deliberately not.
    expect(paths).not.toContain("node_modules/pkg");
    const linked = list.repositories.find(
      (record) => record.repositoryPath === "checkouts/feature",
    );
    expect(linked?.kind).toBe("worktree");
    expect(linked?.headBranch).toBe("feature");
    expect(linked?.repositoryId).toBe(list.repositories[0]?.repositoryId);
    // No grant means the dirty count is unknown, not zero.
    expect(list.repositories[0]?.dirtyCount).toBeNull();
  });

  it("counts changed entries once the grant is given", async () => {
    invalidateAll();
    const repo = repository("discovery-dirty");
    repo.write("README.md", "changed\n");
    repo.write("new.txt", "new\n");
    const list = await scan(repo.path, 4, true);
    expect(list.repositories[0]?.dirtyCount).toBe(2);
  });

  it("draws every checkout's refs, worktrees and stashes in one answer", async () => {
    invalidateAll();
    const repo = repository("tree");
    repo.git("tag", "v1");
    repo.write("code.txt", "one\n");
    repo.commit("code");
    repo.write("code.txt", "two\n");
    repo.git("stash", "push", "-m", "wip");
    repo.git("worktree", "add", "-q", "-b", "feature", "checkouts/feature");
    repositoryAt(join(repo.path, "apps/inner"));

    const snapshots = await refsSnapshot(service(), repo.path, "tree-key");
    const root = snapshots.find((entry) => entry.repositoryPath === ".");
    expect(root?.head.branch).toBe("main");
    expect(root?.branches.map((branch) => branch.name).sort()).toEqual([
      "feature",
      "main",
    ]);
    expect(root?.tags.map((tag) => tag.name)).toEqual(["v1"]);
    expect(root?.stashCount).toBe(1);
    expect(root?.stashes[0]?.index).toBe(0);
    expect(root?.worktrees).toHaveLength(2);
    expect(snapshots.map((entry) => entry.repositoryPath)).toContain(
      "apps/inner",
    );
  });
});

describe("the merged workspace log", () => {
  it("interleaves two checkouts by committer time and keeps their colours", async () => {
    invalidateAll();
    const repo = repository("log");
    const inner = repositoryAt(join(repo.path, "apps/inner"));
    repo.write("root.txt", "root\n");
    repo.commit("root change");
    inner.write("inner.txt", "inner\n");
    inner.commit("inner change");

    const page = await log(service(), repo.path, "log-key", {
      repositories: null,
      refs: { kind: "head", names: [] },
      authors: [],
      since: null,
      until: null,
      paths: [],
      text: null,
      cursor: null,
      limit: 10,
    });
    const subjects = page.commits.map((commit) => commit.subject);
    expect(subjects).toContain("root change");
    expect(subjects).toContain("inner change");
    expect(page.repositories.map((entry) => entry.path)).toEqual([
      ".",
      "apps/inner",
    ]);
    expect(page.repositories[1]?.color).toBe(1);
    expect(page.truncated).toBe(false);
  });

  it("narrows to one checkout and keeps that checkout's colour", async () => {
    invalidateAll();
    const repo = repository("log-narrow");
    repositoryAt(join(repo.path, "apps/inner"));

    const page = await log(service(), repo.path, "log-narrow-key", {
      repositories: ["apps/inner"],
      refs: { kind: "head", names: [] },
      authors: [],
      since: null,
      until: null,
      paths: [],
      text: null,
      cursor: null,
      limit: 10,
    });
    expect(page.repositories).toEqual([{ path: "apps/inner", color: 1 }]);
    expect(
      page.commits.every((commit) => commit.repositoryPath === "apps/inner"),
    ).toBe(true);
  });

  it("refuses a repository this workspace never discovered", async () => {
    invalidateAll();
    const repo = repository("log-unknown");
    await expect(
      log(service(), repo.path, "log-unknown-key", {
        repositories: ["nowhere"],
        refs: { kind: "head", names: [] },
        authors: [],
        since: null,
        until: null,
        paths: [],
        text: null,
        cursor: null,
        limit: 10,
      }),
    ).rejects.toThrow("not a repository this workspace discovered");
  });

  it("refuses a cursor whose filters changed", async () => {
    invalidateAll();
    const repo = repository("log-cursor");
    for (let index = 0; index < 3; index += 1) {
      repo.write(`file${index}.txt`, `${index}\n`);
      repo.commit(`commit ${index}`);
    }
    const repositoryService = service();
    const base = {
      repositories: null,
      refs: { kind: "head" as const, names: [] },
      authors: [],
      since: null,
      until: null,
      paths: [],
      text: null,
      limit: 1,
    };
    const first = await log(repositoryService, repo.path, "log-cursor-key", {
      ...base,
      cursor: null,
    });
    expect(first.nextCursor).not.toBeNull();
    await expect(
      log(repositoryService, repo.path, "log-cursor-key", {
        ...base,
        authors: ["someone@example.invalid"],
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("reload the first page");
  });

  it("refuses a search pattern that cannot compile", async () => {
    invalidateAll();
    const repo = repository("log-regex");
    await expect(
      log(service(), repo.path, "log-regex-key", {
        repositories: null,
        refs: { kind: "head", names: [] },
        authors: [],
        since: null,
        until: null,
        paths: [],
        text: { query: "([", regex: true, matchCase: false },
        cursor: null,
        limit: 10,
      }),
    ).rejects.toThrow("search pattern is not valid");
  });

  it("carries a tag decoration as a full ref name", async () => {
    invalidateAll();
    const repo = repository("log-decoration");
    repo.git("tag", "v1");
    const page = await log(service(), repo.path, "log-decoration-key", {
      repositories: null,
      refs: { kind: "all", names: [] },
      authors: [],
      since: null,
      until: null,
      paths: [],
      text: null,
      cursor: null,
      limit: 10,
    });
    expect(page.commits[0]?.refs).toContain("refs/tags/v1");
    expect(page.commits[0]?.refs).toContain("refs/heads/main");
  });
});

describe("the interactive rebase preview", () => {
  it("lists the replayed range oldest first and flags a merge in it", async () => {
    const repo = repository("todo-preview");
    const base = repo.head();
    repo.git("switch", "-q", "-c", "feature");
    repo.write("one.txt", "one\n");
    repo.commit("one");
    repo.write("two.txt", "two\n");
    repo.commit("two");

    const preview = await rebaseTodoPreview(service(), repo.path, ".", base);
    expect(preview.base).toBe(base);
    expect(preview.onto).toBe(base);
    expect(preview.commits.map((commit) => commit.subject)).toEqual([
      "one",
      "two",
    ]);
    expect(preview.hasMerges).toBe(false);
    expect(preview.head.branch).toBe("feature");
  });
});

describe("a binary file's line counts", () => {
  it("reports unknown rather than zero", async () => {
    const repo = repository("binary-counts");
    writeFileSync(join(repo.path, "logo.png"), Buffer.from([0, 1, 2, 3]));
    const oid = repo.commit("add binary");
    const detail = await commitDetail(
      service(),
      repo.path,
      ".",
      oid,
      undefined,
    );
    const logo = detail.files.find((file) => file.path === "logo.png");
    expect(logo?.additions).toBeNull();
    expect(logo?.deletions).toBeNull();
  });
});
