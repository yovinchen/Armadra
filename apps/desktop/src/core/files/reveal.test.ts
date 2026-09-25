import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type RevealCommand, installReveal, revealCommand } from "./reveal";

describe("the reveal command for each platform", () => {
  it("selects the item on macOS and Windows, opens the folder on Linux", () => {
    expect(revealCommand("darwin", "/work/a b/c.ts")).toEqual({
      file: "open",
      args: ["-R", "/work/a b/c.ts"],
    });
    expect(revealCommand("win32", "C:\\work\\a b\\c.ts")).toEqual({
      file: "explorer.exe",
      args: ["/select,C:\\work\\a b\\c.ts"],
    });
    expect(revealCommand("linux", "/work/a b/c.ts")).toEqual({
      file: "xdg-open",
      args: ["/work/a b"],
    });
  });
});

describe("POST …/reveal", () => {
  let core: Fixture;
  let root: string;
  let id: string;
  const launched: RevealCommand[] = [];

  beforeEach(async () => {
    launched.length = 0;
    core = fixture([
      installWorkspaces,
      (context) =>
        installReveal(context, {
          platform: "darwin",
          launch: async (command) => {
            launched.push(command);
          },
        }),
    ]);
    root = join(core.directory, "project");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "");
    const created = await core.call("POST", "/api/workspaces", {
      name: "reveal",
      rootPath: root,
    });
    id = (created.body as { id: string }).id;
  });
  afterEach(() => core.close());

  const reveal = (path: string) =>
    core.call("POST", `/api/workspaces/${id}/reveal`, { path });

  it("opens the file manager on a path inside the workspace", async () => {
    const answer = await reveal("src/a.ts");
    expect(answer.status).toBe(200);
    expect(launched).toEqual([
      {
        file: "open",
        args: ["-R", join(realpathSync(root), "src", "a.ts")],
      },
    ]);
    expect((await reveal(".")).status).toBe(200);
    expect(launched[1]?.args).toEqual(["-R", realpathSync(root)]);
  });

  it("refuses anything outside the workspace root", async () => {
    const outside = join(core.directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"));

    expect((await reveal("../outside")).status).toBe(400);
    expect((await reveal(outside)).status).toBe(400);
    const escaped = await reveal("escape");
    expect(escaped.status).toBe(403);
    expect((escaped.body as { code: string }).code).toBe("forbidden");
    expect(launched).toEqual([]);
  });

  it("refuses a workspace on another machine", async () => {
    core.database
      .prepare("UPDATE workspaces SET execution_host_id = ? WHERE id = ?")
      .run("host-1", id);
    const answer = await reveal("src/a.ts");
    expect(answer.status).toBe(501);
    expect((answer.body as { code: string }).code).toBe("unsupported");
    expect(launched).toEqual([]);
  });

  it("refuses a workspace that may not be read", async () => {
    await core.call("PATCH", `/api/workspaces/${id}`, {
      permissions: { read: false, write: false, execute: false },
    });
    expect((await reveal("src/a.ts")).status).toBe(403);
    expect(launched).toEqual([]);
  });
});
