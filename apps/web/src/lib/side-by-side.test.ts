import { describe, expect, it } from "vitest";
import { countMatches, sideBySideRows } from "./side-by-side";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " keep one",
  "-old two",
  "-old three",
  "+new two",
  "+new three",
  "+extra four",
  " keep five",
  "\\ No newline at end of file",
].join("\n");

describe("side-by-side rows", () => {
  it("pairs a change block and keeps the line numbers each side actually has", () => {
    const rows = sideBySideRows(patch);
    const meta = rows.filter((row) => row.kind === "meta");
    expect(meta).toHaveLength(5);
    const hunk = rows.find((row) => row.kind === "hunk");
    expect(hunk?.left?.text).toBe("@@ -1,4 +1,5 @@");

    const content = rows.filter(
      (row) => row.kind === "context" || row.kind === "change",
    );
    // Context first, then the paired change block, then context again.
    expect(content[0]).toEqual({
      kind: "context",
      left: { number: 1, text: "keep one" },
      right: { number: 1, text: "keep one" },
    });
    expect(content[1]).toEqual({
      kind: "change",
      left: { number: 2, text: "old two" },
      right: { number: 2, text: "new two" },
    });
    expect(content[2]).toEqual({
      kind: "change",
      left: { number: 3, text: "old three" },
      right: { number: 3, text: "new three" },
    });
    // The extra added line has no counterpart on the left; it is not invented.
    expect(content[3]).toEqual({
      kind: "change",
      left: null,
      right: { number: 4, text: "extra four" },
    });
    expect(content[4]).toEqual({
      kind: "context",
      left: { number: 4, text: "keep five" },
      right: { number: 5, text: "keep five" },
    });
  });

  it("never reads a +++ header as an added line", () => {
    const rows = sideBySideRows(patch);
    expect(
      rows.some(
        (row) => row.kind === "change" && row.right?.text.startsWith("+ b/"),
      ),
    ).toBe(false);
  });

  it("counts matching rows on either side and ignores an empty query", () => {
    const rows = sideBySideRows(patch);
    expect(countMatches(rows, "")).toBe(0);
    expect(countMatches(rows, "   ")).toBe(0);
    expect(countMatches(rows, "keep")).toBe(2);
    // A term present only on the removed side still counts once.
    expect(countMatches(rows, "old three")).toBe(1);
    expect(countMatches(rows, "OLD THREE")).toBe(1);
  });

  it("returns nothing for an empty patch", () => {
    expect(sideBySideRows("")).toEqual([]);
  });
});
