import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "./fixture";
import {
  createWorkspace,
  ensureDefaultWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from "./table";

/**
 * The `workspaces` table, ported from `apps/runtime/src/db/tests/workspaces.rs`
 * one test at a time.
 */
describe("the workspaces table", () => {
  let core: Fixture;

  beforeEach(() => {
    core = fixture([]);
  });
  afterEach(() => {
    core.close();
  });

  function root(name: string): string {
    const path = join(core.directory, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  it("reopens the existing workspace when the same root is authorized twice", () => {
    const path = root("project");
    const first = createWorkspace(core.database, {
      name: "First",
      rootPath: path,
    });
    const again = createWorkspace(core.database, {
      name: "Second",
      rootPath: path,
    });
    expect(again.id).toBe(first.id);
    // The name is the first one's: the root is the identity, and authorizing
    // it again is not a rename.
    expect(again.name).toBe("First");
    expect(listWorkspaces(core.database)).toHaveLength(1);
    // Exactly one default board, not two.
    expect(listWorkspaces(core.database)[0]?.boards).toHaveLength(1);
  });

  it("orders summaries by when each was last opened", () => {
    const older = createWorkspace(core.database, {
      name: "Older",
      rootPath: root("older"),
    });
    const newer = createWorkspace(core.database, {
      name: "Newer",
      rootPath: root("newer"),
    });
    const summaries = listWorkspaces(core.database);
    expect(summaries.map((one) => one.id)).toEqual([newer.id, older.id]);
    expect(summaries[0]?.boards[0]?.name).toBe("Default");
    expect(summaries[0]?.boards[0]?.nodeCount).toBe(0);
  });

  it("patches only the fields the request supplied", () => {
    const created = createWorkspace(core.database, {
      name: "Before",
      rootPath: root("patch"),
      color: "#abcdef",
    });
    const renamed = updateWorkspace(core.database, created.id, {
      name: "After",
    });
    expect(renamed.name).toBe("After");
    // Upper-cased on the way in, and untouched by a patch that did not name it.
    expect(renamed.color).toBe("#ABCDEF");
    expect(renamed.permissions).toEqual(created.permissions);

    const recoloured = updateWorkspace(core.database, created.id, {
      color: "#001122",
    });
    expect(recoloured.name).toBe("After");
    expect(recoloured.color).toBe("#001122");

    expect(() =>
      updateWorkspace(core.database, created.id, { color: "red" }),
    ).toThrowError(/#RRGGBB/);
    expect(() =>
      updateWorkspace(core.database, created.id, { name: "   " }),
    ).toThrowError(/name is invalid/);
  });

  it("gives an empty database one default workspace and never a second", () => {
    const created = ensureDefaultWorkspace(core.database, core.directory);
    expect(created?.name).toBe("Default");
    expect(created?.permissions).toEqual({
      read: true,
      write: true,
      execute: true,
    });
    // Rows that exist mean the user has already chosen.
    expect(
      ensureDefaultWorkspace(core.database, core.directory),
    ).toBeUndefined();
    expect(listWorkspaces(core.database)).toHaveLength(1);
  });

  it("refuses a workspace nobody registered", () => {
    expect(() =>
      getWorkspace(core.database, "00000000-0000-0000-0000-000000000000"),
    ).toThrowError(/Workspace was not found/);
  });
});
