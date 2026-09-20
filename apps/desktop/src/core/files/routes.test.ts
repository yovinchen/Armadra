import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "../bus";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { install } from "./routes";
import { releaseWorkspace } from "./watch";

/**
 * Ported from the pre-merge implementation (saves, entries, watch, index and
 * search over the wire).
 *
 * The language-service half of the Rust search test has no port here: that
 * surface is R5's, and the route still answers 501 by name.
 */

describe("the file routes", () => {
  let core: Fixture;
  let root: string;
  let id: string;
  const watched: string[] = [];

  beforeEach(async () => {
    core = fixture([installWorkspaces, install]);
    root = join(core.directory, "project");
    mkdirSync(join(root, "src"), { recursive: true });
    const created = await core.call("POST", "/api/workspaces", {
      name: "files",
      rootPath: root,
    });
    id = (created.body as { id: string }).id;
    watched.push(id);
  });
  afterEach(() => {
    for (const one of watched.splice(0)) releaseWorkspace(one);
    core.close();
  });

  it("requires content versions and preserves external edits", async () => {
    writeFileSync(join(root, "note.txt"), "old");
    const uri = `/api/workspaces/${id}/file`;
    const read = await core.call("GET", `${uri}?path=note.txt`);
    expect(read.status).toBe(200);
    const version = (read.body as { sha256: string }).sha256;
    expect(version).toHaveLength(64);

    writeFileSync(join(root, "note.txt"), "new");
    expect(
      (
        await core.call("PUT", uri, {
          path: "note.txt",
          content: "mine",
          expectedSize: 3,
          expectedSha256: version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await core.call("PUT", uri, {
          path: "note.txt",
          content: "mine",
          expectedSize: 3,
        })
      ).status,
    ).toBe(400);
    expect(
      (await core.call("PUT", uri, { path: "note.txt", content: "mine" }))
        .status,
    ).toBe(409);
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("new");

    const fresh = await core.call("GET", `${uri}?path=note.txt`);
    const saved = await core.call("PUT", uri, {
      path: "note.txt",
      content: "mine",
      expectedSha256: (fresh.body as { sha256: string }).sha256,
    });
    expect(saved.status).toBe(200);
    const latest = await core.call("GET", `${uri}?path=note.txt`);
    expect((saved.body as { sha256: string }).sha256).toBe(
      (latest.body as { sha256: string }).sha256,
    );
    expect((latest.body as { content: string }).content).toBe("mine");
  });

  it("gates entry operations on write access and deletes only to the trash", async () => {
    writeFileSync(join(root, "src/old.txt"), "content");
    const entries = `/api/workspaces/${id}/file-entries`;

    const created = await core.call("POST", entries, {
      path: "src/fresh.txt",
      kind: "file",
    });
    expect(created.status).toBe(200);
    expect((created.body as { path: string }).path).toBe("src/fresh.txt");
    expect(statSync(join(root, "src/fresh.txt")).isFile()).toBe(true);

    expect(
      (
        await core.call("POST", entries, {
          path: "../escape.txt",
          kind: "file",
        })
      ).status,
    ).toBe(400);

    const renamed = await core.call("POST", `${entries}/rename`, {
      from: "src/old.txt",
      to: "src/new.txt",
    });
    expect(renamed.status).toBe(200);
    expect((renamed.body as { path: string }).path).toBe("src/new.txt");
    expect(readFileSync(join(root, "src/new.txt"), "utf8")).toBe("content");

    const trashed = await core.call("POST", `${entries}/trash`, {
      path: "src/new.txt",
    });
    expect(trashed.status).toBe(200);
    const entry = trashed.body as { id: string; originalPath: string };
    expect(entry.originalPath).toBe("src/new.txt");
    expect(() => statSync(join(root, "src/new.txt"))).toThrow();

    const listed = await core.call("GET", `${entries}/trash`);
    expect((listed.body as unknown[]).length).toBe(1);

    const restored = await core.call("POST", `${entries}/restore`, {
      id: entry.id,
    });
    expect(restored.status).toBe(200);
    expect((restored.body as { path: string }).path).toBe("src/new.txt");
    expect(readFileSync(join(root, "src/new.txt"), "utf8")).toBe("content");

    const patched = await core.call("PATCH", `/api/workspaces/${id}`, {
      permissions: { read: true, write: false, execute: false },
    });
    expect(patched.status).toBe(200);
    for (const [uri, body] of [
      [entries, { path: "blocked.txt", kind: "file" }],
      [`${entries}/rename`, { from: "src/new.txt", to: "src/blocked.txt" }],
      [`${entries}/trash`, { path: "src/new.txt" }],
    ] as const) {
      const refused = await core.call("POST", uri, body);
      expect(refused.status, uri).toBe(403);
      expect((refused.body as { code: string }).code).toBe("forbidden");
    }
    expect(statSync(join(root, "src/new.txt")).isFile()).toBe(true);
    expect(() => statSync(join(root, "blocked.txt"))).toThrow();
  });

  it("pushes external changes until read access is revoked", async () => {
    writeFileSync(join(root, "note.txt"), "old\n");
    const events: WorkspaceEvent[] = [];
    core.bus.on("workspace.event", ({ event }) => {
      events.push(event);
    });
    const watch = `/api/workspaces/${id}/file-watch`;
    const registration = await core.call("POST", watch, {
      path: "note.txt",
      nodeId: "node-1",
    });
    expect(registration.status).toBe(200);
    const record = registration.body as {
      status: string;
      version: { exists: boolean; sha256: string };
    };
    expect(record.status).toBe("watching");
    expect(record.version.exists).toBe(true);
    expect(record.version.sha256).toHaveLength(64);

    // `fs.watch` returns before the OS watcher is armed; a change made inside
    // that window is never reported at all, and no amount of polling for the
    // event afterwards can recover it.
    await delay(250);
    writeFileSync(join(root, "note.txt"), "changed outside\n");
    const deadline = Date.now() + 10_000;
    while (events.length === 0 && Date.now() < deadline) await delay(20);
    const pushed = events.shift() as { type: string } & Record<string, unknown>;
    expect(pushed?.type).toBe("file.changed");
    expect(pushed?.workspaceId).toBe(id);
    expect(pushed?.path).toBe("note.txt");
    expect(pushed?.kind).toBe("modified");

    const version = await core.call(
      "GET",
      `/api/workspaces/${id}/file-version?path=note.txt`,
    );
    expect(version.status).toBe(200);
    expect((version.body as { sha256: string }).sha256).toBe(pushed?.sha256);
    expect((version.body as { size: number }).size).toBe(16);

    // Read access goes away → the watcher goes with it.
    const patched = await core.call("PATCH", `/api/workspaces/${id}`, {
      permissions: { read: false, write: false, execute: false },
    });
    expect(patched.status).toBe(200);
    const denied = await core.call("POST", watch, {
      path: "note.txt",
      nodeId: "node-1",
    });
    expect(denied.status).toBe(403);
    expect((denied.body as { code: string }).code).toBe("forbidden");
    events.length = 0;
    writeFileSync(join(root, "note.txt"), "after revocation\n");
    await delay(900);
    expect(events).toEqual([]);

    const closed = await core.call(
      "DELETE",
      `${watch}?path=note.txt&nodeId=node-1`,
    );
    expect(closed.status).toBe(204);
  });

  it("pages the index and the search and gates both on read access", async () => {
    writeFileSync(join(root, "src/client.ts"), "const needle = 1;\n");
    writeFileSync(join(root, "README.md"), "needle\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules/hidden.ts"), "needle\n");

    const index = await core.call(
      "GET",
      `/api/workspaces/${id}/file-index?query=client`,
    );
    expect(index.status).toBe(200);
    const listing = index.body as {
      entries: { path: string }[];
      truncated: boolean;
    };
    expect(listing.entries[0]?.path).toBe("src/client.ts");
    expect(listing.truncated).toBe(false);

    const page = await core.call("POST", `/api/workspaces/${id}/file-search`, {
      query: "needle",
      limit: 1,
    });
    expect(page.status).toBe(200);
    const first = page.body as {
      files: { path: string }[];
      nextOffset: number | null;
      totalMatches: number;
    };
    expect(first.files).toHaveLength(1);
    expect(first.files[0]?.path).toBe("README.md");
    expect(first.nextOffset).toBe(1);
    expect(first.totalMatches).toBe(1);

    const rest = await core.call("POST", `/api/workspaces/${id}/file-search`, {
      query: "needle",
      limit: 10,
      offset: 1,
    });
    const tail = rest.body as {
      files: { path: string }[];
      nextOffset: number | null;
    };
    expect(tail.files.map((file) => file.path)).toEqual(["src/client.ts"]);
    expect(tail.nextOffset).toBeNull();

    const invalid = await core.call(
      "POST",
      `/api/workspaces/${id}/file-search`,
      { query: "(unclosed", regex: true },
    );
    expect(invalid.status).toBe(400);
    expect((invalid.body as { code: string }).code).toBe("bad_request");

    const patched = await core.call("PATCH", `/api/workspaces/${id}`, {
      permissions: { read: false, write: false, execute: false },
    });
    expect(patched.status).toBe(200);
    expect(
      (await core.call("GET", `/api/workspaces/${id}/file-index?query=client`))
        .status,
    ).toBe(403);
    expect(
      (
        await core.call("POST", `/api/workspaces/${id}/file-search`, {
          query: "needle",
        })
      ).status,
    ).toBe(403);
  });

  it("lists a directory and describes one file", async () => {
    writeFileSync(join(root, "src/client.ts"), "export {};\n");
    const list = await core.call("GET", `/api/workspaces/${id}/files?path=src`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      path: "src",
      truncated: false,
      entries: [{ name: "client.ts", path: "src/client.ts", kind: "file" }],
    });

    const info = await core.call(
      "GET",
      `/api/workspaces/${id}/file-info?path=src/client.ts`,
    );
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      path: "src/client.ts",
      name: "client.ts",
      preview: "text",
      mimeType: "video/vnd.dlna.mpeg-tts",
    });
  });
});
