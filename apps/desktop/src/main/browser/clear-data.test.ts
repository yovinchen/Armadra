import { describe, expect, it } from "vitest";

import { browserPartitions, clearBrowsingData } from "./clear-data";

function fakeSessions(failing: string[] = []) {
  const calls: string[] = [];
  return {
    calls,
    sessionFor: (partition: string) => ({
      clearStorageData: async () => {
        if (failing.includes(partition)) throw new Error("locked");
        calls.push(`storage:${partition}`);
      },
      clearCache: async () => {
        calls.push(`cache:${partition}`);
      },
    }),
  };
}

describe("clearing browser node data", () => {
  it("clears every browser partition on disk plus the ones the page names", async () => {
    const sessions = fakeSessions();
    const result = await clearBrowsingData(
      {
        partitionsDir: "/userData/Partitions",
        readDir: () => [
          "armadra-browser-old",
          "some-other",
          "armadra-browser-a",
        ],
        sessionFor: sessions.sessionFor as never,
      },
      { workspaceIds: ["a", "fresh"] },
    );
    expect(result).toEqual({ ok: true, cleared: 3 });
    expect(sessions.calls).toEqual([
      "storage:persist:armadra-browser-a",
      "cache:persist:armadra-browser-a",
      "storage:persist:armadra-browser-fresh",
      "cache:persist:armadra-browser-fresh",
      "storage:persist:armadra-browser-old",
      "cache:persist:armadra-browser-old",
    ]);
  });

  it("never touches a partition outside the browser family", () => {
    expect(
      browserPartitions(
        { partitionsDir: "/x", readDir: () => ["armadra-browser-../../etc"] },
        ["../x", 7, "ok_id", ""],
      ),
    ).toEqual(["persist:armadra-browser-ok_id"]);
  });

  it("treats a missing Partitions directory as nothing on disk", () => {
    expect(
      browserPartitions(
        {
          partitionsDir: "/x",
          readDir: () => {
            throw new Error("ENOENT");
          },
        },
        undefined,
      ),
    ).toEqual([]);
  });

  it("reports a partition it could not clear", async () => {
    const sessions = fakeSessions(["persist:armadra-browser-b"]);
    const result = await clearBrowsingData(
      {
        partitionsDir: "/x",
        readDir: () => [],
        sessionFor: sessions.sessionFor as never,
      },
      { workspaceIds: ["a", "b"] },
    );
    expect(result).toEqual({ ok: false, cleared: 1 });
  });
});
