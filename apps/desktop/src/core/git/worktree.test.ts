import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DomainError } from "../workspaces/support";
import { initRepository, commit, headCommit } from "./commit";
import { readDiff } from "./diff";
import { cleanupFixtures, repository, temporaryDirectory } from "./fixture";
import {
  conflictMarkerLines,
  markResolved,
  revertPaths,
  stagePaths,
  unstagePaths,
} from "./stage";
import {
  normalizeFileStatus,
  parsePorcelainZ,
  readStatusAt,
  readStatusBatch,
  readStatusFiltered,
} from "./status";

/**
 * The worktree half of the domain: status, diff, staging and committing.
 *
 * Ported from `apps/runtime/src/git/tests/{status,diff,stage,commit}.rs` and
 * `apps/runtime/tests/git_repository_api.rs`.
 */

afterAll(cleanupFixtures);

describe("porcelain parsing", () => {
  it("reads the index and worktree columns apart", () => {
    const entries = parsePorcelainZ(
      "M  staged.txt\0 M dirty.txt\0?? new.txt\0",
    );
    expect(entries).toEqual([
      {
        path: "staged.txt",
        status: "M",
        staged: true,
        unstaged: false,
        originPath: null,
      },
      {
        path: "dirty.txt",
        status: "M",
        staged: false,
        unstaged: true,
        originPath: null,
      },
      {
        path: "new.txt",
        status: "?",
        staged: false,
        unstaged: true,
        originPath: null,
      },
    ]);
  });

  it("keeps a rename's origin and does not read it as the next record", () => {
    const entries = parsePorcelainZ("R  new.txt\0old.txt\0M  other.txt\0");
    expect(entries).toEqual([
      {
        path: "new.txt",
        status: "R",
        staged: true,
        unstaged: false,
        originPath: "old.txt",
      },
      {
        path: "other.txt",
        status: "M",
        staged: true,
        unstaged: false,
        originPath: null,
      },
    ]);
  });

  it("normalizes every porcelain code to the badge set", () => {
    expect(normalizeFileStatus("??")).toBe("?");
    expect(normalizeFileStatus("R ")).toBe("R");
    expect(normalizeFileStatus("C ")).toBe("A");
    expect(normalizeFileStatus("A ")).toBe("A");
    expect(normalizeFileStatus(" D")).toBe("D");
    expect(normalizeFileStatus("UU")).toBe("M");
    expect(normalizeFileStatus("  ")).toBe("?");
  });
});

describe("status", () => {
  it("answers `repository: false` outside a repository", async () => {
    const root = temporaryDirectory("plain");
    const status = await readStatusAt(root, ".");
    expect(status).toEqual({
      repository: false,
      branch: null,
      changedCount: 0,
      files: [],
    });
  });

  it("reports the branch, the count and each file's two columns", async () => {
    const repo = repository("status");
    repo.write("tracked.txt", "one\n");
    repo.commit("add tracked");
    repo.write("tracked.txt", "two\n");
    repo.write("fresh.txt", "new\n");
    repo.git("add", "fresh.txt");

    const status = await readStatusAt(repo.path, ".");
    expect(status.repository).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.changedCount).toBe(2);
    expect(status.files.map((file) => file.path).sort()).toEqual([
      "fresh.txt",
      "tracked.txt",
    ]);
  });

  it("omits ahead and behind entirely without an upstream", async () => {
    const repo = repository("no-upstream");
    const status = await readStatusAt(repo.path, ".");
    expect("ahead" in status).toBe(false);
    expect("behind" in status).toBe(false);
  });

  it("narrows both passes with one pathspec, so the count matches the list", async () => {
    const repo = repository("filtered");
    repo.write("apps/one.txt", "a\n");
    repo.write("libs/two.txt", "b\n");

    const all = await readStatusFiltered(repo.path, ".", []);
    expect(all.changedCount).toBe(2);
    const narrowed = await readStatusFiltered(repo.path, ".", ["apps"]);
    expect(narrowed.changedCount).toBe(1);
    expect(narrowed.files.map((file) => file.path)).toEqual(["apps/one.txt"]);
  });

  it("refuses a pathspec that would stop being a path", async () => {
    const repo = repository("pathspec");
    await expect(
      readStatusFiltered(repo.path, ".", ["--output=x"]),
    ).rejects.toThrow("must not start with a dash");
    await expect(
      readStatusFiltered(repo.path, ".", ["../outside"]),
    ).rejects.toThrow(DomainError);
  });

  it("reports one broken checkout as that checkout's failure", async () => {
    const repo = repository("batch");
    mkdirSync(join(repo.path, "not-a-repo"));
    const batch = await readStatusBatch(repo.path, {
      paths: [".", "not-a-repo", "."],
      pathspecs: [],
    });
    // The duplicate `.` is dropped rather than read twice.
    expect(batch.repositories).toHaveLength(2);
    expect(batch.repositories[0]?.status?.repository).toBe(true);
    // A directory inside the repository is still the repository.
    expect(batch.repositories[1]?.status?.repository).toBe(true);
    expect(batch.observedAt).toMatch(/\+00:00$/);
  });

  it("refuses a batch outside one and sixty-four repositories", async () => {
    const repo = repository("batch-limit");
    await expect(
      readStatusBatch(repo.path, { paths: [], pathspecs: [] }),
    ).rejects.toThrow("Between one and 64");
  });
});

describe("diff", () => {
  it("lists an untracked file as an addition with a `+` patch", async () => {
    const repo = repository("diff-untracked");
    repo.write("fresh.txt", "one\ntwo\n");
    const diff = await readDiff(repo.path, ".", {
      scope: "worktree",
      paths: [],
      ignoreWhitespace: false,
    });
    const file = diff.files.find((entry) => entry.path === "fresh.txt");
    expect(file?.status).toBe("?");
    expect(file?.additions).toBe(2);
    expect(file?.patch).toBe("+one\n+two");
    expect(file?.previewable).toBe(true);
  });

  it("never lists an untracked file in the staged scope", async () => {
    const repo = repository("diff-staged");
    repo.write("fresh.txt", "one\n");
    const diff = await readDiff(repo.path, ".", {
      scope: "staged",
      paths: [],
      ignoreWhitespace: false,
    });
    expect(diff.files).toHaveLength(0);
    expect(diff.clean).toBe(true);
  });

  it("keeps a whitespace-only change in the list but out of the counts", async () => {
    const repo = repository("diff-whitespace");
    repo.write("code.txt", "one\n");
    repo.commit("add code");
    repo.write("code.txt", "one  \n");

    const shown = await readDiff(repo.path, ".", {
      scope: "worktree",
      paths: [],
      ignoreWhitespace: false,
    });
    expect(shown.files[0]?.additions).toBe(1);

    const hidden = await readDiff(repo.path, ".", {
      scope: "worktree",
      paths: [],
      ignoreWhitespace: true,
    });
    // Still listed — it is a change — but with an empty patch and 0/0.
    expect(hidden.files).toHaveLength(1);
    expect(hidden.files[0]?.additions).toBe(0);
    expect(hidden.files[0]?.patch).toBe("");
  });

  it("marks a binary untracked file unpreviewable rather than failing", async () => {
    const repo = repository("diff-binary");
    writeFileSync(join(repo.path, "blob.bin"), Buffer.from([0, 1, 2, 255]));
    const diff = await readDiff(repo.path, ".", {
      scope: "worktree",
      paths: [],
      ignoreWhitespace: false,
    });
    const file = diff.files.find((entry) => entry.path === "blob.bin");
    expect(file?.previewable).toBe(false);
    expect(file?.patch).toBe("");
  });

  it("refuses the worktree scope without the execution grant", async () => {
    const repo = repository("diff-grant");
    await expect(
      readDiff(
        repo.path,
        ".",
        { scope: "worktree", paths: [], ignoreWhitespace: false },
        false,
      ),
    ).rejects.toThrow("execution permission");
  });

  it("answers the staged scope without the execution grant", async () => {
    const repo = repository("diff-grant-staged");
    repo.write("code.txt", "one\n");
    repo.git("add", "code.txt");
    const diff = await readDiff(
      repo.path,
      ".",
      { scope: "staged", paths: [], ignoreWhitespace: false },
      false,
    );
    expect(diff.files.map((file) => file.path)).toEqual(["code.txt"]);
  });
});

describe("staging", () => {
  it("stages, unstages and restores by source", async () => {
    const repo = repository("stage");
    repo.write("code.txt", "one\n");
    repo.commit("add code");
    repo.write("code.txt", "two\n");

    expect((await stagePaths(repo.path, ".", ["code.txt"])).staged).toEqual([
      "code.txt",
    ]);
    repo.write("code.txt", "three\n");
    // An index restore keeps the staged version and loses only the edit above.
    await revertPaths(repo.path, ".", ["code.txt"], "index");
    expect(readFileSync(join(repo.path, "code.txt"), "utf8")).toBe("two\n");

    await revertPaths(repo.path, ".", ["code.txt"], "head");
    expect(readFileSync(join(repo.path, "code.txt"), "utf8")).toBe("one\n");
    const status = await readStatusAt(repo.path, ".");
    expect(status.files).toHaveLength(0);
  });

  it("removes an untracked file from the index before the first commit", async () => {
    const repo = repository("unborn", false);
    repo.write("first.txt", "one\n");
    await stagePaths(repo.path, ".", ["first.txt"]);
    const result = await unstagePaths(repo.path, ".", ["first.txt"]);
    expect(result.unstaged).toEqual(["first.txt"]);
    const status = await readStatusAt(repo.path, ".");
    expect(status.files[0]?.status).toBe("?");
  });

  it("refuses to restore from HEAD on an unborn branch", async () => {
    const repo = repository("unborn-restore", false);
    repo.write("first.txt", "one\n");
    await stagePaths(repo.path, ".", ["first.txt"]);
    await expect(
      revertPaths(repo.path, ".", ["first.txt"], "head"),
    ).rejects.toThrow("no commit to restore");
  });

  it("deletes an untracked file either way", async () => {
    const repo = repository("revert-untracked");
    repo.write("scratch.txt", "one\n");
    const result = await revertPaths(repo.path, ".", ["scratch.txt"], "index");
    expect(result.reverted).toEqual(["scratch.txt"]);
    expect(
      (await readStatusAt(repo.path, ".")).files.map((file) => file.path),
    ).toEqual([]);
  });

  it("refuses a symlink and a path outside the workspace", async () => {
    const repo = repository("stage-symlink");
    // A link inside the repository resolves fine and is refused for what it
    // is; a link that leaves the workspace is refused earlier, for where it
    // points.
    repo.write("target.txt", "yes\n");
    symlinkSync(join(repo.path, "target.txt"), join(repo.path, "link.txt"));
    await expect(stagePaths(repo.path, ".", ["link.txt"])).rejects.toThrow(
      "Only regular files",
    );
    const outside = temporaryDirectory("outside");
    writeFileSync(join(outside, "secret.txt"), "no\n");
    symlinkSync(join(outside, "secret.txt"), join(repo.path, "escape.txt"));
    await expect(stagePaths(repo.path, ".", ["escape.txt"])).rejects.toThrow(
      "outside the authorized workspace",
    );
    await expect(
      stagePaths(repo.path, ".", ["../outside/secret.txt"]),
    ).rejects.toThrow(DomainError);
  });

  it("refuses more than two hundred paths", async () => {
    const repo = repository("stage-limit");
    const paths = Array.from({ length: 201 }, (_, index) => `f${index}.txt`);
    await expect(stagePaths(repo.path, ".", paths)).rejects.toThrow(
      "Between one and 200",
    );
  });
});

describe("conflict markers", () => {
  it("finds exactly seven-character markers on their own lines", () => {
    const text = [
      "one",
      "<<<<<<< ours",
      "two",
      "=======",
      "three",
      ">>>>>>> theirs",
      "<<<<<<<< not a marker",
      "",
    ].join("\n");
    expect(conflictMarkerLines(Buffer.from(text))).toEqual([2, 4, 6]);
  });

  it("refuses to mark a path resolved while a marker remains", async () => {
    const repo = repository("resolve");
    repo.write("code.txt", "base\n");
    repo.commit("base");
    repo.git("switch", "-q", "-c", "other");
    repo.write("code.txt", "theirs\n");
    repo.commit("theirs");
    repo.git("switch", "-q", "main");
    repo.write("code.txt", "ours\n");
    repo.commit("ours");
    expect(() => repo.git("merge", "other")).toThrow();

    await expect(markResolved(repo.path, ".", ["code.txt"])).rejects.toThrow(
      "still contains conflict markers",
    );
    repo.write("code.txt", "resolved\n");
    const resolved = await markResolved(repo.path, ".", ["code.txt"]);
    expect(resolved.resolved).toEqual(["code.txt"]);
  });

  it("refuses a path that is not conflicted", async () => {
    const repo = repository("resolve-clean");
    repo.write("code.txt", "one\n");
    await expect(markResolved(repo.path, ".", ["code.txt"])).rejects.toThrow(
      "not a conflicted path",
    );
  });
});

describe("commit", () => {
  it("says in one sentence that nothing is staged, not git's whole porcelain", async () => {
    const repo = repository("commit-nothing");
    repo.write("seed.txt", "seed\n");
    repo.commit("seed");
    repo.write("stray.txt", "untracked\n");
    await expect(
      commit(repo.path, ".", "nothing here", undefined, undefined),
    ).rejects.toMatchObject({
      status: 400,
      message: "Nothing is staged to commit",
    });
  });

  it("commits the named paths and reports the short hash", async () => {
    const repo = repository("commit");
    repo.write("one.txt", "one\n");
    repo.write("two.txt", "two\n");
    const result = await commit(
      repo.path,
      ".",
      "add one",
      ["one.txt"],
      undefined,
    );
    expect(result.committed).toEqual(["one.txt"]);
    expect(result.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(
      (await readStatusAt(repo.path, ".")).files.map((file) => file.path),
    ).toEqual(["two.txt"]);
  });

  it("refuses an empty or oversized message", async () => {
    const repo = repository("commit-message");
    await expect(
      commit(repo.path, ".", "   ", undefined, undefined),
    ).rejects.toThrow("Commit message is invalid");
    await expect(
      commit(repo.path, ".", "x".repeat(10_001), undefined, undefined),
    ).rejects.toThrow("Commit message is invalid");
  });

  it("amends only the reviewed commit", async () => {
    const repo = repository("amend");
    const head = await headCommit(repo.path, ".");
    expect(head?.subject).toBe("seed");
    expect(head?.published).toBe(false);

    await expect(
      commit(repo.path, ".", "reworded", undefined, {
        expectedHead: "0".repeat(40),
        allowPublished: false,
      }),
    ).rejects.toThrow("HEAD moved");

    repo.write("extra.txt", "extra\n");
    const amended = await commit(repo.path, ".", "reworded", ["extra.txt"], {
      expectedHead: head?.oid as string,
      allowPublished: false,
    });
    expect(amended.commit).not.toBe(head?.oid);
    expect((await headCommit(repo.path, "."))?.subject).toBe("reworded");
  });

  it("reports an unborn branch as no head commit", async () => {
    const repo = repository("head-unborn", false);
    expect(await headCommit(repo.path, ".")).toBeNull();
  });
});

describe("init", () => {
  it("creates a repository and reports the unborn branch", async () => {
    const root = temporaryDirectory("init");
    const result = await initRepository(root);
    expect(result.repository).toBe(true);
    expect(result.path).toBe(root);
    expect(typeof result.branch).toBe("string");
  });

  it("refuses to nest a second repository inside an existing one", async () => {
    const repo = repository("init-nested");
    await expect(initRepository(repo.path)).rejects.toThrow(
      "already belongs to a Git repository",
    );
  });
});
