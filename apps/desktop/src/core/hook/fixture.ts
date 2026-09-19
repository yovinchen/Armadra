import type { WorkspaceEvent } from "../bus";
import { install as installEvents } from "../events";
import type { CoreContext } from "../main";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { fixture as coreFixture, type Fixture as CoreFixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import type { IngestContext } from "./ingest";
import { HookServer } from "./server";
import { HookService } from "./service";
import { type AgentStatusRow, getAgentStatus } from "./store";

/**
 * The hook fixture: a real database with the real migrations, a real hook
 * router, and one terminal node on the default board to attribute reports to.
 *
 * It is a fixture rather than a mock for the same reason the canvas one is:
 * the queries the sweep and the reducer lean on — the `EXISTS` guards, the
 * `ON CONFLICT` upsert — only exist inside SQLite, and a fake would test the
 * fake.
 */
export interface HookFixture {
  readonly core: CoreFixture;
  readonly context: IngestContext;
  readonly service: HookService;
  readonly server: HookServer;
  readonly workspaceId: string;
  readonly boardId: string;
  readonly nodeId: string;
  readonly bearer: string;
  /** Frames published on `workspace.event`, in order. */
  readonly published: WorkspaceEvent[];
  postHook(
    agentPath: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ status: number; body: unknown }>;
  /** The happy path: correct bearer, correct node token. */
  report(payload: unknown): Promise<number>;
  status(): AgentStatusRow | undefined;
  close(): void;
}

export function hookFixture(
  extra: readonly ((context: CoreContext) => void)[] = [],
): HookFixture {
  const core = coreFixture([installEvents, installWorkspaces, ...extra]);
  const workspace = core.database
    .prepare("SELECT id FROM workspaces LIMIT 1")
    .get() as { id: string };
  const board = core.database
    .prepare("SELECT id FROM boards WHERE workspace_id = ? LIMIT 1")
    .get(workspace.id) as { id: string };

  const nodeId = uuidV7();
  const now = rfc3339();
  core.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, x, y, title, color, data_json, created_at, updated_at) " +
        "VALUES (?, ?, 'terminal', 0, 0, 'Claude', '#0a84ff', ?, ?, ?)",
    )
    .run(
      nodeId,
      board.id,
      JSON.stringify({
        kind: "terminal",
        cwd: ".",
        agent: { id: "claude" },
      }),
      now,
      now,
    );

  const service = new HookService(core.directory, 43199);
  service.publishEndpoint(43199);
  const published: WorkspaceEvent[] = [];
  core.bus.on("workspace.event", (payload) => published.push(payload.event));

  const context: IngestContext = {
    database: core.database,
    bus: core.bus,
    hooks: service,
    log: { warn: () => {}, debug: () => {} },
  };
  const server = new HookServer(context);

  const call = async (
    method: string,
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ status: number; body: unknown }> => {
    const encoded =
      body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(body), "utf8");
    const answer = await server.router.dispatch(method, path, {
      method,
      path,
      query: new URLSearchParams(),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: encoded,
      raw: undefined as never,
      json: <T>(): T => JSON.parse(encoded.toString("utf8") || "null") as T,
    });
    return answer as { status: number; body: unknown };
  };

  return {
    core,
    context,
    service,
    server,
    workspaceId: workspace.id,
    boardId: board.id,
    nodeId,
    bearer: service.bearer(),
    published,
    postHook: (agentPath, body, headers) =>
      call("POST", `/hook/${agentPath}`, body, headers),
    report: async (payload) => {
      const token = service.issueNodeToken(nodeId);
      const answer = await call(
        "POST",
        "/hook/claude",
        { nodeId, version: 1, payload },
        {
          "x-armadra-hook-token": service.bearer(),
          "x-armadra-node-token": token,
          "x-armadra-hook-client": "1",
        },
      );
      return answer.status;
    },
    status: () => getAgentStatus(core.database, nodeId),
    close: () => {
      void server.close();
      core.close();
    },
  };
}

/** A terminal session row for the node, in whatever state the case needs. */
export function insertSession(
  fixture: HookFixture,
  options: {
    readonly id: string;
    readonly status: string;
    readonly endedAt?: string | undefined;
    readonly agentId?: string;
    readonly generation?: number;
  },
): void {
  fixture.core.database
    .prepare(
      "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id, " +
        "agent_id, status, created_at, ended_at, session_key, backend_kind, generation, attach_state) " +
        "VALUES (?, ?, '/tmp', 'sh', 'terminal', ?, ?, ?, ?, ?, ?, 'direct', ?, 'live')",
    )
    .run(
      options.id,
      fixture.workspaceId,
      fixture.nodeId,
      options.agentId ?? "claude",
      options.status,
      rfc3339(),
      options.endedAt ?? null,
      `${fixture.nodeId}-${options.id}`,
      options.generation ?? 0,
    );
}

/** `now` minus `minutes`, in the RFC 3339 spelling the rows carry. */
export function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
