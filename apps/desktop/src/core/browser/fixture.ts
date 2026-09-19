import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceEvent } from "../bus";
import { createBoard } from "../canvas/boards";
import { getContextLinks, putContextLinks } from "../canvas/context-links";
import { type OpenedDatabase, openDatabase } from "../db/open";
import { createLog } from "../platform";
import { type Caller, loadNode } from "../collab/nodes";
import type { AgentSettings, CustomAgent } from "../agent/registry";
import { canonicalize } from "../workspaces/roots";
import { createWorkspace } from "../workspaces/table";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { type BrowserContext, browserContext } from "./context";

/**
 * A throwaway core for the browser-domain tests: a workspace with a browser
 * node and an agent node linked to it.
 *
 * A real database with the real migrations, because the one row this domain
 * still writes lives in SQLite and a fake would test the fake. Nothing here
 * opens a socket, starts a process or needs a page — which is the whole point
 * of the split: what a click does to a document is tested where the click
 * happens, in `apps/desktop/src/main/browser/`.
 */

const here = dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  return resolve(here, "../db/migrations");
}

export interface BrowserFixture {
  readonly database: DatabaseSync;
  readonly directory: string;
  readonly workspaceId: string;
  readonly boardId: string;
  readonly context: BrowserContext;
  /** Every workspace event published, in order. */
  readonly events: { workspaceId: string; event: WorkspaceEvent }[];
  /** Everything pushed down the drive channel without waiting for an answer. */
  readonly notices: { nodeId: string; event: string; detail: unknown }[];
  /** Every verb that reached the drive channel. */
  readonly sent: { nodeId: string; verb: string; args: unknown }[];
  /** The browser node. */
  readonly nodeId: string;
  /** An agent terminal node linked to it. */
  readonly agentId: string;
  customAgents: CustomAgent[];
  /** What the next drive call answers with, or the refusal it throws. */
  answer: unknown;
  failure: Error | undefined;
  /** The clock the lease reads. */
  now: Date;
  node(type: string, title: string, data: unknown): string;
  link(left: string, right: string): void;
  close(): void;
}

export function browserFixture(
  options: { readonly withShell?: boolean } = {},
): BrowserFixture {
  const directory = canonicalize(
    mkdtempSync(join(tmpdir(), "armadra-browser-")),
  );
  const opened: OpenedDatabase = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir: migrationsDir(),
  });
  const database = opened.database;
  const workspace = createWorkspace(database, {
    name: "fixture",
    rootPath: directory,
    permissions: { read: true, write: true, execute: true },
  });
  const board = createBoard(database, workspace.id, "Board");

  const events: { workspaceId: string; event: WorkspaceEvent }[] = [];
  const notices: { nodeId: string; event: string; detail: unknown }[] = [];
  const sent: { nodeId: string; verb: string; args: unknown }[] = [];
  const customAgents: CustomAgent[] = [];
  const settings: AgentSettings = { customAgents: () => customAgents };
  const log = createLog("error");

  const insertNode = (type: string, title: string, data: unknown): string => {
    const id = uuidV7();
    const now = rfc3339();
    database
      .prepare(
        "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
          "labels_json, note, data_json, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, '#0a84ff', 0, 0, 640, 440, '[]', '', ?, ?, ?)",
      )
      .run(id, board.id, type, title, JSON.stringify(data), now, now);
    return id;
  };

  const state = {
    answer: {} as unknown,
    failure: undefined as Error | undefined,
    now: new Date("2026-09-06T09:00:00Z"),
  };

  // A stand-in for the drive channel rather than a socket: what is worth
  // testing on this side is which arguments travel and what the answer is
  // rendered as, and neither of those is a fact about a WebSocket.
  const client =
    options.withShell === true
      ? ({
          drive: async (nodeId: string, verb: string, args: unknown) => {
            sent.push({ nodeId, verb, args });
            if (state.failure !== undefined) throw state.failure;
            return state.answer;
          },
          notify: (nodeId: string, event: string, detail: unknown) => {
            notices.push({ nodeId, event, detail });
          },
        } as unknown as Parameters<typeof browserContext>[0]["client"])
      : undefined;

  const context = browserContext({
    database,
    settings,
    publish: (workspaceId, event) => {
      events.push({ workspaceId, event });
    },
    client,
    now: () => state.now,
    log: (message, detail) => {
      log.warn(message, detail);
    },
  });

  const nodeId = insertNode("browser", "预览", { kind: "browser", url: "" });
  const agentId = insertNode("terminal", "Claude", {
    kind: "terminal",
    cwd: ".",
    agent: { id: "claude" },
  });

  const fixture: BrowserFixture = {
    database,
    directory,
    workspaceId: workspace.id,
    boardId: board.id,
    context,
    events,
    notices,
    sent,
    nodeId,
    agentId,
    customAgents,
    get answer() {
      return state.answer;
    },
    set answer(value: unknown) {
      state.answer = value;
    },
    get failure() {
      return state.failure;
    },
    set failure(value: Error | undefined) {
      state.failure = value;
    },
    get now() {
      return state.now;
    },
    set now(value: Date) {
      state.now = value;
    },
    node: insertNode,
    // Appending rather than replacing: the canvas pushes a whole document
    // when an edge changes, but a test that draws two edges means two links,
    // and a fixture that dropped the first would be testing itself.
    link: (left, right) => {
      const titleOf = (id: string): { title: string; type: string } =>
        database
          .prepare("SELECT title, type FROM nodes WHERE id = ?")
          .get(id) as { title: string; type: string };
      const join = (owner: string, other: string): void => {
        const info = titleOf(other);
        const existing = getContextLinks(database, owner).links.filter(
          (link) => link.id !== other,
        );
        putContextLinks(database, workspace.id, owner, [
          ...existing,
          { id: other, title: info.title, kind: info.type },
        ]);
      };
      join(left, right);
      join(right, left);
    },
    close: () => {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  fixture.link(agentId, nodeId);
  return fixture;
}

/** A verified caller for `nodeId`, as the Hook surface would resolve one. */
export function callerFor(
  fixture: BrowserFixture,
  nodeId: string,
  verdict: "verified" | "legacy" = "verified",
): Caller {
  const node = loadNode(fixture.database, nodeId);
  if (node === undefined) throw new Error(`no node ${nodeId}`);
  return { node, verdict };
}
