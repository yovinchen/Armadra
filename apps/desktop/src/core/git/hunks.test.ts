import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, repository, service } from "./fixture";
import { applyHunk, readHunks } from "./hunks";
import { readStatusAt } from "./status";

/**
 * Hunk-level staging.
 *
 * Ported from the pre-merge implementation's hunk unit and API test suites.
 */

afterAll(cleanupFixtures);

function multiHunkFile(name: string) {
  const repo = repository(name);
  repo.write(
    "code.txt",
    Array.from({ length: 30 }, (_, index) => `line ${index}\n`).join(""),
  );
  repo.commit("code");
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}\n`);
  lines[2] = "changed early\n";
  lines[25] = "changed late\n";
  repo.write("code.txt", lines.join(""));
  return repo;
}

describe("reading hunks", () => {
  it("splits an edit into the hunks the panel offers separately", async () => {
    const repo = multiHunkFile("hunks-read");
    const diff = await readHunks(
      service(),
      repo.path,
      ".",
      "code.txt",
      "worktree",
    );
    expect(diff.supported).toBe(true);
    expect(diff.unsupportedReason).toBeNull();
    expect(diff.hunks).toHaveLength(2);
    expect(diff.diffDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(diff.hunks[0]?.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff.hunks[0]?.content).toContain("+changed early");
    expect(diff.hunks[1]?.content).toContain("+changed late");
    // Every hunk id is distinct and bound to the diff it came from.
    expect(diff.hunks[0]?.id).not.toBe(diff.hunks[1]?.id);
  });

  it("names why a file has no hunks rather than failing", async () => {
    const repo = repository("hunks-unsupported");
    writeFileSync(join(repo.path, "logo.png"), Buffer.from([0, 1, 2, 0, 3]));
    repo.commit("add binary");
    writeFileSync(join(repo.path, "logo.png"), Buffer.from([9, 9, 0, 9]));
    const binary = await readHunks(
      service(),
      repo.path,
      ".",
      "logo.png",
      "worktree",
    );
    expect(binary.supported).toBe(false);
    expect(binary.unsupportedReason).toBe("binary");
    // Even a refusal carries a stable identity, so the panel can key on it.
    expect(binary.diffDigest).toMatch(/^[0-9a-f]{64}$/);

    const untouched = await readHunks(
      service(),
      repo.path,
      ".",
      "README.md",
      "worktree",
    );
    expect(untouched.unsupportedReason).toBe("notTrackedModification");
  });

  it("refuses a path that is not repository-relative", async () => {
    const repo = repository("hunks-path");
    for (const file of ["../escape.txt", ".git/config", "", "a/./b"]) {
      await expect(
        readHunks(service(), repo.path, ".", file, "worktree"),
      ).rejects.toThrow();
    }
  });
});

describe("applying one hunk", () => {
  it("stages one hunk and leaves the other unstaged", async () => {
    const repo = multiHunkFile("hunks-stage");
    const repositoryService = service();
    const diff = await readHunks(
      repositoryService,
      repo.path,
      ".",
      "code.txt",
      "worktree",
    );
    const result = await applyHunk(repositoryService, repo.path, {
      path: ".",
      file: "code.txt",
      scope: "worktree",
      diffDigest: diff.diffDigest,
      hunkId: diff.hunks[0]?.id as string,
      action: "stage",
    });
    expect(result.applied).toBe(true);
    const status = await readStatusAt(repo.path, ".");
    const entry = status.files.find((file) => file.path === "code.txt");
    expect(entry?.staged).toBe(true);
    expect(entry?.unstaged).toBe(true);
    expect(repo.git("diff", "--cached")).toContain("+changed early");
    expect(repo.git("diff", "--cached")).not.toContain("+changed late");
  });

  it("unstages one hunk from the index", async () => {
    const repo = multiHunkFile("hunks-unstage");
    repo.git("add", "code.txt");
    const repositoryService = service();
    const diff = await readHunks(
      repositoryService,
      repo.path,
      ".",
      "code.txt",
      "staged",
    );
    expect(diff.hunks).toHaveLength(2);
    await applyHunk(repositoryService, repo.path, {
      path: ".",
      file: "code.txt",
      scope: "staged",
      diffDigest: diff.diffDigest,
      hunkId: diff.hunks[1]?.id as string,
      action: "unstage",
    });
    expect(repo.git("diff", "--cached")).toContain("+changed early");
    expect(repo.git("diff", "--cached")).not.toContain("+changed late");
  });

  it("reverts one hunk out of the worktree", async () => {
    const repo = multiHunkFile("hunks-revert");
    const repositoryService = service();
    const diff = await readHunks(
      repositoryService,
      repo.path,
      ".",
      "code.txt",
      "worktree",
    );
    await applyHunk(repositoryService, repo.path, {
      path: ".",
      file: "code.txt",
      scope: "worktree",
      diffDigest: diff.diffDigest,
      hunkId: diff.hunks[0]?.id as string,
      action: "revert",
    });
    const after = repo.git("diff");
    expect(after).not.toContain("+changed early");
    expect(after).toContain("+changed late");
  });

  it("refuses a digest that no longer describes the file", async () => {
    const repo = multiHunkFile("hunks-stale");
    const repositoryService = service();
    const diff = await readHunks(
      repositoryService,
      repo.path,
      ".",
      "code.txt",
      "worktree",
    );
    repo.write("code.txt", "rewritten entirely\n");
    await expect(
      applyHunk(repositoryService, repo.path, {
        path: ".",
        file: "code.txt",
        scope: "worktree",
        diffDigest: diff.diffDigest,
        hunkId: diff.hunks[0]?.id as string,
        action: "stage",
      }),
    ).rejects.toThrow("reload its hunks");
  });

  it("reports a change that is already gone as stale, not as unsupported", async () => {
    const repo = multiHunkFile("hunks-vanished");
    const repositoryService = service();
    const diff = await readHunks(
      repositoryService,
      repo.path,
      ".",
      "code.txt",
      "worktree",
    );
    // Someone else (another panel, the terminal) staged the whole file: the
    // worktree scope now has nothing in it, which is not a property of the
    // file and must not be reported as one.
    repo.git("add", "code.txt");
    await expect(
      applyHunk(repositoryService, repo.path, {
        path: ".",
        file: "code.txt",
        scope: "worktree",
        diffDigest: diff.diffDigest,
        hunkId: diff.hunks[0]?.id as string,
        action: "stage",
      }),
    ).rejects.toThrow("reload its hunks");
  });

  it("refuses an action the scope does not allow", async () => {
    const repo = multiHunkFile("hunks-scope");
    const repositoryService = service();
    const diff = await readHunks(
      repositoryService,
      repo.path,
      ".",
      "code.txt",
      "worktree",
    );
    await expect(
      applyHunk(repositoryService, repo.path, {
        path: ".",
        file: "code.txt",
        scope: "worktree",
        diffDigest: diff.diffDigest,
        hunkId: diff.hunks[0]?.id as string,
        action: "unstage",
      }),
    ).rejects.toThrow("action, scope or identity is invalid");
  });

  it("refuses an identity that is not a digest", async () => {
    const repo = multiHunkFile("hunks-identity");
    const repositoryService = service();
    await expect(
      applyHunk(repositoryService, repo.path, {
        path: ".",
        file: "code.txt",
        scope: "worktree",
        diffDigest: "short",
        hunkId: "x".repeat(64),
        action: "stage",
      }),
    ).rejects.toThrow("action, scope or identity is invalid");
  });

  it("refuses a hunk id from a different diff", async () => {
    const repo = multiHunkFile("hunks-foreign");
    const repositoryService = service();
    const diff = await readHunks(
      repositoryService,
      repo.path,
      ".",
      "code.txt",
      "worktree",
    );
    await expect(
      applyHunk(repositoryService, repo.path, {
        path: ".",
        file: "code.txt",
        scope: "worktree",
        diffDigest: diff.diffDigest,
        hunkId: "a".repeat(64),
        action: "stage",
      }),
    ).rejects.toThrow("reload its hunks");
  });
});
