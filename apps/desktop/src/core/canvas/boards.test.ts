import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { createBoard, deleteBoard, listBoards, updateBoard } from "./boards";

/** Board rows, ported from `apps/runtime/src/db/tests/boards.rs`. */
describe("board rows", () => {
  let core: Fixture;
  let workspaceId: string;

  beforeEach(() => {
    core = fixture([]);
    workspaceId = createWorkspace(core.database, {
      name: "fixture",
      rootPath: core.directory,
    }).id;
  });
  afterEach(() => {
    core.close();
  });

  it("can be created, renamed, reordered and deleted", () => {
    const extra = createBoard(core.database, workspaceId, "Review");
    expect(extra.sortOrder).toBe(1);
    const renamed = updateBoard(core.database, workspaceId, extra.id, {
      name: "Reviewed",
      sortOrder: 0,
    });
    expect(renamed.name).toBe("Reviewed");
    expect(renamed.sortOrder).toBe(0);

    deleteBoard(core.database, workspaceId, extra.id);
    const remaining = listBoards(core.database, workspaceId);
    expect(remaining).toHaveLength(1);
    // A workspace always keeps at least one board.
    expect(() =>
      deleteBoard(core.database, workspaceId, remaining[0]?.id ?? ""),
    ).toThrowError(/at least one board/);
  });

  it("bounds the name and the order", () => {
    expect(() => createBoard(core.database, workspaceId, "  ")).toThrowError(
      /Board name is invalid/,
    );
    expect(() =>
      createBoard(core.database, workspaceId, "b".repeat(81)),
    ).toThrowError(/Board name is invalid/);
    const board = createBoard(core.database, workspaceId, "Review");
    expect(() =>
      updateBoard(core.database, workspaceId, board.id, { sortOrder: 10_001 }),
    ).toThrowError(/out of range/);
    expect(() =>
      updateBoard(core.database, workspaceId, board.id, { sortOrder: -1 }),
    ).toThrowError(/out of range/);
  });

  it("is a 404 for a board of another workspace", () => {
    const otherRoot = join(core.directory, "other");
    mkdirSync(otherRoot);
    const other = createWorkspace(core.database, {
      name: "other",
      rootPath: otherRoot,
    });
    const board = createBoard(core.database, workspaceId, "Review");
    expect(() =>
      updateBoard(core.database, other.id, board.id, { name: "Stolen" }),
    ).toThrowError(/Board was not found/);
  });
});
