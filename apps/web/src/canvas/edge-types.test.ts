import { describe, expect, it } from "vitest";
import { EDGE_TYPES } from "@ai-coding-canvas/shared";
import { legalEdgeTypes, recommendedEdgeType } from "./edge-types";

describe("legalEdgeTypes", () => {
  it("always offers all six semantics so no connection is blocked", () => {
    for (const list of [
      legalEdgeTypes("file", "agent"),
      legalEdgeTypes("file", "terminal"),
      legalEdgeTypes("image", "note"),
    ]) {
      expect(list).toHaveLength(EDGE_TYPES.length);
      expect([...list].sort()).toEqual([...EDGE_TYPES].sort());
    }
  });

  it("puts the recommended semantic first so the 1 key picks it", () => {
    expect(legalEdgeTypes("task", "agent")[0]).toBe("dispatch");
    expect(legalEdgeTypes("file", "agent")[0]).toBe("ref");
    expect(legalEdgeTypes("agent", "diff")[0]).toBe("produce");
    expect(legalEdgeTypes("diff", "file")[0]).toBe("write");
    expect(legalEdgeTypes("terminal", "agent")[0]).toBe("trigger");
    expect(legalEdgeTypes("file", "terminal")[0]).toBe("link");
  });
});

describe("recommendedEdgeType", () => {
  it("treats every context-bearing node feeding an agent as a reference", () => {
    for (const source of [
      "file",
      "context",
      "note",
      "browser",
      "image",
      "log",
    ] as const) {
      expect(recommendedEdgeType(source, "agent")).toBe("ref");
    }
  });

  it("falls back to a soft link for unrelated pairs", () => {
    expect(recommendedEdgeType("note", "file")).toBe("link");
    expect(recommendedEdgeType("diff", "log")).toBe("link");
  });
});
