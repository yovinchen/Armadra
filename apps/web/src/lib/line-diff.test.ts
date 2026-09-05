import { describe, expect, it } from "vitest";

import { unifiedLineDiff } from "./line-diff";

describe("unifiedLineDiff", () => {
  it("says nothing when the two texts agree", () => {
    expect(unifiedLineDiff("a\nb\n", "a\nb\n")).toBe("");
    expect(unifiedLineDiff("", "")).toBe("");
  });

  it("marks the changed line and keeps the surrounding context", () => {
    const patch = unifiedLineDiff(
      "one\ntwo\nthree\nfour\nfive\n",
      "one\ntwo\nTHREE\nfour\nfive\n",
    );
    expect(patch.split("\n")).toEqual([
      "@@ -1,5 +1,5 @@",
      " one",
      " two",
      "-three",
      "+THREE",
      " four",
      " five",
    ]);
  });

  it("reports an appended line without repeating the whole file", () => {
    const patch = unifiedLineDiff("one\n", "one\ntwo\n");
    expect(patch.split("\n")).toEqual(["@@ -1,1 +1,2 @@", " one", "+two"]);
  });

  it("keeps two distant edits in separate hunks with correct line numbers", () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const after = [...before];
    after[2] = "changed early";
    after[25] = "changed late";
    const patch = unifiedLineDiff(before.join("\n"), after.join("\n"));
    const headers = patch.split("\n").filter((line) => line.startsWith("@@"));
    expect(headers).toHaveLength(2);
    expect(headers[0]).toBe("@@ -1,6 +1,6 @@");
    expect(headers[1]).toBe("@@ -23,7 +23,7 @@");
    expect(patch).toContain("-line 2");
    expect(patch).toContain("+changed early");
    expect(patch).toContain("+changed late");
  });

  it("handles a file that only gained a trailing newline", () => {
    const patch = unifiedLineDiff("one", "one\n");
    // A trailing newline alone does not add a line, so there is nothing to show.
    expect(patch).toBe("");
  });

  it("falls back to a whole-block replacement for very large edits", () => {
    const before = Array.from({ length: 900 }, (_, index) => `a${index}`).join(
      "\n",
    );
    const after = Array.from({ length: 900 }, (_, index) => `b${index}`).join(
      "\n",
    );
    const patch = unifiedLineDiff(before, after);
    expect(patch.startsWith("@@ -1,900 +1,900 @@")).toBe(true);
    expect(patch).toContain("-a0");
    expect(patch).toContain("+b899");
  });
});
