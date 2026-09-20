import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreContext } from "../main";
import { fixture, type Fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { install as installCanvas } from "../canvas/routes";
import { install as installSettings } from "../settings";
import { install as installRemote } from "../remote";
import { install } from "./install";

/**
 * The terminal routes, against a real database, a real router and real PTYs.
 *
 * A direct translation of the pre-merge implementation's
 * `the_terminal_backend_routes_speak_the_v15_shapes`, field by field: during
 * the changeover both implementations answer the same page, so a response
 * that differs by one key is a page that breaks on a setting.
 *
 * The backend is pinned to `direct` rather than left to the machine. Which
 * backend is in effect changes every one of these answers, and a suite whose
 * result depended on whether the developer has tmux would prove nothing. The
 * tmux paths have their own suite in `tmux/tmux.test.ts`.
 */

const unix = process.platform !== "win32";
const describeUnix = unix ? describe : describe.skip;

let open: Fixture | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  open?.close();
  open = undefined;
});

let stop: (() => Promise<void>) | undefined;

async function core(
  withRemote = false,
): Promise<{ fixture: Fixture; workspaceId: string }> {
  const stops: (() => Promise<void>)[] = [];
  open = fixture([
    installWorkspaces,
    installCanvas,
    ...(withRemote
      ? [
          installSettings,
          // Before the terminal domain, exactly as `DOMAINS` orders them: the
          // SSH decorator is built from this domain's askpass service and host
          // registry, and a terminal domain installed first would find none.
          (context: CoreContext) => {
            const remote = installRemote(context);
            stops.push(() => remote.stop());
          },
        ]
      : []),
    (context: CoreContext) => {
      const domain = install(context, { configured: "direct" });
      stops.push(() => domain.stop());
    },
  ]);
  stop = async () => {
    for (const one of stops.reverse()) await one();
  };
  const created = await open.call("POST", "/api/workspaces", {
    name: "Canvas",
    rootPath: open.directory,
  });
  const workspace = created.body as { id: string };
  return { fixture: open, workspaceId: workspace.id };
}

/** Polls rather than sleeps: how fast a shell prints depends on the machine. */
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  seconds = 10,
): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `condition never held; last value ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeUnix("the terminal routes", () => {
  it("reports which backend is in effect, and why", async () => {
    const { fixture: core_ } = await core();
    const { status, body } = await core_.call("GET", "/api/terminals/backend");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      effective: "direct",
      configured: "direct",
      platform: "unix",
      reason: "terminal.backend 设为 direct",
    });
    // Present as keys even when there is nothing to say: the settings page
    // reads them unconditionally.
    expect(body).toHaveProperty("tmuxVersion");
    expect(body).toHaveProperty("tmuxSocket");
  });

  it("creates, captures, pastes, recycles and terminates one session", async () => {
    const { fixture: core_, workspaceId } = await core();

    // `trap '' INT` is what makes the interrupt assertion below meaningful: a
    // plain `sh -c` dies on Ctrl+C like any other foreground process, so
    // asserting that it survives one would be asserting a race.
    const created = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      command: "/bin/sh",
      args: ["-c", "trap '' INT; printf hello-capture; sleep 30"],
    });
    expect(created.status).toBe(200);
    const session = created.body as Record<string, unknown>;
    // Contract §15.2 — the session payload carries its backend identity.
    expect(session.backend).toBe("direct");
    expect(session.generation).toBe(1);
    expect(session.attachState).toBe("detached");
    expect(session.sessionKey).toBe(session.id);
    const id = String(session.id);

    // `GET /api/terminals/{id}` answers the same row shape as the create.
    const read = await core_.call("GET", `/api/terminals/${id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id, backend: "direct", generation: 1 });

    const capture = await until(
      async () =>
        (
          await core_.call(
            "GET",
            `/api/terminals/${id}/capture?lines=40&escapes=false`,
          )
        ).body as { generation: number; lines: number; data: string },
      (body) => body.data.includes("hello-capture"),
    );
    expect(capture.generation).toBe(1);
    expect(typeof capture.lines).toBe("number");

    const pasted = await core_.call("POST", `/api/terminals/${id}/paste`, {
      text: "ls",
      enter: false,
    });
    expect(pasted.status).toBe(200);
    expect((pasted.body as { id: string }).id).toBe(id);

    // A generation bump, same row and same logical key.
    const recycled = await core_.call("POST", `/api/terminals/${id}/recycle`);
    expect(recycled.status).toBe(200);
    expect(recycled.body).toMatchObject({
      id,
      generation: 2,
      status: "running",
      sessionKey: session.sessionKey,
    });

    // An interrupt is a signal, not a kill: a process that ignores SIGINT
    // keeps running, and the session is never marked `terminated`.
    const interrupted = await core_.call(
      "POST",
      `/api/terminals/${id}/terminate`,
      { mode: "interrupt" },
    );
    expect(interrupted.status).toBe(200);
    expect(interrupted.body).toMatchObject({
      status: "running",
      generation: 2,
    });

    const ended = await core_.call("POST", `/api/terminals/${id}/terminate`, {
      mode: "session",
    });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({
      status: "terminated",
      attachState: "exited",
    });
  });

  it("accepts a terminate with no body at all, meaning `process`", async () => {
    const { fixture: core_, workspaceId } = await core();
    const created = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
    });
    const id = String((created.body as { id: string }).id);
    const ended = await core_.call("POST", `/api/terminals/${id}/terminate`);
    expect(ended.status).toBe(200);
    expect((ended.body as { status: string }).status).toBe("terminated");
  });

  /**
   * xterm owns the direct backend's scrollback, so the route is a no-op there
   * — but it must still answer 204 rather than 501, or the page would think
   * the wheel bridge is missing and stop sending.
   */
  it("answers the wheel bridge with no content", async () => {
    const { fixture: core_, workspaceId } = await core();
    const created = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
    });
    const id = String((created.body as { id: string }).id);
    expect(
      (await core_.call("POST", `/api/terminals/${id}/scroll`, { lines: 5 }))
        .status,
    ).toBe(204);
    expect(
      (
        await core_.call("POST", `/api/terminals/${id}/scroll`, {
          lines: 99_999,
        })
      ).status,
    ).toBe(400);
  });

  it("refuses a paste that is too large before writing anything", async () => {
    const { fixture: core_, workspaceId } = await core();
    const created = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
    });
    const id = String((created.body as { id: string }).id);
    const refused = await core_.call("POST", `/api/terminals/${id}/paste`, {
      text: "x".repeat(200_001),
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "bad_request" });
  });

  /**
   * The SSH decorator, through the route that reaches it.
   *
   * Only the host id travels; the command line comes from the stored host. The
   * assertion that matters is the one about the *unknown* id: a "remote"
   * terminal that quietly runs a local shell is the one outcome that must not
   * happen, and the decorator refuses rather than falling back.
   */
  it("runs `ssh` for a terminal that names a stored host", async () => {
    const { fixture: core_, workspaceId } = await core(true);
    await core_.call("PATCH", "/api/settings", {
      ssh: {
        hosts: [
          {
            id: "box",
            name: "box",
            host: "127.0.0.1",
            user: "nobody",
            port: 22,
          },
        ],
      },
    });

    const created = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      ssh: { hostId: "box" },
    });
    expect(created.status).toBe(200);
    const session = created.body as {
      id: string;
      backend: string;
      pid: number;
    };
    // The row still names the backend that is really behind the session: an
    // SSH terminal is a normal session whose command happens to be `ssh`.
    expect(session.backend).toBe("direct");

    // What is actually running under the pty is `ssh`, with the stored host's
    // destination on its command line — not the shell the request never named.
    const argv = execFileSync(
      "ps",
      ["-o", "args=", "-p", String(session.pid)],
      {
        encoding: "utf8",
      },
    );
    expect(argv).toContain("ssh");
    expect(argv).toContain("nobody@127.0.0.1");

    await core_.call("POST", `/api/terminals/${session.id}/terminate`, {
      mode: "session",
    });
  });

  it("refuses a terminal that names a host nobody stored", async () => {
    const { fixture: core_, workspaceId } = await core(true);
    const refused = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      ssh: { hostId: "not-configured" },
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toContain("SSH host");
    // And nothing was started: a refused create leaves no row behind.
    expect(
      core_.database
        .prepare("SELECT count(*) AS total FROM terminal_sessions")
        .get(),
    ).toMatchObject({ total: 0 });
  });

  it("answers 404 for a session nobody created", async () => {
    const { fixture: core_ } = await core();
    for (const path of ["/api/terminals/nope", "/api/terminals/nope/capture"]) {
      expect((await core_.call("GET", path)).status).toBe(404);
    }
    expect(
      (await core_.call("POST", "/api/terminals/nope/terminate")).status,
    ).toBe(404);
  });

  it("refuses an agent terminal that names no node", async () => {
    const { fixture: core_, workspaceId } = await core();
    const refused = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      agent: { id: "claude" },
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toContain("nodeId");
  });

  it("refuses a node id that is not a uuid", async () => {
    const { fixture: core_, workspaceId } = await core();
    const refused = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      nodeId: "not-a-uuid",
    });
    expect(refused.status).toBe(400);
  });

  /**
   * The Sessions panel's feed. Only node-owned sessions appear — the list is a
   * list of cards on a board, and a terminal with no node has no card — and
   * `alive` is the one field that does not come from the database.
   */
  it("lists the node-owned sessions of one workspace", async () => {
    const { fixture: core_, workspaceId } = await core();
    const boards = await core_.call(
      "GET",
      `/api/workspaces/${workspaceId}/boards`,
    );
    const board = (boards.body as { id: string }[])[0];
    const nodeId = "11111111-2222-4333-8444-555555555555";
    // The node row is written directly rather than through the board document:
    // this suite is about the session feed, and routing it through the canvas
    // contract would make a change there break a terminal test.
    core_.database
      .prepare(
        `INSERT INTO nodes (id, board_id, type, x, y, width, height, title, data_json,
             created_at, updated_at)
           VALUES (?, ?, 'terminal', 0, 0, 400, 300, 'Build', '{"kind":"terminal"}',
             '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')`,
      )
      .run(nodeId, board?.id ?? "");

    // One with a node, one without.
    const owned = await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      nodeId,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
    });
    expect(owned.status).toBe(200);
    await core_.call("POST", "/api/terminals", {
      workspaceId,
      cwd: core_.directory,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
    });

    const listed = await core_.call(
      "GET",
      `/api/workspaces/${workspaceId}/sessions`,
    );
    expect(listed.status).toBe(200);
    const sessions = listed.body as Record<string, unknown>[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      nodeId,
      boardId: board?.id,
      kind: "terminal",
      title: "Build",
      unread: false,
      alive: true,
    });

    // Once it is over, the row is still listed and `alive` is the difference.
    const id = String((owned.body as { id: string }).id);
    await core_.call("POST", `/api/terminals/${id}/terminate`, {
      mode: "session",
    });
    const after = await core_.call(
      "GET",
      `/api/workspaces/${workspaceId}/sessions`,
    );
    expect((after.body as { alive: boolean }[])[0]?.alive).toBe(false);
  });
});
