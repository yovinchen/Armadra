import { describe, expect, it } from "vitest";
import { MINI_SIZE, effectiveSize, effectiveZoom } from "./node-zoom";

describe("effectiveZoom", () => {
  it("keeps focus regardless of the viewport zoom", () => {
    expect(effectiveZoom({ zoom: "focus" }, 0.2, 0.6)).toBe("focus");
    expect(effectiveZoom({ zoom: "focus" }, 2, 0.6)).toBe("focus");
  });

  it("keeps a pinned mini node mini", () => {
    expect(effectiveZoom({ zoom: "mini" }, 1.5, 0.6)).toBe("mini");
  });

  it("collapses normal nodes below the summary threshold", () => {
    expect(effectiveZoom({ zoom: "normal" }, 0.59, 0.6)).toBe("mini");
    expect(effectiveZoom({ zoom: "normal" }, 0.6, 0.6)).toBe("normal");
    expect(effectiveZoom({ zoom: "normal" }, 1, 0.6)).toBe("normal");
  });
});

describe("effectiveSize", () => {
  it("reports the mini box so edges attach to the summary card", () => {
    expect(
      effectiveSize(
        { zoom: "normal", type: "agent", size: { width: 430, height: 600 } },
        0.4,
        0.6,
      ),
    ).toEqual(MINI_SIZE);
  });

  it("falls back to the per-type default size", () => {
    expect(effectiveSize({ zoom: "normal", type: "task" }, 1, 0.6)).toEqual({
      width: 280,
      height: 250,
    });
  });

  it("leaves the focused node's graph box untouched", () => {
    expect(
      effectiveSize(
        { zoom: "focus", type: "note", size: { width: 260, height: 180 } },
        0.3,
        0.6,
      ),
    ).toEqual({ width: 260, height: 180 });
  });
});
