import { describe, expect, it } from "vitest";
import { COLUMN_GAP, ROW_GAP, autoArrange } from "./auto-arrange";

const box = (id: string, width = 200, height = 100) => ({ id, width, height });

describe("autoArrange", () => {
  it("returns nothing for an empty board", () => {
    expect(autoArrange([], [])).toEqual({});
  });

  it("puts a source-only root left of its targets", () => {
    const positions = autoArrange(
      [box("a"), box("b"), box("c")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 200 + COLUMN_GAP, y: 0 });
    expect(positions.c).toEqual({ x: (200 + COLUMN_GAP) * 2, y: 0 });
  });

  it("stacks a column with the vertical gap and uses the widest column width", () => {
    const positions = autoArrange(
      [box("a", 300, 120), box("b", 200, 80), box("c", 200, 80)],
      [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    );
    expect(positions.b).toEqual({ x: 300 + COLUMN_GAP, y: 0 });
    expect(positions.c).toEqual({ x: 300 + COLUMN_GAP, y: 80 + ROW_GAP });
  });

  it("parks unconnected nodes in the trailing column", () => {
    const positions = autoArrange(
      [box("a"), box("b"), box("lonely")],
      [{ source: "a", target: "b" }],
    );
    expect(positions.lonely).toEqual({ x: (200 + COLUMN_GAP) * 2, y: 0 });
  });

  it("survives cycles and ignores edges to unknown nodes", () => {
    const positions = autoArrange(
      [box("a"), box("b")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
        { source: "a", target: "ghost" },
      ],
    );
    expect(Object.keys(positions).sort()).toEqual(["a", "b"]);
    // Every node in a pure cycle has an incoming edge, so none is a root and
    // they all land in the trailing column.
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 0, y: 100 + ROW_GAP });
  });
});
