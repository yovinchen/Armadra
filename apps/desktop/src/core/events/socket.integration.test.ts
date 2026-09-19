/**
 * `WS /api/workspaces/{id}/events` end to end, against a real core.
 *
 * The unit tests cover the fan-out; this covers the parts only a socket can
 * show: the pre-upgrade refusal, two clients on one workspace, and — the point
 * of the whole exercise — that what arrives on the wire is what
 * `apps/web/src/api/events.ts` would accept without a line of it changing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { type RunningCore, run } from "../main";

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

async function start(): Promise<RunningCore> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-events-"));
  directories.push(dataDir);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
    stdout: () => {},
  });
  running.push(core);
  return core;
}

function origin(core: RunningCore): string {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return `${tcp.host}:${tcp.port}`;
}

/** One workspace row, so the guard lets an upgrade through. */
function createWorkspace(core: RunningCore, id: string): void {
  core.db.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, id, `/tmp/${id}`, "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z");
}

function open(core: RunningCore, workspaceId: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://${origin(core)}/api/workspaces/${workspaceId}/events`,
    { origin: `http://${origin(core)}` },
  );
  sockets.push(socket);
  return new Promise((resolve_, reject) => {
    socket.once("open", () => resolve_(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`HTTP ${response.statusCode}`));
    });
  });
}

function next(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve_) => {
    socket.once("message", (data: Buffer) =>
      resolve_(JSON.parse(data.toString("utf8"))),
    );
  });
}

describe("the workspace event socket", () => {
  /**
   * Before the upgrade, exactly as the Rust route does: `db::get_workspace`
   * runs first and a missing workspace becomes an HTTP 404, not a socket that
   * opens and then closes. The difference matters to the front end — a socket
   * that opened resets its backoff, so it would retry at the 1 s floor forever.
   */
  it("refuses a workspace that does not exist before any socket exists", async () => {
    const core = await start();
    await expect(open(core, "ws-missing")).rejects.toThrow("HTTP 404");
  });

  it("delivers one event to two clients watching the same workspace", async () => {
    const core = await start();
    createWorkspace(core, "ws-1");
    const first = await open(core, "ws-1");
    const second = await open(core, "ws-1");
    const frames = Promise.all([next(first), next(second)]);

    core.bus.emit("workspace.event", {
      workspaceId: "ws-1",
      event: {
        type: "board.changed",
        boardId: "board-1",
        updatedAt: "2026-09-19T10:00:00+00:00",
      },
    });

    const [a, b] = await frames;
    expect(a).toEqual({
      type: "board.changed",
      boardId: "board-1",
      updatedAt: "2026-09-19T10:00:00+00:00",
    });
    expect(b).toEqual(a);
  });

  it("keeps one workspace's events out of another's socket", async () => {
    const core = await start();
    createWorkspace(core, "ws-1");
    createWorkspace(core, "ws-2");
    const first = await open(core, "ws-1");
    const second = await open(core, "ws-2");

    const other: unknown[] = [];
    second.on("message", (data: Buffer) => other.push(data.toString("utf8")));

    const arrived = next(first);
    core.bus.emit("workspace.event", {
      workspaceId: "ws-1",
      event: { type: "workspace.updated", workspaceId: "ws-1" },
    });
    expect(await arrived).toEqual({
      type: "workspace.updated",
      workspaceId: "ws-1",
    });
    expect(other).toEqual([]);
  });

  /**
   * The stream is read-only. A client frame matters only as a close; anything
   * else is ignored rather than answered, because an answer would be a second
   * protocol nothing on the other side speaks.
   */
  it("ignores what a client sends and keeps delivering", async () => {
    const core = await start();
    createWorkspace(core, "ws-1");
    const socket = await open(core, "ws-1");
    socket.send(JSON.stringify({ type: "hello" }));

    const arrived = next(socket);
    core.bus.emit("workspace.event", {
      workspaceId: "ws-1",
      event: {
        type: "board.changed",
        boardId: "b",
        updatedAt: "2026-09-19T10:00:00Z",
      },
    });
    expect(arrived).resolves.toMatchObject({ type: "board.changed" });
    await arrived;
  });

  it("stops publishing to a workspace once its last client has gone", async () => {
    const core = await start();
    createWorkspace(core, "ws-1");
    const socket = await open(core, "ws-1");
    const closed = new Promise<void>((resolve_) =>
      socket.once("close", () => resolve_()),
    );
    socket.close();
    await closed;
    // A close on the client takes a turn of the loop to reach the server.
    await new Promise((resolve_) => setTimeout(resolve_, 50));

    // Publishing into a workspace nobody watches is a no-op, never an error: a
    // save that nobody is looking at is still a save.
    expect(() =>
      core.bus.emit("workspace.event", {
        workspaceId: "ws-1",
        event: { type: "workspace.updated", workspaceId: "ws-1" },
      }),
    ).not.toThrow();
  });
});
