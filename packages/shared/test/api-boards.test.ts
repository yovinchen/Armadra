import { describe, expect, it } from "vitest";
import { saveBoardRequestSchema } from "../src/index.js";

const timestamp = "2026-08-13T00:00:00.000Z";
const uuid = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";

describe("runtime boards API", () => {
  it("no longer accepts strokes on a board save", () => {
    const parsed = saveBoardRequestSchema.parse({
      expectedUpdatedAt: timestamp,
      nodes: [],
      edges: [],
      strokes: [{ id: uuid, color: "#fff", width: 3, points: [] }],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(parsed).not.toHaveProperty("strokes");
  });

  it("rejects retired board writes, including null, without silently stripping them", () => {
    const value = {
      expectedUpdatedAt: "2026-09-04T02:06:15.000Z",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    expect(saveBoardRequestSchema.safeParse(value).success).toBe(true);
    expect(
      saveBoardRequestSchema.safeParse({
        ...value,
        kanban: { columns: [], cards: {} },
      }).success,
    ).toBe(false);
    expect(
      saveBoardRequestSchema.safeParse({ ...value, kanban: null }).success,
    ).toBe(false);
  });
});
