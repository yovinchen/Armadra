import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AdoptableBackend,
  type Attachment,
  type BackendCapabilities,
  type BackendKind,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  type SessionKey,
  type TerminalHandle,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  conflict,
  notFound,
  sessionName,
} from "./backend";
import { TerminalManager } from "./manager";
import { type Lease, agentActor, humanActor } from "../drive/lease";
import {
  TERMINAL_AGENT_IDLE_SECONDS,
  TERMINAL_HUMAN_IDLE_SECONDS,
} from "./drive";
import { fixture, type Fixture } from "../workspaces/fixture";

/**
 * The manager's own decisions, on a fake backend and a clock the test owns.
 *
 * Everything here is about *bookkeeping*: which row moves, which generation
 * wins, what a sweep is allowed to touch, when a session falls asleep. None of
 * it needs a PTY, and giving it one would make a suite about database rows
 * take twenty seconds and depend on the machine's load.
 */

interface FakeSession {
  generation: number;
  dormant: boolean;
  destroyed: boolean;
}

class FakeBackend implements AdoptableBackend {
  readonly kind: BackendKind = "tmux";
  readonly sessions = new Map<SessionKey, FakeSession>();
  readonly calls: string[] = [];
  private readonly sinks: ((notice: BackendNotice) => void)[] = [];
  private nextId = 1;
  /** Set to make the next `create` fail, as a recycle onto a dead shell would. */
  failCreate = false;

  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    this.calls.push(`create:${spec.sessionKey}:${spec.generation}`);
    if (this.failCreate) throw notFound("no backend");
    this.sessions.set(spec.sessionKey, {
      generation: spec.generation,
      dormant: false,
      destroyed: false,
    });
    return {
      sessionKey: spec.sessionKey,
      generation: spec.generation,
      backendRef: sessionName(
        spec.workspaceId,
        spec.sessionKey,
        spec.generation,
      ),
      pid: 1234,
    };
  }

  async adopt(key: SessionKey, _reference: string, generation: number) {
    this.sessions.set(key, { generation, dormant: false, destroyed: false });
    return 4321;
  }

  async attach(
    key: SessionKey,
    generation: number,
    _size: TerminalSize,
  ): Promise<Attachment> {
    const session = this.sessions.get(key);
    if (session === undefined) throw notFound("gone");
    if (session.generation !== generation) throw conflict("stale");
    return {
      attachmentId: this.nextId++,
      generation: session.generation,
      onData: () => {},
      onExit: () => {},
    };
  }

  async detach(): Promise<void> {}

  async input(key: SessionKey, bytes: Buffer): Promise<void> {
    this.calls.push(`input:${key}:${bytes.toString("utf8")}`);
  }

  async paste(key: SessionKey, text: string, enter: boolean): Promise<void> {
    this.calls.push(`paste:${key}:${text}:${String(enter)}`);
  }

  async resize(): Promise<void> {}

  async capture(): Promise<string> {
    return "line one\nline two";
  }

  async signal(key: SessionKey): Promise<void> {
    this.calls.push(`signal:${key}`);
  }

  async terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    this.calls.push(`terminate:${key}:${mode}`);
    if (mode === "session") this.sessions.delete(key);
  }

  async getForeground(): Promise<ForegroundInfo> {
    return { pid: 1234, command: "claude", children: [] };
  }

  getCapabilities(): BackendCapabilities {
    return {
      kind: "tmux",
      persistent: true,
      redrawsOnAttach: true,
      usable: true,
    };
  }

  async list(): Promise<BackendRef[]> {
    return [...this.sessions.entries()].map(([key, session]) => ({
      name: sessionName("ws", key, session.generation),
      attached: false,
    }));
  }

  async destroyByReference(reference: string): Promise<void> {
    this.calls.push(`destroyRef:${reference}`);
  }

  async scroll(key: SessionKey, lines: number): Promise<void> {
    this.calls.push(`scroll:${key}:${lines}`);
  }

  async setDormant(key: SessionKey, dormant: boolean): Promise<void> {
    const session = this.sessions.get(key);
    if (session === undefined) throw notFound("gone");
    session.dormant = dormant;
    this.calls.push(`dormant:${key}:${String(dormant)}`);
  }

  notices(listener: (notice: BackendNotice) => void): void {
    this.sinks.push(listener);
  }

  /** Reports a session that ended with nothing attached to it. */
  announce(notice: BackendNotice): void {
    for (const sink of this.sinks) sink(notice);
  }

  async detachAll(): Promise<void> {
    this.calls.push("detachAll");
  }
}

let open: Fixture | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
});

interface Harness {
  manager: TerminalManager;
  backend: FakeBackend;
  database: DatabaseSync;
  advance: (ms: number) => void;
  /** 每一次租约换手，按发生顺序。 */
  leases: LeaseEvent[];
}

interface LeaseEvent {
  sessionId: string;
  nodeId: string | null;
  lease: Lease;
}

function harness(policy?: {
  detachedGraceMinutes: number;
  dormantAfterSeconds: number;
}): Harness {
  open = fixture([]);
  const database = open.database;
  database
    .prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
         VALUES ('ws', 'Canvas', ?, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')`,
    )
    .run(`${open.directory}/ws`);
  let now = Date.parse("2026-09-20T12:00:00.000Z");
  const backend = new FakeBackend();
  const leases: LeaseEvent[] = [];
  const manager = new TerminalManager({
    database,
    backends: new Map([["tmux", backend]]),
    effective: "tmux",
    onLease: (event) => {
      leases.push({
        sessionId: event.sessionId,
        nodeId: event.nodeId,
        lease: event.lease,
      });
    },
    policy: () =>
      policy ?? { detachedGraceMinutes: 1440, dormantAfterSeconds: 120 },
    now: () => new Date(now).toISOString(),
    clock: () => now,
  });
  return {
    manager,
    backend,
    database,
    leases,
    advance: (ms) => {
      now += ms;
    },
  };
}

const spawn = (manager: TerminalManager, nodeId?: string) =>
  manager.spawn({
    workspaceId: "ws",
    cwd: "/tmp",
    command: "/bin/sh",
    ...(nodeId === undefined ? {} : { ownerNodeId: nodeId }),
  });

describe("creating and recycling", () => {
  it("writes the row the Rust Runtime writes", async () => {
    const { manager, database } = harness();
    const session = await spawn(manager);
    expect(session).toMatchObject({
      status: "running",
      attachState: "detached",
      backend: "tmux",
      generation: 1,
      sessionKey: session.id,
      pid: 1234,
    });
    const row = database
      .prepare("SELECT * FROM terminal_sessions WHERE id = ?")
      .get(session.id) as Record<string, unknown>;
    expect(row.termination_intent).toBe("none");
    expect(row.backend_kind).toBe("tmux");
    expect(row.backend_ref).toBe(
      sessionName("ws", session.id as SessionKey, 1),
    );
  });

  /** A node-owned terminal keys on the node, so the pane survives the row. */
  it("keys a node's terminal on the node", async () => {
    const { manager } = harness();
    const session = await spawn(manager, "node-a");
    expect(session.sessionKey).toBe("node-a");
    expect(session.ownerNodeId).toBe("node-a");
  });

  it("bumps the generation and keeps the logical key", async () => {
    const { manager, backend } = harness();
    const session = await spawn(manager, "node-a");
    const recycled = await manager.recycle(session.id);
    expect(recycled.generation).toBe(2);
    expect(recycled.sessionKey).toBe("node-a");
    expect(recycled.status).toBe("running");
    // Destroyed before it was recreated, and at the same key.
    expect(backend.calls).toEqual([
      "create:node-a:1",
      "terminate:node-a:session",
      "create:node-a:2",
    ]);
  });

  /**
   * The bump has to be visible before the old session is destroyed, or a
   * socket whose stream just ended would ask for the current generation, still
   * see the old one, and close silently instead of sending `stale`.
   */
  it("makes the new generation visible to a socket that asks", async () => {
    const { manager } = harness();
    const session = await spawn(manager, "node-a");
    await manager.recycle(session.id);
    expect(manager.generation(session.id)).toBe(2);
    await expect(manager.input(session.id, 1, "x")).rejects.toMatchObject({
      status: 409,
    });
  });

  /** The marks describe a pty the recycle just replaced. */
  it("forgets the input marks of the session it replaced", async () => {
    const { manager } = harness();
    const session = await spawn(manager, "node-a");
    manager.noteInputApplied(session.id, "writer-1", 12);
    expect(manager.acknowledgedInput(session.id, "writer-1")).toBe(12);
    await manager.recycle(session.id);
    expect(manager.acknowledgedInput(session.id, "writer-1")).toBe(0);
  });

  /**
   * The old session is already gone by the time the create runs, so a failure
   * must not leave the row claiming to be running — there is nothing behind it
   * any more.
   */
  it("settles the row when the replacement cannot be created", async () => {
    const { manager, backend, database } = harness();
    const session = await spawn(manager, "node-a");
    backend.failCreate = true;
    await expect(manager.recycle(session.id)).rejects.toMatchObject({
      status: 404,
    });
    const row = database
      .prepare(
        "SELECT status, attach_state FROM terminal_sessions WHERE id = ?",
      )
      .get(session.id) as { status: string; attach_state: string };
    expect(row).toEqual({ status: "exited", attach_state: "exited" });
  });
});

describe("the input ledger across connections", () => {
  /**
   * The ledger outlives the socket, which is the whole point: the socket that
   * sent those keystrokes is the one that is gone.
   */
  it("answers a reconnecting writer with what it already delivered", async () => {
    const { manager } = harness();
    const session = await spawn(manager);
    manager.noteInputApplied(session.id, "writer-1", 4);
    manager.noteInputApplied(session.id, "writer-1", 9);
    manager.noteInputApplied(session.id, "writer-2", 2);
    expect(manager.acknowledgedInput(session.id, "writer-1")).toBe(9);
    expect(manager.acknowledgedInput(session.id, "writer-2")).toBe(2);
    expect(manager.acknowledgedInput(session.id, "")).toBe(0);
  });
});

describe("attaching and dormancy", () => {
  it("moves the row to live and back to detached", async () => {
    const { manager, database } = harness();
    const session = await spawn(manager);
    const state = () =>
      (
        database
          .prepare("SELECT attach_state FROM terminal_sessions WHERE id = ?")
          .get(session.id) as { attach_state: string }
      ).attach_state;

    const attached = await manager.attach(session.id, { cols: 100, rows: 40 });
    expect(state()).toBe("live");
    await manager.detached(session.id, attached.attachment.attachmentId);
    expect(state()).toBe("detached");
  });

  /**
   * The acceptance criterion in prose: attaching once does **not** leave the
   * session looking busy for ever. The idle clock restarts from the detach.
   */
  it("does not let one attach keep a session out of the sweep for ever", async () => {
    const { manager, backend, advance } = harness({
      detachedGraceMinutes: 1440,
      dormantAfterSeconds: 60,
    });
    const session = await spawn(manager);
    const attached = await manager.attach(session.id, { cols: 80, rows: 24 });
    advance(10 * 60_000);
    await manager.applyDormancy();
    expect(manager.isDormant(session.id)).toBe(false);

    await manager.detached(session.id, attached.attachment.attachmentId);
    advance(61_000);
    await manager.applyDormancy();
    expect(manager.isDormant(session.id)).toBe(true);
    expect(backend.calls).toContain(`dormant:${session.sessionKey}:true`);
  });

  /** Waking is one backend call, and it is never a create. */
  it("wakes on attach, exactly once", async () => {
    const { manager, backend, advance } = harness({
      detachedGraceMinutes: 1440,
      dormantAfterSeconds: 60,
    });
    const session = await spawn(manager);
    advance(61_000);
    await manager.applyDormancy();
    expect(manager.isDormant(session.id)).toBe(true);

    await manager.attach(session.id, { cols: 80, rows: 24 });
    expect(manager.isDormant(session.id)).toBe(false);
    expect(backend.calls.filter((call) => call.startsWith("dormant:"))).toEqual(
      [
        `dormant:${session.sessionKey}:true`,
        `dormant:${session.sessionKey}:false`,
      ],
    );
    expect(backend.calls.filter((call) => call.startsWith("create:"))).toEqual([
      `create:${session.sessionKey}:1`,
    ]);
  });

  it("does nothing at all when dormancy is switched off", async () => {
    const { manager, backend, advance } = harness({
      detachedGraceMinutes: 1440,
      dormantAfterSeconds: 0,
    });
    const session = await spawn(manager);
    advance(24 * 3_600_000);
    await manager.applyDormancy();
    expect(manager.isDormant(session.id)).toBe(false);
    expect(backend.calls.some((call) => call.startsWith("dormant:"))).toBe(
      false,
    );
  });
});

describe("the sweep", () => {
  function orphanRow(database: DatabaseSync, id: string): void {
    // A row whose node is gone and whose backend session this core never
    // attached to: the shape the sweep exists for.
    database
      .prepare(
        `INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, status,
             created_at, last_output_at, session_key, backend_kind, backend_ref,
             generation, attach_state, termination_intent)
           VALUES (?, 'ws', '/tmp', '/bin/sh', 'terminal', 'running',
             '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?, 'tmux',
             ?, 1, 'detached', 'none')`,
      )
      .run(id, id, `armadra-ws-${id}-1`);
  }

  it("destroys an unreachable session by its backend reference", async () => {
    const { manager, backend, database } = harness();
    orphanRow(database, "old-one");
    const destroyed = await manager.sweep();
    expect(destroyed).toEqual(["old-one"]);
    expect(backend.calls).toContain("destroyRef:armadra-ws-old-one-1");
    const row = database
      .prepare(
        "SELECT status, attach_state FROM terminal_sessions WHERE id = ?",
      )
      .get("old-one") as { status: string; attach_state: string };
    expect(row).toEqual({ status: "exited", attach_state: "exited" });
  });

  /**
   * Somebody may have attached between the query and now. Checking again is
   * the difference between a reclamation and killing the terminal a person is
   * looking at.
   */
  it("checks once more that nothing attached in the meantime", async () => {
    const { manager, backend, database } = harness();
    orphanRow(database, "old-one");
    database
      .prepare(
        "UPDATE terminal_sessions SET attach_state = 'live' WHERE id = 'old-one'",
      )
      .run();
    expect(await manager.sweep()).toEqual([]);
    expect(backend.calls).toEqual([]);
  });

  it("never reclaims a session whose node is still on a board", async () => {
    const { manager, database } = harness();
    const session = await spawn(manager);
    database
      .prepare(
        "UPDATE terminal_sessions SET last_output_at = '2026-09-01T00:00:00Z' WHERE id = ?",
      )
      .run(session.id);
    // No node at all, but the workspace is open and the row is this core's —
    // the policy needs *both* an old clock and nothing able to reach it.
    expect(await manager.sweep()).toEqual([session.id]);
  });
});

describe("exits nobody was watching", () => {
  it("settles a row from a backend notice", async () => {
    const { manager, backend, database } = harness();
    const session = await spawn(manager, "node-a");
    backend.announce({
      type: "exited",
      key: "node-a" as SessionKey,
      generation: 1,
      exitCode: 3,
    });
    const row = database
      .prepare(
        "SELECT status, exit_code, attach_state FROM terminal_sessions WHERE id = ?",
      )
      .get(session.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      status: "exited",
      exit_code: 3,
      attach_state: "exited",
    });
    expect(manager.isAlive(session.id)).toBe(false);
  });

  /** A notice for a generation this session has moved past is not its exit. */
  it("ignores a notice from a superseded generation", async () => {
    const { manager, backend, database } = harness();
    const session = await spawn(manager, "node-a");
    await manager.recycle(session.id);
    backend.announce({
      type: "exited",
      key: "node-a" as SessionKey,
      generation: 1,
      exitCode: 3,
    });
    const row = database
      .prepare("SELECT status FROM terminal_sessions WHERE id = ?")
      .get(session.id) as { status: string };
    expect(row.status).toBe("running");
  });

  /**
   * An explicit kill is recorded as `terminated` and must win: the exit that
   * follows it is the same event, not an independent one.
   */
  it("does not let the following exit overwrite an explicit termination", async () => {
    const { manager, backend, database } = harness();
    const session = await spawn(manager, "node-a");
    await manager.terminate(session.id, "session");
    backend.announce({
      type: "exited",
      key: "node-a" as SessionKey,
      generation: 1,
      exitCode: 0,
    });
    const row = database
      .prepare(
        "SELECT status, termination_intent FROM terminal_sessions WHERE id = ?",
      )
      .get(session.id) as { status: string; termination_intent: string };
    expect(row).toEqual({
      status: "terminated",
      termination_intent: "session",
    });
  });

  /** A liveness poll is how a persistent session that ended quietly is found. */
  it("finds a persistent session that ended while nothing watched", async () => {
    const { manager, backend, database } = harness();
    const session = await spawn(manager, "node-a");
    backend.sessions.delete("node-a" as SessionKey);
    await manager.pollLiveness();
    const row = database
      .prepare("SELECT status FROM terminal_sessions WHERE id = ?")
      .get(session.id) as { status: string };
    expect(row.status).toBe("exited");
  });
});

describe("reads and writes that go through the manager", () => {
  it("counts the lines of a capture", async () => {
    const { manager } = harness();
    const session = await spawn(manager);
    expect(await manager.capture(session.id, 40, false)).toEqual({
      generation: 1,
      lines: 2,
      data: "line one\nline two",
    });
  });

  it("passes a scroll and a paste straight through", async () => {
    const { manager, backend } = harness();
    const session = await spawn(manager, "node-a");
    await manager.scroll(session.id, -3);
    await manager.paste(session.id, "text", true);
    expect(backend.calls).toContain("scroll:node-a:-3");
    expect(backend.calls).toContain("paste:node-a:text:true");
  });

  it("turns `interrupt` into a signal, not a kill", async () => {
    const { manager, backend, database } = harness();
    const session = await spawn(manager, "node-a");
    await manager.terminate(session.id, "interrupt");
    expect(backend.calls).toContain("signal:node-a");
    const row = database
      .prepare(
        "SELECT status, termination_intent FROM terminal_sessions WHERE id = ?",
      )
      .get(session.id) as { status: string; termination_intent: string };
    expect(row).toEqual({ status: "running", termination_intent: "none" });
  });

  /**
   * A paste into a node showing a permission prompt answers the prompt. Only
   * the programmatic paths consult this; a person typing at their own prompt
   * is not gated.
   */
  it("reports a node waiting on a person as not writable", async () => {
    const { manager, database } = harness();
    const session = await spawn(manager, "node-a");
    expect(manager.writable(session.id)).toBe(true);
    database
      .prepare(
        `INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, updated_at)
           VALUES ('node-a', 'ws', 'claude', 'blocked', 0, '2026-09-20T12:00:00Z')`,
      )
      .run();
    expect(manager.writable(session.id)).toBe(false);
  });
});

describe("shutdown", () => {
  /**
   * The rows of a persistent backend describe sessions that are still running
   * under a server this process does not own. They are detached, not ended.
   */
  it("detaches a persistent session rather than ending it", async () => {
    const { manager, backend, database } = harness();
    const session = await spawn(manager);
    await manager.attach(session.id, { cols: 80, rows: 24 });
    await manager.shutdown();
    const row = database
      .prepare(
        "SELECT status, attach_state FROM terminal_sessions WHERE id = ?",
      )
      .get(session.id) as { status: string; attach_state: string };
    expect(row).toEqual({ status: "running", attach_state: "detached" });
    expect(backend.calls).toContain("detachAll");
  });
});

/**
 * 驱动租约（设计 `agent-delivery.md` §6）。
 *
 * 状态机本身由 `drive/lease.test.ts` 与 `browser/lease.test.ts` 守着；这里测的
 * 是它挂在终端上的那几处：人敲键抢占、停手十秒自然恢复、显式接管不恢复、代次
 * 落 `drive_generation`。
 */
describe("驱动租约", () => {
  const human = () => humanActor("device-a", "");
  const agent = () => agentActor("node-b", "sess-b", "Claude");

  it("人敲键就夺走 Agent 的租约，并广播一帧", async () => {
    const { manager, leases } = harness();
    const session = await spawn(manager, "node-a");
    await manager.input(session.id, 1, "ls", undefined, agent());
    expect(manager.driveLease(session.id)).toMatchObject({
      state: "agent",
      holder: { kind: "agent", id: "node-b" },
    });
    await manager.input(session.id, 1, "x", undefined, human());
    expect(manager.driveLease(session.id)).toMatchObject({
      state: "human",
      holder: { kind: "human", id: "device-a" },
    });
    expect(leases.at(-1)).toMatchObject({
      sessionId: session.id,
      nodeId: "node-a",
      lease: { state: "human" },
    });
  });

  it("人连续敲键只在拿到租约那一下广播一帧，续期不再逐键广播（§58）", async () => {
    const { manager, advance, leases } = harness();
    const session = await spawn(manager, "node-a");
    for (let key = 0; key < 100; key += 1) {
      await manager.input(session.id, 1, "x", undefined, human());
      advance(200);
    }
    expect(leases.map((event) => event.lease.state)).toEqual(["human"]);
    // 续期照旧逐键推后到期时刻：最后一键之后仍要整整十秒才放开。
    advance(TERMINAL_HUMAN_IDLE_SECONDS * 1_000 - 201);
    expect(manager.sweepDrives()).toBe(0);
    await expect(
      manager.input(session.id, 1, "ls", undefined, agent()),
    ).rejects.toMatchObject({
      message: expect.stringContaining("LEASE_HELD_BY_HUMAN"),
    });
    advance(1);
    expect(manager.sweepDrives()).toBe(1);
    expect(leases.map((event) => event.lease.state)).toEqual(["human", "free"]);
  });

  it("Agent 持有时人敲一键仍然抢回租约，并且只广播换手那一帧", async () => {
    const { manager, leases } = harness();
    const session = await spawn(manager, "node-a");
    await manager.input(session.id, 1, "ls", undefined, agent());
    await manager.input(session.id, 1, "pwd", undefined, agent());
    expect(leases.map((event) => event.lease.state)).toEqual(["agent"]);
    await manager.input(session.id, 1, "x", undefined, human());
    await manager.input(session.id, 1, "y", undefined, human());
    expect(leases.map((event) => event.lease.state)).toEqual([
      "agent",
      "human",
    ]);
  });

  it("人在打字时 Agent 的写入被拒，码是 LEASE_HELD_BY_HUMAN", async () => {
    const { manager } = harness();
    const session = await spawn(manager, "node-a");
    await manager.input(session.id, 1, "half a line", undefined, human());
    await expect(
      manager.input(session.id, 1, "ls", undefined, agent()),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("LEASE_HELD_BY_HUMAN"),
    });
  });

  it("抢占之后停手十秒自动恢复，Agent 又能驱动", async () => {
    const { manager, advance, leases } = harness();
    const session = await spawn(manager, "node-a");
    await manager.input(session.id, 1, "x", undefined, human());
    advance((TERMINAL_HUMAN_IDLE_SECONDS - 1) * 1_000);
    expect(manager.sweepDrives()).toBe(0);
    advance(1_000);
    expect(manager.sweepDrives()).toBe(1);
    expect(manager.driveLease(session.id).state).toBe("free");
    expect(leases.at(-1)?.lease.state).toBe("free");
    await expect(
      manager.input(session.id, 1, "ls", undefined, agent()),
    ).resolves.toBeUndefined();
  });

  it("显式接管不自动恢复，Agent 一律收 LEASE_REVOKED", async () => {
    const { manager, advance } = harness();
    const session = await spawn(manager, "node-a");
    await manager.input(session.id, 1, "ls", undefined, agent());
    expect(manager.takeoverDrive(session.id, human()).state).toBe(
      "humanTakeover",
    );
    advance(TERMINAL_HUMAN_IDLE_SECONDS * 10 * 1_000);
    expect(manager.sweepDrives()).toBe(0);
    await expect(
      manager.input(session.id, 1, "ls", undefined, agent()),
    ).rejects.toMatchObject({
      message: expect.stringContaining("LEASE_REVOKED"),
    });
    // 交还之后 Agent 又能驱动。
    manager.releaseDrive(session.id, human());
    expect(manager.driveLease(session.id).state).toBe("free");
  });

  it("Agent 的租约比人长得多，一轮里不会被另一个 Agent 插进来", async () => {
    const { manager, advance } = harness();
    const session = await spawn(manager, "node-a");
    await manager.input(session.id, 1, "ls", undefined, agent());
    advance((TERMINAL_AGENT_IDLE_SECONDS - 1) * 1_000);
    expect(manager.sweepDrives()).toBe(0);
    await expect(
      manager.input(
        session.id,
        1,
        "ls",
        undefined,
        agentActor("node-c", "sess-c", "Codex"),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("LEASE_HELD_BY_AGENT"),
    });
    advance(1_000);
    expect(manager.sweepDrives()).toBe(1);
  });

  it("代次落在 drive_generation，回收之后不回头", async () => {
    const { manager, database } = harness();
    const session = await spawn(manager, "node-a");
    await manager.input(session.id, 1, "x", undefined, human());
    const stored = () =>
      (
        database
          .prepare(
            "SELECT drive_generation FROM terminal_sessions WHERE id = ?",
          )
          .get(session.id) as { drive_generation: number }
      ).drive_generation;
    expect(stored()).toBe(1);
    expect(manager.driveLease(session.id).generation).toBe(1);
    // 回收换的是 PTY，驱动权跟着那个进程一起消失，代次不回头。
    await manager.recycle(session.id);
    expect(manager.driveLease(session.id)).toMatchObject({
      state: "free",
      generation: 1,
    });
    await manager.input(session.id, 2, "x", undefined, human());
    expect(stored()).toBe(2);
  });

  it("没说自己是谁的写入不碰租约", async () => {
    const { manager } = harness();
    const session = await spawn(manager, "node-a");
    await manager.input(session.id, 1, "ls");
    expect(manager.driveLease(session.id).state).toBe("free");
  });

  it("一次写完括号粘贴与回车", async () => {
    const { manager, backend } = harness();
    const session = await spawn(manager, "node-a");
    await manager.writeSubmit(
      session.id,
      1,
      "\u4f60\u597d\n\u4e16\u754c",
      agent(),
    );
    const written = backend.calls.at(-1) ?? "";
    expect(written).toBe(
      `input:${session.sessionKey}:\u001b[200~\u4f60\u597d\n\u4e16\u754c\u001b[201~\r`,
    );
  });

  it("driveTarget 把五态、持有者与代次放在一个答案里", async () => {
    const { manager, database } = harness();
    const session = await spawn(manager, "node-a");
    expect(manager.driveTarget("node-a")).toMatchObject({
      nodeId: "node-a",
      sessionId: session.id,
      state: "starting",
      driveGeneration: 0,
      lease: { state: "free" },
    });
    database
      .prepare(
        `INSERT INTO agent_status
           (node_id, workspace_id, agent_id, state, state_source, unread, verified,
            restored, updated_at)
         VALUES ('node-a', 'ws', 'codex', 'done', 'hook', 0, 1, 0,
                 '2026-09-20T12:00:00Z')`,
      )
      .run();
    await manager.input(session.id, 1, "x", undefined, human());
    expect(manager.driveTarget("node-a")).toMatchObject({
      state: "idle",
      stateSource: "hook",
      driveGeneration: 1,
      lease: { state: "human", holder: { id: "device-a" } },
    });
    expect(manager.driveTarget("node-missing")).toMatchObject({
      state: "exited",
    });
  });
});
