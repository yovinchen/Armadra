import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { EventBus } from "../bus";
import type { WorkspaceEvent } from "../bus";
import { createBoard } from "../canvas/boards";
import { putContextLinks } from "../canvas/context-links";
import { type OpenedDatabase, openDatabase } from "../db/open";
import { CoreServer } from "../http/server";
import type { CoreRequest } from "../http/router";
import { createLog, nodePlatform } from "../platform";
import { canonicalize } from "../workspaces/roots";
import { createWorkspace } from "../workspaces/table";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { type Caller, loadNode } from "../collab/nodes";
import type { AgentSettings, CustomAgent } from "./registry";
import {
  type CollabContext,
  type DriveActor,
  type DriveTarget,
  type TerminalBridge,
  collabContext,
} from "../collab/service";
import { freeLease } from "../drive/lease";
import type { ObservedActivity } from "./target-state";
import {
  authorizeMailboxAck,
  noteAcknowledged,
  readForCaller,
} from "../handoff/store";
import {
  createControlDispatcher,
  setControlDispatcher,
} from "../collab/control";
import { ContextUsageCache } from "../usage/context-usage";
import { installRoutes } from "./routes";

/**
 * A throwaway core for the agent-domain tests.
 *
 * A real database with the real migrations — including the unified overlay,
 * which is where `agent_approval_audit` and the `revision` columns live — a
 * real router, and a temporary directory that doubles as the data directory
 * and a workspace root.
 *
 * It is a fixture rather than a mock on purpose. The parts most worth testing
 * are the ones that only exist inside SQLite: the approval CAS, the mailbox's
 * conditional insert, the `ON CONFLICT` on a handoff key. A fake database
 * would test the fake.
 *
 * The terminal bridge, by contrast, *is* a stub: a test that had to stand up a
 * PTY to check that `interrupt` refuses an unlinked node is a test nobody
 * would write, and the bridge interface exists precisely so it does not have
 * to.
 */

const here = dirname(fileURLToPath(import.meta.url));

export function migrationsDir(): string {
  return resolve(here, "../db/migrations");
}

export interface StubTerminal {
  /** Everything written into a pane, newest last. */
  readonly writes: { sessionId: string; generation: number; data: string }[];
  /**
   * 每一次 `writeSubmit`，也就是 `send` 真的投出去的那些。
   *
   * 与 `writes` 分开记：那条原语的全部意义是「括号粘贴、正文与回车是同一次
   * 写」，而用例要断言的正是它写出去的那一个字符串的形状。
   */
  readonly submits: {
    sessionId: string;
    generation: number;
    data: string;
    driver: DriveActor | undefined;
  }[];
  /** Sessions terminated, in order. */
  readonly terminated: string[];
  capture: string;
  foreground: { command?: string; children?: string[] } | undefined;
  liveGeneration: number | undefined;
  current: boolean;
  /** `driveTarget` 的答案，按节点 id。缺席时由 `agent_status` 的行算出来。 */
  readonly drive: Map<string, Partial<DriveTarget>>;
  /** `observed` 的答案，按会话 id。 */
  readonly activity: Map<string, ObservedActivity>;
  /** 下一次 `writeSubmit` 抛这个。 */
  submitError: Error | undefined;
  bridge: TerminalBridge;
}

export function stubTerminal(): StubTerminal {
  const stub: StubTerminal = {
    writes: [],
    submits: [],
    terminated: [],
    drive: new Map(),
    activity: new Map(),
    submitError: undefined,
    capture: "",
    foreground: { command: "claude" },
    liveGeneration: 1,
    current: true,
    bridge: {
      write: async (sessionId, generation, data) => {
        stub.writes.push({ sessionId, generation, data });
      },
      capture: async (_sessionId, lines) => ({
        lines,
        data: stub.capture,
      }),
      foreground: async () => stub.foreground,
      generation: () => stub.liveGeneration,
      terminate: async (sessionId) => {
        stub.terminated.push(sessionId);
      },
      isCurrentNodeSession: async () => stub.current,
      driveTarget: (nodeId) => {
        const override = stub.drive.get(nodeId) ?? {};
        return {
          nodeId,
          sessionId: "session",
          state: "idle",
          stateSource: "hook",
          lease: freeLease(0),
          driveGeneration: 0,
          ...override,
        } satisfies DriveTarget;
      },
      writeSubmit: async (sessionId, generation, data, driver) => {
        if (stub.submitError !== undefined) throw stub.submitError;
        stub.submits.push({ sessionId, generation, data, driver });
      },
      observed: (sessionId) => stub.activity.get(sessionId),
    },
  };
  return stub;
}

export interface AgentFixture {
  readonly database: DatabaseSync;
  readonly directory: string;
  readonly workspaceId: string;
  readonly boardId: string;
  readonly collab: CollabContext;
  readonly terminal: StubTerminal;
  readonly usage: ContextUsageCache;
  /** Every workspace event published, in order. */
  readonly events: { workspaceId: string; event: WorkspaceEvent }[];
  /** How many clients the fixture pretends are watching. */
  watchers: number;
  customAgents: CustomAgent[];
  call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
  /** Adds a terminal node running `agentId`, and returns its id. */
  agentNode(title: string, agentId?: string | null): string;
  /** Adds a sticky node carrying `content`, and returns its id. */
  stickyNode(title: string, content: string): string;
  /** Adds a running terminal session owned by `nodeId`. */
  session(nodeId: string, agentId: string, generation?: number): string;
  /** Writes the two link documents a canvas edge implies. */
  link(left: string, right: string): void;
  /** Gives `nodeId` a name on the board, table and rendered copy together. */
  name(nodeId: string, handle: string): void;
  close(): void;
}

export function agentFixture(): AgentFixture {
  const directory = canonicalize(mkdtempSync(join(tmpdir(), "armadra-agent-")));
  const opened: OpenedDatabase = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir: migrationsDir(),
  });
  const database = opened.database;
  const log = createLog("error");
  const platform = nodePlatform({
    dataDir: directory,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log,
  });
  const bus = new EventBus();
  const server = new CoreServer({ platform, bus, version: "0.0.0-test" });

  const workspace = createWorkspace(database, {
    name: "fixture",
    rootPath: directory,
    // Execution is off by default and the handoff verbs need it: accepting is
    // a write the user authorised, and the gate is the workspace's.
    permissions: { read: true, write: true, execute: true },
  });
  const board = createBoard(database, workspace.id, "Board");

  const events: { workspaceId: string; event: WorkspaceEvent }[] = [];
  const terminal = stubTerminal();
  const usage = new ContextUsageCache();
  const customAgents: CustomAgent[] = [];
  const settings: AgentSettings = { customAgents: () => customAgents };
  const state = { watchers: 0 };

  const base = collabContext({
    database,
    settings,
    publish: (workspaceId, event) => {
      events.push({ workspaceId, event });
    },
    audience: () => state.watchers,
    terminals: terminal.bridge,
    dataDir: directory,
    // `send --interrupt` 等 `idle` 的那一段：注入一个空操作，用例才不用真的睡
    // 五秒去证明「等不到就退回排队」。
    delay: async () => {},
  });
  const collab: CollabContext = {
    ...base,
    handoff: {
      authorizeMailboxAck: (caller, id, sessionId, generation) =>
        authorizeMailboxAck(collab, caller, id, sessionId, generation),
      noteAcknowledged: (mailboxId) => noteAcknowledged(collab, mailboxId),
    },
    handoffReader: (caller, id, sessionId, generation) =>
      readForCaller(collab, caller, id, sessionId, generation),
  };
  setControlDispatcher(createControlDispatcher(collab));
  installRoutes({ server, collab, usage });

  const insertNode = (type: string, title: string, data: unknown): string => {
    const id = uuidV7();
    const now = rfc3339();
    database
      .prepare(
        "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
          "labels_json, note, data_json, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, '#0a84ff', 0, 0, 240, 200, '[]', '', ?, ?, ?)",
      )
      .run(id, board.id, type, title, JSON.stringify(data), now, now);
    return id;
  };

  const fixture: AgentFixture = {
    database,
    directory,
    workspaceId: workspace.id,
    boardId: board.id,
    collab,
    terminal,
    usage,
    events,
    get watchers() {
      return state.watchers;
    },
    set watchers(value: number) {
      state.watchers = value;
    },
    customAgents,
    call: async (method, path, body) => {
      const url = new URL(path, "http://core");
      const encoded =
        body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(body), "utf8");
      const request = {
        method,
        path: url.pathname,
        query: url.searchParams,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: encoded,
        raw: undefined as never,
        json: <T>(): T => JSON.parse(encoded.toString("utf8")) as T,
      } satisfies CoreRequest;
      const answer = await server.router.dispatch(
        method,
        url.pathname,
        request,
      );
      return answer as { status: number; body: unknown };
    },
    agentNode: (title, agentId = "claude") =>
      insertNode(
        "terminal",
        title,
        agentId === null
          ? { kind: "terminal" }
          : { kind: "terminal", agent: { id: agentId } },
      ),
    stickyNode: (title, content) =>
      insertNode("sticky", title, { kind: "sticky", content }),
    session: (nodeId, agentId, generation = 1) => {
      const id = uuidV7();
      database
        .prepare(
          "INSERT INTO terminal_sessions (id, workspace_id, session_key, kind, owner_node_id, agent_id, " +
            "cwd, shell, status, generation, attach_state, created_at) " +
            "VALUES (?, ?, ?, 'terminal', ?, ?, ?, '/bin/sh', 'running', ?, 'live', ?)",
        )
        .run(
          id,
          workspace.id,
          nodeId,
          nodeId,
          agentId,
          directory,
          generation,
          rfc3339(),
        );
      return id;
    },
    link: (left, right) => {
      const titleOf = (id: string): { title: string; type: string } =>
        database
          .prepare("SELECT title, type FROM nodes WHERE id = ?")
          .get(id) as { title: string; type: string };
      const a = titleOf(left);
      const b = titleOf(right);
      putContextLinks(database, workspace.id, left, [
        { id: right, title: b.title, kind: b.type },
      ]);
      putContextLinks(database, workspace.id, right, [
        { id: left, title: a.title, kind: a.type },
      ]);
      const now = rfc3339();
      database
        .prepare(
          "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, 'link', ?, ?)",
        )
        .run(uuidV7(), board.id, left, right, now, now);
    },
    // `rename --handle` 走的是板文档的保存；这里直接写，理由与 `link` 一样：
    // 要测的是读到名字之后的行为，不是再走一遍写名字那条路。表与副本一起写，
    // 因为产品里它们也只会一起出现。
    name: (nodeId, handle) => {
      database
        .prepare(
          "INSERT INTO node_handles (board_id, handle, node_id, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(node_id) DO UPDATE SET handle = excluded.handle",
        )
        .run(board.id, handle, nodeId, rfc3339());
      database
        .prepare(
          "UPDATE nodes SET data_json = json_set(data_json, '$.handle', ?) WHERE id = ?",
        )
        .run(handle, nodeId);
    },
    close: () => {
      setControlDispatcher(undefined);
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return fixture;
}

/** A verified caller for `nodeId`, as the Hook surface would resolve one. */
export function callerFor(
  fixture: AgentFixture,
  nodeId: string,
  verdict: "verified" | "legacy" = "verified",
): Caller {
  const node = loadNode(fixture.database, nodeId);
  if (node === undefined) throw new Error(`no node ${nodeId}`);
  return { node, verdict };
}
