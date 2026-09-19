import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install as installFiles } from "../files/routes";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { IMPORTS_DIRECTORY } from "./limits";
import { install } from "./routes";

/**
 * Ported from `apps/runtime/src/api/tests/files.rs`:
 * `file_import_roundtrip_preserves_binary_bytes_and_download_boundary` and
 * `file_import_rejects_traversal_incomplete_payloads_and_readonly_workspaces`.
 */

const CRLF = "\r\n";

function multipart(
  boundary: string,
  manifest: string,
  files: readonly { readonly name: string; readonly bytes: Buffer }[] = [],
): Buffer {
  const chunks: Buffer[] = [
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="manifest"${CRLF}${CRLF}${manifest}${CRLF}`,
      "utf8",
    ),
  ];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.name}"; filename="ignored"${CRLF}${CRLF}`,
        "utf8",
      ),
    );
    chunks.push(file.bytes);
    chunks.push(Buffer.from(CRLF, "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, "utf8"));
  return Buffer.concat(chunks);
}

describe("the import routes", () => {
  let core: Fixture;
  let root: string;
  let workspaceId: string;

  beforeEach(async () => {
    core = fixture([installWorkspaces, installFiles, install]);
    root = join(core.directory, "project");
    mkdirSync(root);
    const created = await core.call("POST", "/api/workspaces", {
      name: "files",
      rootPath: root,
    });
    workspaceId = (created.body as { id: string }).id;
  });
  afterEach(() => {
    core.close();
  });

  it("round-trips binary bytes and keeps the download boundary", async () => {
    const data = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0x62, 0x69,
      0x6e,
    ]);
    const uploaded = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/imports`,
      multipart("test-boundary", '{"paths":["report.pdf"]}', [
        { name: "0", bytes: data },
      ]),
      { "content-type": "multipart/form-data; boundary=test-boundary" },
    );
    expect(uploaded.status).toBe(200);
    const result = uploaded.body as {
      path: string;
      files: { path: string; preview: string }[];
    };
    const path = result.files[0]?.path ?? "";
    expect(path.startsWith(`${IMPORTS_DIRECTORY}/`)).toBe(true);
    expect(result.files[0]?.preview).toBe("download");
    expect(readFileSync(join(root, path))).toEqual(data);

    const downloaded = await core.call(
      "GET",
      `/api/workspaces/${workspaceId}/file-download?path=${encodeURIComponent(path)}`,
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.raw).toEqual(data);
    expect(downloaded.headers?.["content-disposition"]).toMatch(/^attachment;/);
    expect(downloaded.headers?.["x-content-type-options"]).toBe("nosniff");

    const outside = join(core.directory, "secret.txt");
    writeFileSync(outside, "secret");
    const escaped = await core.call(
      "GET",
      `/api/workspaces/${workspaceId}/file-download?path=${encodeURIComponent(outside)}`,
    );
    expect(escaped.status).toBe(403);
  });

  it("rejects traversal, incomplete payloads and read-only workspaces", async () => {
    for (const path of ["../escape", "a.txt"] as const) {
      const answer = await core.call(
        "POST",
        `/api/workspaces/${workspaceId}/imports`,
        multipart("b", JSON.stringify({ paths: [path] })),
        { "content-type": "multipart/form-data; boundary=b" },
      );
      expect(answer.status, path).toBe(400);
    }
    expect(readdirSync(join(root, IMPORTS_DIRECTORY))).toEqual([]);

    const patched = await core.call("PATCH", `/api/workspaces/${workspaceId}`, {
      permissions: { read: true, write: false, execute: true },
    });
    expect(patched.status).toBe(200);
    const refused = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/imports/local`,
      { paths: ["file.txt"] },
    );
    expect(refused.status).toBe(403);
  });

  it("imports a whole folder as a new workspace", async () => {
    const created = await core.call(
      "POST",
      "/api/workspaces/import?name=Dropped",
      multipart(
        "b",
        '{"paths":["src/main.ts"],"directories":["src","empty"]}',
        [{ name: "0", bytes: Buffer.from("export {};\n", "utf8") }],
      ),
      { "content-type": "multipart/form-data; boundary=b" },
    );
    expect(created.status).toBe(200);
    const workspace = created.body as { name: string; rootPath: string };
    expect(workspace.name).toBe("Dropped");
    // The copies land in the core's own data directory, never at a path the
    // browser named.
    expect(
      workspace.rootPath.startsWith(
        join(core.directory, "imported-workspaces"),
      ),
    ).toBe(true);
    expect(statSync(join(workspace.rootPath, "empty")).isDirectory()).toBe(
      true,
    );
    expect(readFileSync(join(workspace.rootPath, "src/main.ts"), "utf8")).toBe(
      "export {};\n",
    );
  });

  it("copies files the shell already has paths for", async () => {
    const source = join(core.directory, "dropped.txt");
    writeFileSync(source, "from the desktop");
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/imports/local`,
      { paths: [source, source] },
    );
    expect(answer.status).toBe(200);
    const result = answer.body as { files: { name: string; path: string }[] };
    expect(result.files.map((file) => file.name)).toEqual([
      "dropped.txt",
      "dropped-2.txt",
    ]);
    expect(readFileSync(join(root, result.files[1]?.path ?? ""), "utf8")).toBe(
      "from the desktop",
    );
    // The source is a copy, not a mount: it is still where it was.
    expect(readFileSync(source, "utf8")).toBe("from the desktop");
  });

  it("refuses an import with no files and one with too many", async () => {
    const none = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/imports/local`,
      { paths: [] },
    );
    expect(none.status).toBe(400);
    const many = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/imports/local`,
      { paths: Array.from({ length: 257 }, () => "a.txt") },
    );
    expect(many.status).toBe(400);
  });
});
