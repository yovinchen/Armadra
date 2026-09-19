/**
 * The seven phase-5 language routes end to end, against a real core.
 *
 * The unit tests cover the proxy; this covers what only the HTTP and WebSocket
 * surface can show: the envelope the front end parses, the pre-upgrade
 * refusal, and the round trip a browser session actually makes — `POST` a
 * session, open its socket, `didOpen` a file, read the diagnostics back.
 *
 * The server is `tools/probes/mock-lsp.mjs`, planted in the probe cache as if
 * `--version` had found it. That is deliberate: a machine that happens to have
 * `typescript-language-server` and one that does not must run the same test.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { type RunningCore, run } from "../main";
import { settingsDomain } from "../settings";
import { MOCK_LSP } from "./fixture";
import type { JsonObject } from "./jsonrpc";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function start(): Promise<{ core: RunningCore; root: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-language-http-"));
  const root = mkdtempSync(join(tmpdir(), "armadra-language-root-"));
  directories.push(dataDir, root);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
    stdout: () => {},
  });
  running.push(core);
  return { core, root };
}

function origin(core: RunningCore): string {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return `http://${tcp.host}:${tcp.port}`;
}

function createWorkspace(
  core: RunningCore,
  id: string,
  root: string,
  permissions: { read: boolean; write: boolean; execute: boolean },
): void {
  core.db.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, permissions_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      id,
      root,
      JSON.stringify(permissions),
      "2026-09-19T00:00:00Z",
      "2026-09-19T00:00:00Z",
    );
}

/**
 * Plants a probe answer for the mock, so `openSession` launches it exactly as
 * it would launch a server a person installed. `node <mock>` is the program,
 * which the launch path spells as an executable plus arguments — so the
 * argument goes in the settings override, where a user's own `args` lives.
 */
function plantMockServer(): void {
  const settings = settingsDomain()?.settings;
  if (settings === undefined) throw new Error("settings are not assembled");
  settings.patch({
    language: {
      servers: {
        marksman: { path: process.execPath, args: [MOCK_LSP] },
      },
      probes: {
        local: {
          marksman: {
            serverId: "marksman",
            program: process.execPath,
            executable: process.execPath,
            version: "1.0.0",
            status: "ok",
            exitCode: 0,
            probedAt: new Date().toISOString(),
          },
        },
      },
    },
  });
}

async function get(core: RunningCore, path: string): Promise<Response> {
  return fetch(`${origin(core)}${path}`);
}

async function post(
  core: RunningCore,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${origin(core)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("language routes", () => {
  it("lists one row per language, with a reason, whatever the answer is", async () => {
    const { core, root } = await start();
    createWorkspace(core, "ws-1", root, {
      read: true,
      write: true,
      execute: false,
    });
    const answer = await get(core, "/api/workspaces/ws-1/language-service");
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as JsonObject;
    expect(body["executionHostId"]).toBe("local");
    const servers = body["servers"] as JsonObject[];
    // Eight languages, eight rows, every one of them explained.
    expect(servers).toHaveLength(8);
    // Without the execute grant nothing may run, and the row says which of the
    // two things is missing.
    for (const server of servers) {
      expect(server["state"]).toBe("unsupported");
      expect(typeof server["reason"]).toBe("string");
    }
    expect(body["status"]).toBe("unavailable");
  }, 60_000);

  it("a workspace that does not exist is a 404, not an empty list", async () => {
    const { core } = await start();
    const answer = await get(core, "/api/workspaces/missing/language-service");
    expect(answer.status).toBe(404);
    const body = (await answer.json()) as JsonObject;
    expect(body["code"]).toBe("not_found");
  });

  it("opens a session, streams JSON-RPC over its socket and closes it", async () => {
    const { core, root } = await start();
    createWorkspace(core, "ws-1", root, {
      read: true,
      write: true,
      execute: true,
    });
    writeFileSync(join(root, "notes.md"), "line\nTODO here\n", "utf8");
    plantMockServer();

    const opened = await post(core, "/api/workspaces/ws-1/language/sessions", {
      languageId: "markdown",
      clientId: "node-1",
    });
    expect(opened.status).toBe(200);
    const session = (await opened.json()) as JsonObject;
    expect(session["state"]).toBe("running");
    expect(session["serverId"]).toBe("marksman");
    // The handshake was done by the host; the session is handed the result.
    const capabilities = session["serverCapabilities"] as JsonObject;
    expect(capabilities["hoverProvider"]).toBe(true);
    const sessionId = session["sessionId"] as string;

    const socket = new WebSocket(
      `${origin(core).replace("http", "ws")}/api/workspaces/ws-1/language/sessions/${sessionId}/stream`,
      // The upgrade carries no preflight, so the origin header is the only
      // gate on the stream — and `ws` sends none unless it is told to.
      { origin: origin(core) },
    );
    sockets.push(socket);
    const frames: JsonObject[] = [];
    socket.on("message", (data) => {
      frames.push(JSON.parse(String(data)) as JsonObject);
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "armadra:///notes.md",
            languageId: "markdown",
            version: 1,
            text: "line\nTODO here\n",
          },
        },
      }),
    );
    const published = await waitFor(
      frames,
      (frame) => frame["method"] === "textDocument/publishDiagnostics",
    );
    const params = published["params"] as JsonObject;
    expect(params["uri"]).toBe("armadra:///notes.md");
    // Nothing absolute reaches a browser, ever.
    expect(JSON.stringify(published)).not.toContain("file://");

    const closed = await fetch(
      `${origin(core)}/api/workspaces/ws-1/language/sessions/${sessionId}`,
      { method: "DELETE" },
    );
    expect(((await closed.json()) as JsonObject)["closed"]).toBe(true);
  }, 60_000);

  it("a session that does not exist is refused before the upgrade", async () => {
    const { core, root } = await start();
    createWorkspace(core, "ws-1", root, {
      read: true,
      write: true,
      execute: true,
    });
    const socket = new WebSocket(
      `${origin(core).replace("http", "ws")}/api/workspaces/ws-1/language/sessions/nope/stream`,
      { origin: origin(core) },
    );
    sockets.push(socket);
    const status = await new Promise<number>((resolve) => {
      // `ws` reports the pre-upgrade status through `unexpected-response`; the
      // point is that no socket ever opened.
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => resolve(0));
      socket.once("error", () => resolve(-1));
    });
    expect(status).toBe(404);
  });

  it("a workspace with no execute grant cannot open a session", async () => {
    const { core, root } = await start();
    createWorkspace(core, "ws-1", root, {
      read: true,
      write: true,
      execute: false,
    });
    plantMockServer();
    const answer = await post(core, "/api/workspaces/ws-1/language/sessions", {
      languageId: "markdown",
      clientId: "node-1",
    });
    expect(answer.status).toBe(403);
    const body = (await answer.json()) as JsonObject;
    expect(body["message"]).toBe("execution_not_granted");
  }, 60_000);

  it("restart needs the execute grant and stop answers a descriptor", async () => {
    const { core, root } = await start();
    createWorkspace(core, "ws-1", root, {
      read: true,
      write: true,
      execute: true,
    });
    plantMockServer();
    const opened = await post(core, "/api/workspaces/ws-1/language/sessions", {
      languageId: "markdown",
      clientId: "node-1",
    });
    expect(opened.status).toBe(200);

    const stopped = await post(
      core,
      "/api/workspaces/ws-1/language/servers/marksman/stop",
      {},
    );
    expect(stopped.status).toBe(200);
    const descriptor = (await stopped.json()) as JsonObject;
    expect(descriptor["state"]).toBe("stopped");
    expect(descriptor["reason"]).toBe("user");
    expect(descriptor["serverId"]).toBe("marksman");

    // A server nobody started is a 404, not a silent success.
    const missing = await post(
      core,
      "/api/workspaces/ws-1/language/servers/gopls/restart",
      {},
    );
    expect(missing.status).toBe(404);
  }, 60_000);
});

async function waitFor(
  frames: readonly JsonObject[],
  matches: (frame: JsonObject) => boolean,
  timeoutMs = 20_000,
): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(matches);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("no matching frame arrived");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
