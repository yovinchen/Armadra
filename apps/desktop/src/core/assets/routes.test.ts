import { readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { install } from "./routes";
import { ASSETS_DIRECTORY, MAX_ASSET_BYTES } from "./store";
import { tempDir } from "../testing/temp-dir";

/**
 * The whiteboard asset store, ported from
 * the pre-merge implementation: deduplication, both upload body
 * shapes, import from a path and the read-back boundary.
 */

/** The 1×1 PNG every asset test uploads. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("the asset routes", () => {
  let core: Fixture;
  let workspaceId: string;
  const png = Buffer.from(TINY_PNG, "base64");

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

  function stored(): string[] {
    return readdirSync(join(core.directory, ASSETS_DIRECTORY));
  }

  it("deduplicates uploads and serves them back", async () => {
    // A `File` is posted raw with its own content type.
    const uploaded = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets`,
      png,
      { "content-type": "image/png" },
    );
    expect(uploaded.status).toBe(200);
    const asset = uploaded.body as {
      id: string;
      path: string;
      url: string;
      mimeType: string;
      bytes: number;
    };
    expect(asset.id.endsWith(".png")).toBe(true);
    expect(asset.path).toBe(`${ASSETS_DIRECTORY}/${asset.id}`);
    expect(asset.url).toBe(`/api/workspaces/${workspaceId}/assets/${asset.id}`);
    expect(asset.mimeType).toBe("image/png");
    expect(asset.bytes).toBe(png.byteLength);
    expect(stored()).toEqual([asset.id]);

    // The same bytes as a data URL land on the same file: the name is the
    // content hash, so nothing is stored twice.
    const same = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets`,
      { dataUrl: `data:image/png;base64,${TINY_PNG}` },
    );
    expect(same.status).toBe(200);
    expect((same.body as { id: string }).id).toBe(asset.id);
    expect(stored()).toHaveLength(1);

    // …and it reads back with the right type and an immutable cache header.
    const served = await core.call(
      "GET",
      `/api/workspaces/${workspaceId}/assets/${asset.id}`,
    );
    expect(served.status).toBe(200);
    expect(served.headers?.["content-type"]).toBe("image/png");
    expect(served.headers?.["cache-control"]).toContain("immutable");
    expect(served.headers?.["x-content-type-options"]).toBe("nosniff");
    expect(served.raw?.equals(png)).toBe(true);

    // A type outside the whitelist is refused before anything is written.
    const script = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets`,
      Buffer.from("#!/bin/sh\nrm -rf /"),
      { "content-type": "application/x-sh" },
    );
    expect(script.status).toBe(400);

    // The id is matched, never resolved: traversal is a 400, not a read.
    for (const crafted of [
      "../../etc/passwd",
      "../../passwd.png",
      "0011223344556677.sh",
      "nothex0011223344.png",
    ]) {
      const answer = await core.call(
        "GET",
        `/api/workspaces/${workspaceId}/assets/${encodeURIComponent(crafted)}`,
      );
      expect([400, 404], `${crafted} came back ${answer.status}`).toContain(
        answer.status,
      );
    }
    // A well-formed id nothing was uploaded under is a 404.
    const missing = await core.call(
      "GET",
      `/api/workspaces/${workspaceId}/assets/00112233445566ff.png`,
    );
    expect(missing.status).toBe(404);
  });

  it("imports an asset from a path into the same store", async () => {
    // A picture the user dragged in from outside the workspace.
    const outside = tempDir("armadra-drag-");
    const source = join(outside, "shot.PNG");
    writeFileSync(source, png);

    const imported = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets/import`,
      { path: source },
    );
    expect(imported.status).toBe(200);
    const asset = imported.body as { id: string; path: string; bytes: number };
    expect(asset.id.endsWith(".png")).toBe(true);
    expect(asset.path).toBe(`${ASSETS_DIRECTORY}/${asset.id}`);
    expect(asset.bytes).toBe(png.byteLength);

    // The same bytes uploaded the normal way are the same file.
    const uploaded = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets`,
      { dataUrl: `data:image/png;base64,${TINY_PNG}` },
    );
    expect((uploaded.body as { id: string }).id).toBe(asset.id);
    expect(stored()).toHaveLength(1);

    // A workspace-relative path works too, and reaches the same file.
    writeFileSync(join(core.directory, "inside.png"), png);
    const relative = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets/import`,
      { path: "inside.png" },
    );
    expect((relative.body as { id: string }).id).toBe(asset.id);

    // A path nobody wrote is a 404.
    const nothing = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets/import`,
      { path: join(outside, "missing.png") },
    );
    expect(nothing.status).toBe(404);

    // A directory, a non-image and a relative path climbing out are 400s.
    writeFileSync(join(core.directory, "notes.txt"), "hello");
    for (const bad of [outside, "notes.txt", "../escape.png"]) {
      const answer = await core.call(
        "POST",
        `/api/workspaces/${workspaceId}/assets/import`,
        { path: bad },
      );
      expect(answer.status, `${bad} came back ${answer.status}`).toBe(400);
    }

    // A symlink out of the workspace is refused rather than followed.
    symlinkSync(source, join(core.directory, "link.png"));
    const linked = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets/import`,
      { path: "link.png" },
    );
    expect(linked.status).toBe(403);

    // Over the ceiling: refused from the metadata, nothing new on disk.
    writeFileSync(join(outside, "big.png"), Buffer.alloc(MAX_ASSET_BYTES + 1));
    const big = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets/import`,
      { path: join(outside, "big.png") },
    );
    expect(big.status).toBe(400);
    expect(stored()).toHaveLength(1);
  });

  it("refuses an empty asset, an oversized one and a bad data URL", async () => {
    const empty = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets`,
      Buffer.alloc(0),
      { "content-type": "image/png" },
    );
    expect(empty.status).toBe(400);

    const oversized = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/assets`,
      Buffer.alloc(MAX_ASSET_BYTES + 1, 1),
      { "content-type": "image/png" },
    );
    expect(oversized.status).toBe(400);

    for (const dataUrl of [
      "https://example.com/a.png",
      "data:image/png,notbase64",
      "data:application/x-sh;base64,AAAA",
      "data:image/png;base64,!!!!",
    ]) {
      const answer = await core.call(
        "POST",
        `/api/workspaces/${workspaceId}/assets`,
        { dataUrl },
      );
      expect(answer.status, dataUrl).toBe(400);
    }
    expect(() => stored()).toThrow();
  });

  it("refuses to write into a read-only workspace", async () => {
    const readOnly = await core.call("POST", "/api/workspaces", {
      name: "locked",
      rootPath: core.directory,
      permissions: { read: true, write: false, execute: false },
    });
    // The same root hands back the existing row, so patch the one we have.
    const id = (readOnly.body as { id: string }).id;
    await core.call("PATCH", `/api/workspaces/${id}`, {
      permissions: { read: true, write: false, execute: false },
    });
    const answer = await core.call(
      "POST",
      `/api/workspaces/${id}/assets`,
      png,
      {
        "content-type": "image/png",
      },
    );
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "forbidden" });
  });
});
