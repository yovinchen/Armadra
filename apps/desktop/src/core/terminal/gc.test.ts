import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  type Attachment,
  type BackendCapabilities,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  type SessionKey,
  type TerminalBackend,
  type TerminalHandle,
} from "./backend";
import {
  type GcRow,
  MAX_DESTROYS_PER_SWEEP,
  attachableRows,
  failNonPersistentRows,
  gcCandidates,
  reconcile,
} from "./gc";
import { fixture, type Fixture } from "../workspaces/fixture";

/**
 * The reclaim policy and the start-up reconciliation.
 *
 * The first half is the direct port of the pre-merge implementation's three unit tests; the second
 * runs against a real database, because the `live-work` gate and the orphan
 * sweep are both expressed as SQL and a fake would test the fake.
 */

const MINUTE = 60_000;
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function row(
  id: string,
  minutesIdle: number,
  state: string,
  node: boolean,
  workspace: boolean,
): GcRow {
  return {
    sessionId: id,
    sessionKey: id,
    backendRef: `armadra-ws-${id}-1`,
    attachState: state,
    lastActivity: NOW - minutesIdle * MINUTE,
    nodePresent: node,
    workspaceOpen: workspace,
  };
}

describe("which detached sessions may be reclaimed", () => {
  it("only reclaims the ones nothing can reach any more", () => {
    const rows = [
      // Idle for two days, node deleted: reclaim.
      row("gone-node", 2880, "detached", false, true),
      // Idle for two days, workspace deleted: reclaim.
      row("gone-workspace", 2900, "detached", true, false),
      // Idle for two days but the node is still on a board: keep.
      row("still-on-board", 2880, "detached", true, true),
      // Node deleted but only ten minutes idle: keep.
      row("recent", 10, "detached", false, true),
      // Somebody is watching it right now: keep, whatever its age.
      row("live", 9000, "live", false, false),
      // Already gone.
      row("exited", 9000, "exited", false, false),
    ];
    expect(gcCandidates(rows, NOW, 1440)).toEqual([
      "gone-workspace",
      "gone-node",
    ]);
  });

  it("never destroys more than the cap in one round", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(`s${index}`, 5000 - index, "detached", false, true),
    );
    expect(gcCandidates(rows, NOW, 1440)).toHaveLength(MAX_DESTROYS_PER_SWEEP);
  });

  it("keeps a reachable session even with the grace period at zero", () => {
    const rows = [
      row("reachable", 600, "detached", true, true),
      row("unreachable", 600, "detached", false, true),
    ];
    expect(gcCandidates(rows, NOW, 0)).toEqual(["unreachable"]);
  });
});

/* ------------------------------ against a database ------------------------- */

let open: Fixture | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

/** A database with one workspace, because `terminal_sessions` insists on one. */
function database(): DatabaseSync {
  open = fixture([]);
  const db = open.database;
  db.prepare(
    `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
       VALUES ('ws', 'Canvas', ?, '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')`,
  ).run(`${open.directory}/ws`);
  return db;
}

function insert(
  db: DatabaseSync,
  values: {
    id: string;
    backend: string;
    status?: string;
    attach?: string;
    workspaceId?: string;
    reference?: string | null;
    generation?: number;
    /** Defaults to the id; set it to give two rows the same pane. */
    key?: string;
    createdAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, status,
        created_at, session_key, backend_kind, backend_ref, generation, attach_state,
        termination_intent)
      VALUES (?, ?, '/tmp', '/bin/sh', 'terminal', ?, ?, ?, ?, ?, ?, ?, 'none')`,
  ).run(
    values.id,
    values.workspaceId ?? "ws",
    values.status ?? "running",
    values.createdAt ?? "2026-09-19T00:00:00.000Z",
    values.key ?? values.id,
    values.backend,
    values.reference ?? null,
    values.generation ?? 1,
    values.attach ?? "detached",
  );
}

describe("start-up recovery", () => {
  /**
   * The note R0 left in `db/open.ts`: a direct PTY died with the process that
   * wrote its row, and nothing will bring it back.
   */
  it("fails the rows of a backend whose sessions cannot have survived", () => {
    const db = database();
    insert(db, { id: "direct-one", backend: "direct" });
    insert(db, { id: "tmux-one", backend: "tmux" });
    insert(db, { id: "host-one", backend: "sessionHost" });

    expect(failNonPersistentRows(db, "2026-09-20T12:00:00.000Z")).toBe(1);

    const statuses = db
      .prepare(
        "SELECT id, status, attach_state FROM terminal_sessions ORDER BY id",
      )
      .all() as { id: string; status: string; attach_state: string }[];
    expect(statuses).toEqual([
      { id: "direct-one", status: "failed", attach_state: "exited" },
      { id: "host-one", status: "running", attach_state: "detached" },
      { id: "tmux-one", status: "running", attach_state: "detached" },
    ]);
  });

  /**
   * The `live-work` gate. A direct session is a process this core owns and
   * somebody may be typing into; a sweep must never be able to see it.
   */
  it("never offers a direct session to the sweep, however unreachable it looks", () => {
    const db = database();
    insert(db, { id: "direct-one", backend: "direct" });
    insert(db, { id: "tmux-one", backend: "tmux" });
    const rows = attachableRows(db);
    expect(rows.map((entry) => entry.sessionId)).toEqual(["tmux-one"]);
    // And the policy would have taken it: same age, same missing node.
    expect(
      gcCandidates(
        [...rows, { ...(rows[0] as GcRow), sessionId: "direct-one" }],
        Date.parse("2026-09-30T00:00:00.000Z"),
        1440,
      ),
    ).toEqual(["tmux-one", "direct-one"]);
  });

  it("reads a row that never produced output by its creation time", () => {
    const db = database();
    insert(db, { id: "quiet", backend: "tmux" });
    const [entry] = attachableRows(db);
    expect(entry?.lastActivity).toBe(Date.parse("2026-09-19T00:00:00.000Z"));
  });
});

/* -------------------------------- reconciling ------------------------------ */

/** A backend that holds exactly the references it is told to. */
class FakeBackend implements TerminalBackend {
  readonly kind = "tmux" as const;
  readonly destroyed: string[] = [];

  constructor(private readonly alive: string[]) {}

  async list(): Promise<BackendRef[]> {
    return this.alive.map((name) => ({ name, attached: false }));
  }

  async destroyByReference(reference: string): Promise<void> {
    this.destroyed.push(reference);
  }

  async adopt(): Promise<number | undefined> {
    return 4242;
  }

  /* Everything below is unreachable from `reconcile`. */
  async create(): Promise<TerminalHandle> {
    throw new Error("not used");
  }
  async attach(): Promise<Attachment> {
    throw new Error("not used");
  }
  async detach(): Promise<void> {}
  async input(): Promise<void> {}
  async paste(): Promise<void> {}
  async resize(): Promise<void> {}
  async capture(): Promise<string> {
    return "";
  }
  async signal(): Promise<void> {}
  async terminate(): Promise<void> {}
  async getForeground(): Promise<ForegroundInfo> {
    return { children: [] };
  }
  getCapabilities(): BackendCapabilities {
    return {
      kind: "tmux",
      persistent: true,
      redrawsOnAttach: true,
      usable: true,
    };
  }
  async scroll(): Promise<void> {}
  async setDormant(): Promise<void> {}
  notices(_listener: (notice: BackendNotice) => void): void {}
  async detachAll(): Promise<void> {}
}

describe("start-up reconciliation", () => {
  it("re-adopts what is still there and buries what is not", async () => {
    const db = database();
    insert(db, {
      id: "alive",
      backend: "tmux",
      reference: "armadra-ws-alive-1",
      attach: "live",
      generation: 3,
    });
    insert(db, {
      id: "dead",
      backend: "tmux",
      reference: "armadra-ws-dead-1",
      attach: "live",
    });
    const backend = new FakeBackend([
      "armadra-ws-alive-1",
      "armadra-ws-orphan-9",
    ]);

    const { report, adopted } = await reconcile(
      db,
      backend,
      "tmux",
      "2026-09-20T12:00:00.000Z",
    );

    expect(report).toEqual({ detached: 1, exited: 1, orphansDestroyed: 1 });
    // The generation travels with the adoption: a client that reconnects to a
    // recycled session must be told the number it is actually attaching to.
    expect(adopted).toEqual([
      {
        key: "alive" as SessionKey,
        reference: "armadra-ws-alive-1",
        generation: 3,
      },
    ]);
    // An `armadra-*` session no row points at is the one thing nothing else
    // would ever clean up: only its own name can address it.
    expect(backend.destroyed).toEqual(["armadra-ws-orphan-9"]);

    const rows = db
      .prepare(
        "SELECT id, status, attach_state, ended_at FROM terminal_sessions ORDER BY id",
      )
      .all() as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        id: "alive",
        status: "running",
        attach_state: "detached",
        ended_at: null,
      },
      {
        id: "dead",
        status: "exited",
        attach_state: "exited",
        ended_at: "2026-09-20T12:00:00.000Z",
      },
    ]);
  });

  /**
   * One pane, one row.
   *
   * A node whose pane was unreachable opens a second session under the same
   * key; when the tmux server comes back, both rows name that one pane. Both
   * used to be revived, so the node had two live sessions and which one a
   * lookup landed on was chance — the adoption would rebuild the record under
   * one id while `alive` and `context terminal` asked about the other.
   */
  it("adopts one row per pane and buries the rest", async () => {
    const db = database();
    insert(db, {
      id: "stale",
      backend: "tmux",
      reference: "armadra-ws-node-1",
      key: "node",
      status: "exited",
      attach: "detached",
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    insert(db, {
      id: "current",
      backend: "tmux",
      reference: "armadra-ws-node-1",
      key: "node",
      createdAt: "2026-09-19T01:00:00.000Z",
    });

    const { report, adopted } = await reconcile(
      db,
      new FakeBackend(["armadra-ws-node-1"]),
      "tmux",
      "2026-09-20T12:00:00.000Z",
    );

    expect(report).toMatchObject({ detached: 1, exited: 1 });
    expect(adopted).toEqual([
      {
        key: "node" as SessionKey,
        reference: "armadra-ws-node-1",
        generation: 1,
      },
    ]);
    const rows = Object.fromEntries(
      (
        db.prepare("SELECT id, status FROM terminal_sessions").all() as Record<
          string,
          unknown
        >[]
      ).map((row) => [row.id, row.status]),
    );
    expect(rows).toEqual({ current: "running", stale: "exited" });
  });

  /**
   * A row of another backend is not this backend's to settle. Reconciling
   * every kind against one `list` would bury every session-host row on a
   * machine whose tmux happens to answer first.
   */
  it("touches only the rows of the backend it was given", async () => {
    const db = database();
    insert(db, { id: "host", backend: "sessionHost", reference: "host#1" });
    await reconcile(db, new FakeBackend([]), "tmux", "2026-09-20T12:00:00Z");
    const status = db
      .prepare("SELECT status FROM terminal_sessions WHERE id = 'host'")
      .get() as { status: string };
    expect(status.status).toBe("running");
  });
});
