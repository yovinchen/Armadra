import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { EXPORTS_DIRECTORY } from "./exports";
import { install } from "./routes";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A whiteboard export lands at `.armadra/exports/<uuid>.png`, node or not. */
describe("the PNG export route", () => {
  let core: Fixture;
  let workspaceId: string;

  beforeEach(async () => {
    core = fixture([installWorkspaces, install]);
    const created = await core.call("POST", "/api/workspaces", {
      name: "Canvas",
      rootPath: core.directory,
    });
    workspaceId = (created.body as { id: string }).id;
  });
  afterEach(() => {
    core.close();
  });

  it("writes the uploaded bytes and answers both paths", async () => {
    const id = "0f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/${id}/png`,
      { dataUrl: `data:image/png;base64,${TINY_PNG}` },
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      path: join(core.directory, EXPORTS_DIRECTORY, `${id}.png`),
      relativePath: `${EXPORTS_DIRECTORY}/${id}.png`,
      bytes: Buffer.from(TINY_PNG, "base64").length,
    });
    expect(
      readFileSync(join(core.directory, EXPORTS_DIRECTORY, `${id}.png`)),
    ).toEqual(Buffer.from(TINY_PNG, "base64"));
    expect(
      readFileSync(join(core.directory, ".armadra/.gitignore"), "utf8"),
    ).toBe("*\n");
  });

  it("refuses an id that is not a uuid and a body that is not a PNG data URL", async () => {
    const bad = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/..%2Fescape/png`,
      { dataUrl: `data:image/png;base64,${TINY_PNG}` },
    );
    expect(bad.status).toBe(400);
    const notPng = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/exports/0f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7/png`,
      { dataUrl: "data:image/jpeg;base64,AAAA" },
    );
    expect(notPng.status).toBe(400);
  });
});
