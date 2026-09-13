import { describe, expect, it } from "vitest";
import {
  gitDiffRequestSchema,
  gitFileDiffSchema,
  gitStatusSchema,
  gitUnstageResponseSchema,
} from "../src/index.js";

describe("runtime git API", () => {
  it("reads per-file git status, and tolerates a runtime without it", () => {
    const status = gitStatusSchema.parse({
      repository: true,
      branch: "main",
      changedCount: 2,
      files: [
        { path: "a.ts", status: "M", staged: false, unstaged: true },
        { path: "b.ts", status: "A", staged: true, unstaged: false },
      ],
    });
    expect(status.files.map((file) => file.staged)).toEqual([false, true]);
    // Older runtimes omit `files` entirely rather than throwing on every poll.
    expect(
      gitStatusSchema.parse({ repository: true, branch: null, changedCount: 0 })
        .files,
    ).toEqual([]);
    expect(
      gitStatusSchema.safeParse({
        repository: true,
        branch: "main",
        changedCount: 1,
        files: [{ path: "a.ts", status: "X", staged: true, unstaged: false }],
      }).success,
    ).toBe(false);
  });

  it("defaults a diff request to the worktree scope and a real diff", () => {
    expect(gitDiffRequestSchema.parse({})).toEqual({
      scope: "worktree",
      // Whitespace is only ever ignored when the viewer asks for it.
      ignoreWhitespace: false,
    });
    expect(
      gitDiffRequestSchema.parse({ scope: "staged", paths: ["a.ts"] }),
    ).toEqual({
      scope: "staged",
      paths: ["a.ts"],
      ignoreWhitespace: false,
    });
    expect(gitDiffRequestSchema.safeParse({ scope: "index" }).success).toBe(
      false,
    );
    // `staged` defaults to false so an older runtime's diff still parses.
    expect(
      gitFileDiffSchema.parse({
        path: "a.ts",
        status: "M",
        additions: 1,
        deletions: 0,
        patch: "",
      }).staged,
    ).toBe(false);
  });

  it("types the unstage response", () => {
    expect(
      gitUnstageResponseSchema.parse({ unstaged: ["a.ts"] }).unstaged,
    ).toEqual(["a.ts"]);
  });
});
