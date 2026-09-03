import { describe, expect, it } from "vitest";
import type { GitFileStatus } from "@ai-coding-canvas/shared";

import { partitionChanges } from "./SourceControlDrawer";

function file(
  partial: Partial<GitFileStatus> & { path: string },
): GitFileStatus {
  return {
    status: partial.status ?? "M",
    staged: partial.staged ?? false,
    unstaged: partial.unstaged ?? false,
    path: partial.path,
  };
}

describe("partitionChanges", () => {
  it("splits on the porcelain XY columns", () => {
    const { staged, changes } = partitionChanges([
      file({ path: "indexed.ts", staged: true }),
      file({ path: "edited.ts", unstaged: true }),
      file({ path: "new.ts", status: "?", unstaged: true }),
    ]);

    expect(staged.map((entry) => entry.path)).toEqual(["indexed.ts"]);
    expect(changes.map((entry) => entry.path)).toEqual(["edited.ts", "new.ts"]);
  });

  it("lists a file in both sections when it was edited after staging", () => {
    const both = file({ path: "a.ts", staged: true, unstaged: true });
    const { staged, changes } = partitionChanges([both]);

    // `MM`: the index and the working tree each hold a different version, so
    // both sections need a row — they open different diffs.
    expect(staged).toEqual([both]);
    expect(changes).toEqual([both]);
  });

  it("returns empty sections for a clean repository", () => {
    expect(partitionChanges([])).toEqual({ staged: [], changes: [] });
  });
});
