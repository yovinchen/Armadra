import { describe, expect, it } from "vitest";

import { countConflicts, merge3, textOf, type MergeRegion } from "./merge3";

const lines = (...values: string[]) => values.join("\n") + "\n";

function stableText(regions: MergeRegion[]): string {
  return regions
    .filter((region) => region.kind === "stable")
    .flatMap((region) => (region.kind === "stable" ? region.lines : []))
    .join("\n");
}

describe("merge3", () => {
  it("reports nothing to decide when only one side changed", () => {
    const regions = merge3(
      lines("a", "b", "c"),
      lines("a", "B", "c"),
      lines("a", "b", "c"),
    );
    expect(countConflicts(regions)).toBe(0);
    expect(textOf(regions, [], true)).toBe(lines("a", "B", "c"));
  });

  // 两边改成同一样东西在合并里很常见。把它报成冲突就是让人反复确认一件
  // 自己没有做过选择的事。
  it("does not call an identical change on both sides a conflict", () => {
    const regions = merge3(
      lines("a", "b", "c"),
      lines("a", "same", "c"),
      lines("a", "same", "c"),
    );
    expect(countConflicts(regions)).toBe(0);
    expect(textOf(regions, [], true)).toBe(lines("a", "same", "c"));
  });

  it("keeps all three sides of a real conflict", () => {
    const regions = merge3(
      lines("a", "b", "c"),
      lines("a", "ours", "c"),
      lines("a", "theirs", "c"),
    );
    expect(countConflicts(regions)).toBe(1);
    const conflict = regions.find((region) => region.kind === "conflict");
    expect(conflict?.kind === "conflict" && conflict.base).toEqual(["b"]);
    expect(conflict?.kind === "conflict" && conflict.ours).toEqual(["ours"]);
    expect(conflict?.kind === "conflict" && conflict.theirs).toEqual([
      "theirs",
    ]);
    // 稳定段是两侧共有的上下文，不该把冲突那一行也吞进去。
    expect(stableText(regions)).toBe("a\nc");
  });

  it("writes whichever side the caller picked, or both", () => {
    const regions = merge3(
      lines("a", "b", "c"),
      lines("a", "ours", "c"),
      lines("a", "theirs", "c"),
    );
    expect(textOf(regions, ["ours"], true)).toBe(lines("a", "ours", "c"));
    expect(textOf(regions, ["theirs"], true)).toBe(lines("a", "theirs", "c"));
    expect(textOf(regions, ["both"], true)).toBe(
      lines("a", "ours", "theirs", "c"),
    );
    expect(textOf(regions, ["base"], true)).toBe(lines("a", "b", "c"));
    expect(textOf(regions, ["none"], true)).toBe(lines("a", "c"));
  });

  // 一边在某行之前插入、另一边没动，插入的位置就在那一行之前——不能被并进
  // 后面的删除段里，那会把插入的内容挪到别的地方去。
  it("places an insertion where it happened rather than merging it forward", () => {
    const regions = merge3(
      lines("a", "b"),
      lines("a", "inserted", "b"),
      lines("a", "b"),
    );
    expect(countConflicts(regions)).toBe(0);
    expect(textOf(regions, [], true)).toBe(lines("a", "inserted", "b"));
  });

  it("treats two different appended tails as one conflict", () => {
    const regions = merge3(
      lines("a"),
      lines("a", "ours"),
      lines("a", "theirs"),
    );
    expect(countConflicts(regions)).toBe(1);
    expect(textOf(regions, ["theirs"], true)).toBe(lines("a", "theirs"));
  });

  it("keeps the file's own trailing newline decision", () => {
    const regions = merge3("a\nb", "a\nB", "a\nb");
    expect(textOf(regions, [], false)).toBe("a\nB");
    expect(textOf(regions, [], true)).toBe("a\nB\n");
  });

  it("survives an empty side", () => {
    const regions = merge3(lines("a", "b"), "", lines("a", "b", "c"));
    expect(regions.length).toBeGreaterThan(0);
    expect(textOf(regions, ["theirs"], true)).toBe(lines("a", "b", "c"));
  });
});
