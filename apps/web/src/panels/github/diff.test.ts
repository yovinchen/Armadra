import { describe, expect, it } from "vitest";

import {
  anchorFor,
  anchorKey,
  commentable,
  commentsByAnchor,
  parsePatch,
} from "./diff";
import { githubReviewComment } from "../../api/github";

/**
 * 行内评论的位置只来自 hunk 头算出来的行号。这份测试钉的是「算不出来就不给
 * 入口」——一条贴到错误行上的评审意见比没有这条意见糟得多。
 */

const patch = [
  "@@ -10,4 +10,5 @@ func main() {",
  " \tsetup()",
  "-\told()",
  "+\tfresh()",
  "+\talso()",
  " \tdone()",
  "@@ -40,2 +41,2 @@",
  "-\tgone()",
  "+\tkept()",
].join("\n");

describe("parsePatch", () => {
  it("counts both sides from the hunk header, not from the array index", () => {
    const lines = parsePatch(patch);
    const numbers = lines.map((line) => [
      line.kind,
      line.leftLine,
      line.rightLine,
    ]);
    expect(numbers).toEqual([
      ["meta", null, null],
      ["context", 10, 10],
      ["remove", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
      ["meta", null, null],
      ["remove", 40, null],
      ["add", null, 41],
    ]);
  });

  it("treats the no-newline marker and anything before the first hunk as metadata", () => {
    const lines = parsePatch(
      [
        "stray preamble",
        "@@ -1,1 +1,1 @@",
        "-a",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    expect(lines[0]!.kind).toBe("meta");
    expect(lines.at(-1)!.kind).toBe("meta");
    expect(lines.at(-1)!.leftLine).toBeNull();
  });

  it("is empty for a file with no patch at all", () => {
    expect(parsePatch("")).toEqual([]);
  });
});

describe("anchorFor", () => {
  it("puts a removal on LEFT and an addition or context line on RIGHT", () => {
    const lines = parsePatch(patch);
    expect(anchorFor("a.go", lines[2]!)).toEqual({
      path: "a.go",
      line: 11,
      side: "LEFT",
    });
    expect(anchorFor("a.go", lines[3]!)).toEqual({
      path: "a.go",
      line: 11,
      side: "RIGHT",
    });
    expect(anchorFor("a.go", lines[1]!)).toEqual({
      path: "a.go",
      line: 10,
      side: "RIGHT",
    });
  });

  it("gives a metadata line no anchor at all", () => {
    const lines = parsePatch(patch);
    expect(anchorFor("a.go", lines[0]!)).toBeNull();
  });

  it("keys the two sides of the same line number apart", () => {
    expect(anchorKey({ path: "a.go", line: 11, side: "LEFT" })).not.toBe(
      anchorKey({ path: "a.go", line: 11, side: "RIGHT" }),
    );
  });
});

describe("commentsByAnchor", () => {
  const comment = (overrides: Record<string, unknown>) =>
    githubReviewComment({
      id: 1n,
      path: "a.go",
      line: 11n,
      side: "RIGHT",
      body: "here",
      ...overrides,
    });

  it("groups comments by the exact position they were left at", () => {
    const grouped = commentsByAnchor([
      comment({ id: 1n }),
      comment({ id: 2n, side: "LEFT" }),
      comment({ id: 3n, line: 12n }),
    ]);
    expect(
      grouped.get(anchorKey({ path: "a.go", line: 11, side: "RIGHT" }))?.length,
    ).toBe(1);
    expect(
      grouped.get(anchorKey({ path: "a.go", line: 11, side: "LEFT" }))?.length,
    ).toBe(1);
  });

  it("never places an outdated comment on a line of the current diff", () => {
    const grouped = commentsByAnchor([comment({ id: 4n, outdated: true })]);
    expect(grouped.size).toBe(0);
  });

  it("drops a comment with no usable position rather than guessing one", () => {
    const grouped = commentsByAnchor([
      comment({ id: 5n, line: 0n }),
      comment({ id: 6n, path: "" }),
    ]);
    expect(grouped.size).toBe(0);
  });
});

describe("commentable", () => {
  const file = (overrides: Record<string, unknown>) =>
    ({
      path: "a.go",
      previousPath: "",
      status: "modified",
      additions: 1n,
      deletions: 1n,
      binary: false,
      patch: "",
      ...overrides,
    }) as never;

  it("needs a patch: a binary file and a dropped patch both have no lines", () => {
    expect(commentable(file({ patch }))).toBe(true);
    expect(commentable(file({ patch: "" }))).toBe(false);
    expect(commentable(file({ patch, binary: true }))).toBe(false);
  });
});
