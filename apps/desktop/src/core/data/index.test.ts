import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { install } from "./index";

describe("the data routes", () => {
  let core: Fixture;
  beforeEach(() => {
    core = fixture([installWorkspaces, install]);
  });
  afterEach(() => {
    core.close();
  });

  it("reports where the data is and how much of it there is", async () => {
    const answer = await core.call("GET", "/api/data/info");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      dataDir: core.directory,
      conversations: 0,
      boardLogRetentionDays: 0,
    });
    expect((answer.body as { dbBytes: number }).dbBytes).toBeGreaterThan(0);
  });

  it("writes a manual backup beside the database and says how big it is", async () => {
    const answer = await core.call("POST", "/api/data/backup");
    expect(answer.status).toBe(200);
    const { path, bytes } = answer.body as { path: string; bytes: number };
    expect(path.startsWith(core.directory)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    expect(
      readdirSync(core.directory).some((name) =>
        name.startsWith("canvas.db.backup-manual-"),
      ),
    ).toBe(true);
  });
});
