import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendKind, TerminalBackend } from "./backend";
import { TerminalManager } from "./manager";
import { TmuxBackend } from "./tmux/backend";
import { detect } from "./tmux/config";
import { fixture, type Fixture } from "../workspaces/fixture";

/**
 * The promise tmux is the primary backend for: **a session outlives the core**.
 *
 * Everything below runs against a real tmux server on a private socket under a
 * temporary directory, and every assertion is about what survives a manager
 * that goes away and comes back — which is the one behaviour no unit test can
 * stand in for, because the whole point is that the process boundary is real.
 *
 * Skipped when the machine has no usable tmux. That is not a gap: the same
 * machine cannot run the feature either, and `select.ts` is what decides it
 * falls back to `direct`.
 */

const tmuxAvailable = detect().usable && process.platform !== "win32";
const describeTmux = tmuxAvailable ? describe : describe.skip;

let open: Fixture | undefined;
let socket: string | undefined;

afterEach(async () => {
  if (socket !== undefined) {
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // `exit-empty on` usually got there first.
    }
  }
  socket = undefined;
  open?.close();
  open = undefined;
});

interface Core {
  readonly manager: TerminalManager;
  readonly backend: TmuxBackend;
  readonly database: DatabaseSync;
  readonly directory: string;
}

/** A manager over a real tmux backend, sharing one database and one socket. */
function core(existing?: Fixture): Core {
  const shared = existing ?? fixture([]);
  open = shared;
  if (existing === undefined) {
    shared.database
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
           VALUES ('ws', 'Canvas', ?, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')`,
      )
      .run(join(shared.directory, "ws"));
  }
  const backend = new TmuxBackend({
    dataDir: shared.directory,
    version: "test",
  });
  socket = backend.socket;
  const backends = new Map<BackendKind, TerminalBackend>([["tmux", backend]]);
  const manager = new TerminalManager({
    database: shared.database,
    backends,
    effective: "tmux",
  });
  return {
    manager,
    backend,
    database: shared.database,
    directory: shared.directory,
  };
}

async function until(
  ready: () => boolean | Promise<boolean>,
  what: string,
  seconds = 15,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > deadline) throw new Error(`never became true: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeTmux("a tmux session outliving the core", () => {
  /**
   * The acceptance criterion, end to end: kill the manager, start another one
   * on the same database and the same socket, and the pane is adopted rather
   * than recreated — same generation, same backend reference, and the row back
   * to `detached` instead of `exited`.
   */
  it("is adopted by the next core rather than recreated", async () => {
    const first = core();
    const session = await first.manager.spawn({
      workspaceId: "ws",
      cwd: first.directory,
      command: "/bin/sh",
      args: ["-c", "printf survivor-marker; sleep 120"],
      ownerNodeId: "11111111-2222-4333-8444-555555555555",
    });
    const reference = (
      first.database
        .prepare("SELECT backend_ref FROM terminal_sessions WHERE id = ?")
        .get(session.id) as { backend_ref: string }
    ).backend_ref;

    // Attach once, then shut the first core down the way `main` does.
    const attached = await first.manager.attach(session.id, {
      cols: 80,
      rows: 24,
    });
    await first.manager.detached(session.id, attached.attachment.attachmentId);
    await first.manager.shutdown();

    // The tmux server still has it: that is the whole promise.
    expect((await first.backend.list()).map((entry) => entry.name)).toContain(
      reference,
    );

    // A second core over the same database and the same socket.
    const second = core(open);
    const report = await second.manager.reconcile();
    expect(report).toMatchObject({ detached: 1, exited: 0 });

    const row = second.database
      .prepare(
        "SELECT status, attach_state, generation, backend_ref FROM terminal_sessions WHERE id = ?",
      )
      .get(session.id) as Record<string, unknown>;
    expect(row).toEqual({
      status: "running",
      attach_state: "detached",
      generation: 1,
      backend_ref: reference,
    });

    // Adopted, not recreated: the pane still has what the first core's command
    // printed, which a fresh `new-session` could not possibly show. Polled,
    // because how soon a shell gets to its first `printf` is the machine's
    // business and not this assertion's.
    await until(
      async () =>
        (await second.manager.capture(session.id, 200, false)).data.includes(
          "survivor-marker",
        ),
      "the pane the first core wrote into",
    );

    // And it is attachable again, at the generation it always had.
    const again = await second.manager.attach(session.id, {
      cols: 80,
      rows: 24,
    });
    expect(again.attachment.generation).toBe(1);
    await second.manager.detached(session.id, again.attachment.attachmentId);
    await second.manager.terminate(session.id, "session");
  }, 60_000);

  /**
   * A paste whose text is empty, against a real tmux server.
   *
   * `load-buffer` of an empty file creates no buffer, so the `paste-buffer -b`
   * behind it failed with "no buffer" and the route answered 500 — for a
   * request whose only real instruction was "press Enter". An empty clipboard
   * and a bare confirmation both produce exactly this call, and the direct
   * backend has always accepted it.
   */
  it("presses Enter for an empty paste instead of failing", async () => {
    const one = core();
    const session = await one.manager.spawn({
      workspaceId: "ws",
      cwd: one.directory,
      command: "/bin/sh",
      args: ["-c", "read line; printf 'read-[%s]\\n' \"$line\"; sleep 120"],
    });

    await one.manager.paste(session.id, "typed-first", false);
    // No text, Enter only: this is what submits the line above.
    await expect(
      one.manager.paste(session.id, "", true),
    ).resolves.toBeUndefined();
    await until(
      async () =>
        (await one.manager.capture(session.id, 200, false)).data.includes(
          "read-[typed-first]",
        ),
      "the shell to see the line the empty paste submitted",
    );
    await one.manager.terminate(session.id, "session");
  }, 60_000);

  /**
   * The other half of §15.2: a row whose tmux session is gone is settled, and
   * an `armadra-*` session no row points at is destroyed. Nothing else would
   * ever reclaim the second one — only its own name can address it.
   */
  it("buries a row whose pane is gone and destroys an orphan pane", async () => {
    const first = core();
    const session = await first.manager.spawn({
      workspaceId: "ws",
      cwd: first.directory,
      command: "/bin/sh",
      args: ["-c", "sleep 120"],
    });
    const orphan = await first.manager.spawn({
      workspaceId: "ws",
      cwd: first.directory,
      command: "/bin/sh",
      args: ["-c", "sleep 120"],
    });
    const orphanReference = (
      first.database
        .prepare("SELECT backend_ref FROM terminal_sessions WHERE id = ?")
        .get(orphan.id) as { backend_ref: string }
    ).backend_ref;

    // One pane killed behind the core's back; one row deleted behind it.
    await first.backend.destroyByReference(
      (
        first.database
          .prepare("SELECT backend_ref FROM terminal_sessions WHERE id = ?")
          .get(session.id) as { backend_ref: string }
      ).backend_ref,
    );
    first.database
      .prepare("DELETE FROM terminal_sessions WHERE id = ?")
      .run(orphan.id);
    await first.manager.shutdown();

    const second = core(open);
    const report = await second.manager.reconcile();
    expect(report).toMatchObject({ exited: 1, orphansDestroyed: 1 });

    const row = second.database
      .prepare(
        "SELECT status, attach_state FROM terminal_sessions WHERE id = ?",
      )
      .get(session.id) as { status: string; attach_state: string };
    expect(row).toEqual({ status: "exited", attach_state: "exited" });
    expect(
      (await second.backend.list()).map((entry) => entry.name),
    ).not.toContain(orphanReference);
  }, 60_000);

  /**
   * `#{window_activity}` is the idle judgement, and the reason is exactly this:
   * tmux bumps `session_activity` to `now` on every client **attach**, so a
   * long-attached silent session would look "just active" every time anything
   * reattached to it — and would never be reclaimed.
   */
  it("does not let an attach alone reset the idle clock", async () => {
    const first = core();
    const session = await first.manager.spawn({
      workspaceId: "ws",
      cwd: first.directory,
      command: "/bin/sh",
      args: ["-c", "printf quiet; sleep 120"],
    });
    const activity = async (): Promise<number> => {
      const output = execFileSync(
        "tmux",
        [
          "-S",
          first.backend.socket,
          "list-sessions",
          "-F",
          "#{session_name} #{session_activity} #{window_activity}",
        ],
        { encoding: "utf8" },
      );
      const line = output
        .split("\n")
        .find((entry) => entry.startsWith("armadra-"));
      return Number.parseInt(line?.split(/\s+/)[2] ?? "", 10);
    };

    await until(
      async () => Number.isInteger(await activity()),
      "an activity stamp",
    );
    const before = await activity();
    // Far enough that a second-resolution clock would visibly move.
    await new Promise((resolve) => setTimeout(resolve, 2_100));

    const attached = await first.manager.attach(session.id, {
      cols: 80,
      rows: 24,
    });
    await first.manager.detached(session.id, attached.attachment.attachmentId);
    expect(await activity()).toBe(before);

    await first.manager.terminate(session.id, "session");
  }, 60_000);

  /**
   * A direct session is the opposite promise, and the difference has to be
   * visible: the same sequence leaves nothing behind, and leaves no error
   * either.
   */
  it("is the difference from a direct session, which simply goes", async () => {
    const shared = fixture([]);
    open = shared;
    shared.database
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
           VALUES ('ws', 'Canvas', ?, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')`,
      )
      .run(join(shared.directory, "ws"));
    const { DirectBackend } = await import("./direct");
    const direct = new DirectBackend();
    const manager = new TerminalManager({
      database: shared.database,
      backends: new Map<BackendKind, TerminalBackend>([["direct", direct]]),
      effective: "direct",
    });
    const session = await manager.spawn({
      workspaceId: "ws",
      cwd: shared.directory,
      command: "/bin/sh",
      args: ["-c", "sleep 120"],
    });
    await manager.shutdown();
    // Gone, with no error and nothing left to adopt. A clean shutdown even
    // observes the exit, so the row carries `exited` rather than a guess.
    expect(await direct.list()).toEqual([]);
    await until(
      () =>
        (
          shared.database
            .prepare("SELECT status FROM terminal_sessions WHERE id = ?")
            .get(session.id) as { status: string }
        ).status !== "running",
      "the row to stop claiming to be running",
    );

    // A core that *crashed* leaves the row claiming to be running, and the
    // next one settles it as `failed`: nobody observed an exit, so inventing
    // an exit code would be a lie.
    shared.database
      .prepare(
        "UPDATE terminal_sessions SET status = 'running', attach_state = 'live' WHERE id = ?",
      )
      .run(session.id);
    const next = new TerminalManager({
      database: shared.database,
      backends: new Map<BackendKind, TerminalBackend>([
        ["direct", new DirectBackend()],
      ]),
      effective: "direct",
    });
    await next.start();
    const row = shared.database
      .prepare(
        "SELECT status, attach_state FROM terminal_sessions WHERE id = ?",
      )
      .get(session.id) as { status: string; attach_state: string };
    expect(row).toEqual({ status: "failed", attach_state: "exited" });
    await next.shutdown();
  }, 60_000);
});
