#!/usr/bin/env node
/**
 * End-to-end smoke for the TypeScript core's terminal domain.
 *
 * Starts `out/core/main.js` against a throwaway data directory, creates a
 * terminal over HTTP, attaches over WebSocket, types, reads the echo back,
 * closes the socket, reattaches and proves the second attach sees what the
 * first one typed — which is what "the pane survives the node being closed"
 * means in one assertion.
 *
 * No Electron, no port 1420, no browser: the acceptance path is the protocol,
 * and the page's own state machine (`apps/web/src/terminal/transport.ts`) is
 * exercised by its own tests against these exact frames.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const coreEntry = join(repo, "apps/desktop/out/core/main.js");

/**
 * `ws` and `node:sqlite` are resolved from `apps/desktop`, not from here:
 * `tools/` has no `node_modules` of its own and is not meant to grow one.
 */
const require = createRequire(join(repo, "apps/desktop/package.json"));
const { WebSocket } = require("ws");

export async function startCore({ dataDir, port = 0 }) {
  const child = spawn(
    process.execPath,
    [coreEntry, "--listen", `tcp:127.0.0.1:${port}`, "--data-dir", dataDir],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  // The address is on stderr, not stdout: stdout carries the one-line
  // announcement the shell parses, and everything else is the log.
  const address = await new Promise((resolveAddress, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`core did not announce:\n${stderr}`)),
      20_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const found = /Armadra core is listening .*"spec":"tcp:([^"]+)"/.exec(
        stderr,
      );
      if (found) {
        clearTimeout(timer);
        resolveAddress(found[1]);
      }
    });
    child.stdout.resume();
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`core exited with ${code}:\n${stderr}`));
    });
  });
  return {
    child,
    base: `http://${address}`,
    ws: `ws://${address}`,
    stderr: () => stderr,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
    },
  };
}

/** Every frame a socket saw, plus helpers to wait for one. */
export function collect(socket) {
  const frames = [];
  const waiters = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString("utf8"));
    frames.push(frame);
    for (const waiter of waiters.splice(0)) waiter(frame);
  });
  return {
    frames,
    text: () =>
      frames
        .filter((frame) => frame.type === "output" || frame.type === "snapshot")
        .map((frame) => frame.data)
        .join(""),
    async waitFor(predicate, timeout = 10_000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for a frame; saw ${JSON.stringify(
              frames.map((f) => f.type),
            )}`,
          );
        }
        await Promise.race([new Promise((r) => waiters.push(r)), delay(50)]);
      }
    },
  };
}

export function openSocket(base, sessionId, writer = "smoke") {
  const socket = new WebSocket(
    `${base}/api/terminals/${sessionId}/ws?writer=${writer}`,
    { origin: "http://127.0.0.1:1420" },
  );
  return socket;
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-core-smoke-"));
  const core = await startCore({ dataDir });
  let failure;
  try {
    // A workspace row has to exist: `terminal_sessions.workspace_id` is a
    // foreign key, and R1 owns the route that would create one.
    seedWorkspace(dataDir);

    const created = await fetch(`${core.base}/api/terminals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: WORKSPACE,
        cwd: dataDir,
        shell: "/bin/sh",
      }),
    });
    const session = await created.json();
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(session)}`);
    console.log("created", session.id, session.backend, session.generation);

    const first = openSocket(core.ws, session.id);
    const firstFrames = collect(first);
    await new Promise((r) => first.once("open", r));
    const hello = await firstFrames.waitFor((f) => f.type === "hello");
    assert(hello.backend === "tmux", `backend was ${hello.backend}`);
    assert(hello.alive === true, "session was not alive");
    assert(hello.generation === 1, `generation was ${hello.generation}`);

    const marker = `armadra-smoke-${Date.now()}`;
    first.send(
      JSON.stringify({ type: "input", data: `echo ${marker}\r`, inputId: 1 }),
    );
    await firstFrames.waitFor((f) => f.type === "ack" && f.inputId === 1);
    await firstFrames.waitFor(
      (f) => f.type === "output" && f.data.includes(marker),
    );
    console.log("echo round-tripped");

    first.close();
    await delay(500);

    // Reattach: the tmux client redraws, so the marker is on the screen the
    // second socket receives without any replay on our side.
    const second = openSocket(core.ws, session.id);
    const secondFrames = collect(second);
    await new Promise((r) => second.once("open", r));
    await secondFrames.waitFor((f) => f.type === "hello");
    await secondFrames.waitFor(
      (f) => f.type === "output" && f.data.includes(marker),
    );
    console.log("sawEarlierOutput: the reattached socket sees the same screen");
    second.close();

    const ended = await fetch(
      `${core.base}/api/terminals/${session.id}/terminate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "session" }),
      },
    );
    const row = await ended.json();
    assert(ended.ok, `terminate failed: ${JSON.stringify(row)}`);
    console.log("terminated", row.status);

    // A socket for a session nobody knows is refused before the upgrade.
    const refused = openSocket(core.ws, "00000000-0000-0000-0000-000000000000");
    const status = await new Promise((r) => {
      refused.once("unexpected-response", (_req, response) =>
        r(response.statusCode),
      );
      refused.once("open", () => r(101));
      refused.once("error", () => r(0));
    });
    assert(status === 404, `unknown session answered ${status}, expected 404`);
    console.log("unknown session refused with 404 before the upgrade");

    console.log("\nOK");
  } catch (error) {
    failure = new Error(
      `${error.message}\n--- core log ---\n${core.stderr().slice(-4000)}`,
    );
  } finally {
    await core.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (failure) {
    console.error(String(failure));
    process.exit(1);
  }
}

export const WORKSPACE = "00000000-0000-0000-0000-0000000000aa";

/**
 * The one row the terminal domain cannot create for itself.
 *
 * `POST /api/workspaces` is R1's, so until it lands a probe has to write the
 * workspace directly. It is a probe-only shortcut and deliberately lives here
 * rather than in the core.
 */
export function seedWorkspace(dataDir, id = WORKSPACE) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(join(dataDir, "canvas.db"));
  const columns = database
    .prepare("PRAGMA table_info(workspaces)")
    .all()
    .map((column) => column.name);
  const values = {
    id,
    name: "smoke",
    root_path: dataDir,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const used = columns.filter((name) => name in values);
  database
    .prepare(
      `INSERT OR IGNORE INTO workspaces (${used.join(", ")}) VALUES (${used
        .map(() => "?")
        .join(", ")})`,
    )
    .run(...used.map((name) => values[name]));
  database.close();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
