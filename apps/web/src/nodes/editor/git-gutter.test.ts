import { describe, expect, it } from "vitest";

import { gutterMarks, headLines, linesOf, unapplyPatch } from "./git-gutter";

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,4 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  " four",
  "@@ -6,0 +7,1 @@ four",
  "+seven",
].join("\n");

describe("unapplyPatch", () => {
  it("walks a patch backwards to the lines before it", () => {
    const after = ["one", "TWO", "three", "four", "five", "six", "seven"];
    expect(unapplyPatch(PATCH, after)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);
  });

  it("gives up when the file no longer matches the patch", () => {
    // 取 diff 与读正文之间磁盘又变了：宁可没有标记，也不画错位的。
    expect(
      unapplyPatch(PATCH, ["one", "changed", "three", "four", "five", "six"]),
    ).toBeNull();
  });

  it("handles a hunk that only removes lines", () => {
    const patch = "@@ -2,2 +1,0 @@\n-b\n-c";
    expect(unapplyPatch(patch, ["a", "d"])).toEqual(["a", "b", "c", "d"]);
  });
});

describe("gutterMarks", () => {
  it("tells added, modified and removed lines apart", () => {
    const head = ["a", "b", "c", "d", "e"];
    const current = ["a", "B", "c", "new", "d"];
    expect(gutterMarks(head, current)).toEqual([
      { line: 2, kind: "modified" },
      { line: 4, kind: "added" },
      // `e` 删在末尾，画在最后一行上。
      { line: 5, kind: "removed" },
    ]);
  });

  it("has nothing to say about an unchanged file", () => {
    expect(gutterMarks(["a", "b"], ["a", "b"])).toEqual([]);
  });
});

describe("headLines", () => {
  it("undoes the worktree patch, then the staged one", () => {
    const disk = "one\nTWO\nthree\n";
    const worktree = "@@ -2 +2 @@\n-Two\n+TWO";
    const staged = "@@ -2 +2 @@\n-two\n+Two";
    expect(
      headLines(disk, {
        worktree: { status: "M", patch: worktree, previewable: true },
        staged: { status: "M", patch: staged, previewable: true },
      }),
    ).toEqual(["one", "two", "three"]);
  });

  it("treats untracked and newly added files as entirely new", () => {
    expect(
      headLines("x\n", {
        worktree: { status: "?", patch: "+x", previewable: true },
      }),
    ).toEqual([]);
    expect(
      headLines("x\n", {
        staged: { status: "A", patch: "@@ -0,0 +1 @@\n+x", previewable: true },
      }),
    ).toEqual([]);
  });

  it("draws nothing for a patch it cannot read", () => {
    expect(
      headLines("x\n", {
        worktree: { status: "M", patch: "", previewable: false },
      }),
    ).toBeNull();
  });

  it("reads CRLF text the way the patch spells it", () => {
    expect(linesOf("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});
