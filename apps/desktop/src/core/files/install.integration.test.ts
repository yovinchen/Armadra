import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningCore, run } from "../main";
import { MAX_BODY_BYTES } from "../http/server";
import { MAX_IMPORT_BODY_BYTES } from "../imports/routes";

/**
 * The filesystem and import domains, assembled by the real `run()` under
 * driven over a real socket.
 *
 * The route tests beside each module dispatch through the router directly,
 * which is the right level for the behaviour. What only this level can show is
 * the rest of the stack: that the fifteen paths are claimed in the table (a
 * 501 here would mean the claim never took), that a `raw` answer leaves the
 * JSON envelope alone and keeps its own headers, that a multipart upload
 * survives `readBody`, and that the body ceiling is the one the core enforces.
 */

let core: RunningCore;
let directory: string;
let root: string;
let base: string;
let workspaceId: string;

const CRLF = "\r\n";

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "armadra-core-files-"));
  root = join(directory, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", directory],
    env: { ...process.env, ARMADRA_LOG: "error" },
    stdout: () => {},
  });
  const spec = core.bound[0];
  if (spec === undefined || spec.kind !== "tcp") throw new Error("no listener");
  base = `http://${spec.host}:${spec.port}`;
  const created = await send("POST", "/api/workspaces", {
    name: "files",
    rootPath: root,
  });
  workspaceId = (created.body as { id: string }).id;
}, 30_000);

afterAll(async () => {
  await core?.stop();
  rmSync(directory, { recursive: true, force: true });
});

async function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const answer = await fetch(base + path, {
    method,
    headers: {
      origin: base,
      ...(body === undefined || Buffer.isBuffer(body)
        ? {}
        : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined
      ? {}
      : {
          body: Buffer.isBuffer(body)
            ? new Uint8Array(body)
            : JSON.stringify(body),
        }),
  });
  const text = await answer.text();
  return {
    status: answer.status,
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
    headers: answer.headers,
  };
}

function upload(boundary: string, manifest: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="manifest"${CRLF}${CRLF}${manifest}${CRLF}` +
        `--${boundary}${CRLF}Content-Disposition: form-data; name="0"; filename="untrusted"${CRLF}${CRLF}`,
      "utf8",
    ),
    bytes,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8"),
  ]);
}

describe("the assembled filesystem and import domains", () => {
  it("answers every claimed path for real rather than 501", async () => {
    const paths = [
      `/api/workspaces/${workspaceId}/files?path=.`,
      `/api/workspaces/${workspaceId}/file-index?query=`,
      `/api/workspaces/${workspaceId}/file-entries/trash`,
    ];
    for (const path of paths) {
      const answer = await send("GET", path);
      expect(answer.status, path).toBe(200);
    }
    // 表里有、还没写的那条答 501，所以上面的 200 是「真的答了」的证据，而不是
    // 「什么都没发生」的证据。
    const notYet = await send("GET", "/api/power");
    expect(notYet.status).toBe(501);
  });

  it("carries an editor session end to end", async () => {
    const uri = `/api/workspaces/${workspaceId}/file`;
    const created = await send("PUT", uri, {
      path: "src/note.txt",
      content: "one\n",
    });
    expect(created.status).toBe(200);

    const read = await send("GET", `${uri}?path=src/note.txt`);
    expect(read.status).toBe(200);
    const content = read.body as { content: string; sha256: string };
    expect(content.content).toBe("one\n");

    const watch = `/api/workspaces/${workspaceId}/file-watch`;
    const registered = await send("POST", watch, {
      path: "src/note.txt",
      nodeId: "node-1",
    });
    expect(registered.status).toBe(200);
    expect((registered.body as { status: string }).status).toBe("watching");

    const saved = await send("PUT", uri, {
      path: "src/note.txt",
      content: "two\n",
      expectedSha256: content.sha256,
    });
    expect(saved.status).toBe(200);

    const version = await send(
      "GET",
      `/api/workspaces/${workspaceId}/file-version?path=src/note.txt`,
    );
    expect((version.body as { sha256: string }).sha256).toBe(
      (saved.body as { sha256: string }).sha256,
    );

    const search = await send(
      "POST",
      `/api/workspaces/${workspaceId}/file-search`,
      { query: "two" },
    );
    expect(
      (search.body as { files: { path: string }[] }).files.map((f) => f.path),
    ).toContain("src/note.txt");

    const closed = await send(
      "DELETE",
      `${watch}?path=src/note.txt&nodeId=node-1`,
    );
    expect(closed.status).toBe(204);
    // Give the watcher a beat to let go before the suite removes the tree.
    await delay(50);
  });

  it("uploads through the real body reader and downloads with its own headers", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x0d, 0x0a, 0xff]);
    const uploaded = await send(
      "POST",
      `/api/workspaces/${workspaceId}/imports`,
      upload("edge", '{"paths":["blob.bin"]}', bytes),
      { "content-type": "multipart/form-data; boundary=edge" },
    );
    expect(uploaded.status).toBe(200);
    const path = (uploaded.body as { files: { path: string }[] }).files[0]
      ?.path as string;
    expect(readFileSync(join(root, path))).toEqual(bytes);

    const answer = await fetch(
      `${base}/api/workspaces/${workspaceId}/file-download?path=${encodeURIComponent(path)}`,
      { headers: { origin: base } },
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''%62%6C%6F%62%2E%62%69%6E",
    );
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await answer.arrayBuffer())).toEqual(bytes);
  });

  it("imports a dropped folder as its own workspace", async () => {
    const created = await send(
      "POST",
      "/api/workspaces/import?name=Dropped",
      upload(
        "edge",
        '{"paths":["a.txt"],"directories":["nested"]}',
        Buffer.from("dragged in\n", "utf8"),
      ),
      { "content-type": "multipart/form-data; boundary=edge" },
    );
    expect(created.status).toBe(200);
    const workspace = created.body as { rootPath: string };
    expect(readFileSync(join(workspace.rootPath, "a.txt"), "utf8")).toBe(
      "dragged in\n",
    );
    const listed = await send("GET", "/api/workspaces");
    expect(
      (listed.body as { name: string }[]).some((one) => one.name === "Dropped"),
    ).toBe(true);
  });

  /**
   * The two multipart routes carry the Runtime's ceiling (`MAX_BATCH_BYTES`
   * plus a MiB, as `apps/runtime/src/lib.rs` gave axum), not the core's single
   * 12 MiB one: a 12 MiB file is a legal import, and it reaches the manifest.
   */
  it("lets an upload above the core's single body ceiling reach the manifest", async () => {
    const big = Buffer.alloc(MAX_BODY_BYTES + 1024, 0x61);
    const answer = await send(
      "POST",
      `/api/workspaces/${workspaceId}/imports`,
      upload("edge", '{"paths":["big.bin"]}', big),
      { "content-type": "multipart/form-data; boundary=edge" },
    );
    expect(answer.status).toBe(200);
    const landed = (answer.body as { files: { path: string }[] }).files[0]
      ?.path as string;
    expect(statSync(join(root, landed)).size).toBe(big.length);
  });

  it("answers 413 to a body above the import ceiling instead of resetting", async () => {
    const answer = await send(
      "POST",
      `/api/workspaces/${workspaceId}/imports`,
      upload(
        "edge",
        '{"paths":["huge.bin"]}',
        Buffer.alloc(MAX_IMPORT_BODY_BYTES + 1024),
      ),
      { "content-type": "multipart/form-data; boundary=edge" },
    );
    expect(answer.status).toBe(413);
    expect(answer.body).toMatchObject({ code: "payload_too_large" });
  });
});
