import { resolve } from "node:path";
import { VERSION } from "../instance";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import {
  type BackendKind,
  TerminalError,
  type TerminalBackend,
  type TerminateMode,
} from "./backend";
import { remoteDomain } from "../remote";
import { DirectBackend } from "./direct";
import { handleForNode } from "../canvas/handles";
import { agentEnvironment, setHookClient } from "./environment";
import { launcherClientBinary } from "../hook/install/shared";
import { setTerminalBridge } from "../agent";
import { terminalBridge } from "./bridge";
import { SshBackend } from "./ssh/backend";
import { permissionWaitEnvironment } from "../hook/approvals";
import { issueNodeToken } from "../hook/tokens";
import { TerminalManager } from "./manager";
import { humanActor } from "../drive/lease";
import {
  type BackendChoice,
  type BackendInfo,
  parseChoice,
  selectBackend,
} from "./select";
import { SessionHostBackend } from "./session-host/backend";
import { serveTerminalSocket, validWriter } from "./socket";
import { TmuxBackend } from "./tmux/backend";
import { detect } from "./tmux/config";

/**
 * The terminal domain's one assembly point: the backends, the manager, the
 * nine routes and the socket.
 *
 * ## Which backends exist, and which one is used
 *
 * All the ones this platform can reach are **built**, and exactly one is the
 * `effective` kind new sessions are created with (`select.ts`, contract
 * §15.1). Building the others is not waste: a database row created by an
 * earlier run under a different setting still names its own backend, and
 * `GET /api/terminals/{id}` and the reconciliation have to be able to reach
 * it. Serving such a row from whichever backend happens to be effective would
 * start a second process behind a key that already has one.
 *
 * ## The routes
 *
 * Nine of the ten terminal paths in the table are claimed here. The tenth,
 * `/api/terminals/{sessionId}/node-token/refresh`, belongs to R3: the token it
 * refreshes is issued by the hook service, which does not exist yet.
 *
 * `DELETE` on `/api/terminals/{sessionId}` is **not** claimed: the route table
 * lists that path as `GET` only, because the Rust Runtime has no DELETE there
 * — closing a terminal node posts `terminate` with `mode: "session"`.
 */

export interface TerminalDomain {
  readonly manager: TerminalManager;
  readonly backends: ReadonlyMap<BackendKind, TerminalBackend>;
  stop(): Promise<void>;
}

/** Lines a capture may return, and the ceiling a request may ask for. */
const DEFAULT_CAPTURE_LINES = 200;
const MAX_CAPTURE_LINES = 10_000;
/** A paste larger than this is a bug or an attempt to stall the core. */
const MAX_PASTE_CHARACTERS = 200_000;
/** One screenful per notch is already generous. */
const MAX_SCROLL_LINES = 10_000;

export interface TerminalInstallOptions {
  /**
   * Overrides `terminal.backend`.
   *
   * For the tests, and for them only: which backend is in effect changes what
   * every route does, and a suite whose answer depended on whether the machine
   * running it has tmux would be a suite that proves nothing.
   */
  readonly configured?: BackendChoice;
}

export function install(
  context: CoreContext,
  options: TerminalInstallOptions = {},
): TerminalDomain {
  publishHookClient(context);
  const settings = settingsDomain()?.settings;
  const configured =
    options.configured ??
    parseChoice(
      typeof settings?.terminal().backend === "string"
        ? (settings?.terminal().backend as string)
        : "auto",
    );
  const detection = detect();
  const selection = selectBackend({ configured, detection });

  const backends = new Map<BackendKind, TerminalBackend>();
  backends.set("direct", new DirectBackend());
  let tmux: TmuxBackend | undefined;
  if (process.platform !== "win32") {
    tmux = new TmuxBackend({ dataDir: context.dataDir, version: VERSION });
    backends.set("tmux", tmux);
  }
  if (process.platform === "win32") {
    backends.set(
      "sessionHost",
      new SessionHostBackend({ dataDir: context.dataDir, version: VERSION }),
    );
  }
  // An SSH terminal is a normal session whose command is `ssh …`, so the
  // decorator goes *around* a backend rather than beside it: a spec with no
  // `sshHostId` passes straight through, and the row still names the backend
  // that is really behind the session.
  //
  // **Every** backend is wrapped, not just the persistent one. A terminal
  // created with an `ssh` host under a backend the decorator had skipped would
  // silently run a local shell instead — a "remote" pane that is quietly on
  // this machine is the one outcome that must not happen.
  for (const [kind, backend] of [...backends]) {
    backends.set(kind, wrapSsh(context, backend));
  }
  // A selection this build cannot honour falls back rather than throwing at
  // assembly time: an unusable effective backend would take the whole core
  // down over a preference.
  const effective: BackendKind = backends.has(selection.effective)
    ? selection.effective
    : "direct";

  const manager = new TerminalManager({
    database: context.db.database,
    backends,
    effective,
    ...(settings === undefined
      ? {}
      : {
          policy: () => {
            const terminal = settings.terminal();
            return {
              detachedGraceMinutes: terminal.detachedGraceMinutes,
              dormantAfterSeconds: terminal.dormantAfterSeconds,
            };
          },
        }),
    log: (message, fields) => context.log.info(message, fields),
    onLease: (event) => {
      context.bus.emit("workspace.event", {
        workspaceId: event.workspaceId,
        event: {
          type: "terminal.lease",
          sessionId: event.sessionId,
          ...(event.nodeId === null ? {} : { nodeId: event.nodeId }),
          lease: event.lease as unknown as Record<string, unknown>,
        },
      });
    },
    onExit: (event) => {
      context.bus.emit("workspace.event", {
        workspaceId: event.workspaceId,
        event: {
          type: "terminal.exit",
          sessionId: event.sessionId,
          ...(event.nodeId === null ? {} : { nodeId: event.nodeId }),
          ...(event.exitCode === null ? {} : { exitCode: event.exitCode }),
        },
      });
    },
  });

  /**
   * Start-up recovery, and the gate every terminal answer waits behind.
   *
   * `install` is synchronous — that is the `DOMAINS` contract — and recovery
   * is not: it asks a tmux server what it still holds. The listeners bind as
   * soon as `install` returns, so without this gate the first request after a
   * restart races the adoption, and the page that reconnected half a second
   * too early is told its live pane is not running. That is not a test
   * artefact; it is what a user sees on every restart.
   *
   * So the promise is kept and awaited, once, by every handler below and by
   * the socket's guard. It never rejects: a recovery that fails leaves the
   * rows exactly as they are — they may describe sessions alive under a
   * backend this process merely failed to reach — and the log says why.
   */
  const ready: Promise<void> = manager
    .start()
    .then((report) => {
      context.log.info("终端启动对账完成", {
        detached: report.detached,
        exited: report.exited,
        orphansDestroyed: report.orphansDestroyed,
      });
    })
    .catch((error: unknown) => {
      context.log.warn("终端启动对账失败", { error: describe(error) });
    });
  if (tmux !== undefined) {
    void tmux
      .adoptServer()
      .then((note) => {
        if (note !== undefined) context.log.info(note);
      })
      .catch(() => {
        // A server that cannot be interrogated is left alone; the next
        // `new-session` stamps whatever is there.
      });
  }

  const route = (
    method: string,
    path: string,
    handler: (
      params: Readonly<Record<string, string>>,
      request: import("../http/router").CoreRequest,
    ) => Promise<Answer> | Answer,
  ): void => {
    context.server.router.handle(method, path, async (match, request) => {
      await ready;
      try {
        return await handler(match.params, request);
      } catch (failure) {
        return error(failure);
      }
    });
  };

  /* --------------------------------- create -------------------------------- */

  route("POST", "/api/terminals", async (_params, request) => {
    const body = json<CreateTerminalRequest>(request);
    const invalid = validateCreate(body);
    if (invalid !== undefined) {
      throw new TerminalError(400, "bad_request", invalid);
    }
    // The agent's four address variables, when a node owns this terminal. The
    // per-node token is *minted* here and never travels here: it goes into
    // `<data>/node-tokens/<nodeId>`, 0600, because any process of the same
    // user can read another process' environment (contract §5 item 5).
    const owned = body.agent !== undefined && body.nodeId !== undefined;
    const env = owned
      ? [
          ...agentEnvironment(
            body.nodeId as string,
            (body.agent as { id: string }).id,
            context.dataDir,
            handleForNode(context.db.database, body.nodeId as string),
          ),
          // Contract §5.5: the one variable that switches the hook client from
          // "report and exit" to "wait for the canvas' answer".
          ...permissionWaitEnvironment(
            (body.agent as { id: string }).id,
            settingsDomain()?.settings.get("hooks.replyApprovals") !== false,
          ),
        ]
      : [];
    if (owned) {
      try {
        issueNodeToken(context.dataDir, body.nodeId as string);
      } catch (failure) {
        // A token we could not write downgrades every report from this
        // terminal to `legacy`; it must not stop the terminal opening.
        context.log.warn("could not mint the node token", {
          nodeId: body.nodeId,
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
    }
    const session = await manager.spawn({
      workspaceId: body.workspaceId as string,
      // Resolved, so a relative `cwd` cannot mean two directories. The
      // root-confinement check needs the workspace row, which is R1's; until
      // then a cwd outside the workspace is refused by the filesystem.
      cwd: resolve(body.cwd as string),
      ...(body.shell === undefined ? {} : { shell: body.shell }),
      ...(body.command === undefined ? {} : { command: body.command }),
      args: body.args ?? [],
      kind: "terminal",
      ...(body.nodeId === undefined ? {} : { ownerNodeId: body.nodeId }),
      ...(body.agent === undefined ? {} : { agentId: body.agent.id }),
      ...(body.ssh === undefined ? {} : { sshHostId: body.ssh.hostId }),
      env,
    });
    return { status: 200, body: session };
  });

  /* ---------------------------------- reads -------------------------------- */

  route("GET", "/api/terminals/backend", () => {
    const info: BackendInfo = {
      effective,
      configured,
      tmuxVersion: detection.version ?? null,
      tmuxSocket: tmux?.socket ?? null,
      reason: selection.reason ?? null,
      platform: process.platform === "win32" ? "windows" : "unix",
    };
    return { status: 200, body: info };
  });

  route("GET", "/api/terminals/{sessionId}", (params) => ({
    status: 200,
    body: manager.session(params.sessionId as string),
  }));

  route(
    "GET",
    "/api/terminals/{sessionId}/capture",
    async (params, request) => {
      const sessionId = params.sessionId as string;
      // The row is read first so an unknown session is a 404 rather than
      // "nothing is running", which is what a session that ended looks like.
      manager.session(sessionId);
      const lines = Math.min(
        positive(request.query.get("lines")) ?? DEFAULT_CAPTURE_LINES,
        MAX_CAPTURE_LINES,
      );
      const escapes = request.query.get("escapes") === "true";
      return {
        status: 200,
        body: await manager.capture(sessionId, lines, escapes),
      };
    },
  );

  route("GET", "/api/workspaces/{workspaceId}/sessions", (params) => ({
    status: 200,
    body: listSessions(
      context.db.database,
      params.workspaceId as string,
      (id) => manager.isAlive(id),
    ),
  }));

  /* ---------------------------------- writes ------------------------------- */

  route("POST", "/api/terminals/{sessionId}/paste", async (params, request) => {
    const sessionId = params.sessionId as string;
    const body = json<{ text?: unknown; enter?: unknown }>(request);
    if (typeof body?.text !== "string") {
      throw new TerminalError(400, "bad_request", "缺少 text");
    }
    if ([...body.text].length > MAX_PASTE_CHARACTERS) {
      throw new TerminalError(400, "bad_request", "Pasted text is too large");
    }
    // 页面上的「粘贴」是人在驱动，与键盘上来的字节同一条语义。
    await manager.paste(
      sessionId,
      body.text,
      body.enter === true,
      humanActor("local", ""),
    );
    return { status: 200, body: manager.session(sessionId) };
  });

  route(
    "POST",
    "/api/terminals/{sessionId}/scroll",
    async (params, request) => {
      const body = json<{ lines?: unknown }>(request);
      const lines =
        typeof body?.lines === "number" ? Math.trunc(body.lines) : NaN;
      if (!Number.isFinite(lines)) {
        throw new TerminalError(400, "bad_request", "缺少 lines");
      }
      if (Math.abs(lines) > MAX_SCROLL_LINES) {
        throw new TerminalError(
          400,
          "bad_request",
          "Scroll distance is too large",
        );
      }
      await manager.scroll(params.sessionId as string, lines);
      return { status: 204 };
    },
  );

  route(
    "POST",
    "/api/terminals/{sessionId}/terminate",
    async (params, request) => {
      const sessionId = params.sessionId as string;
      if (!manager.exists(sessionId)) {
        throw new TerminalError(404, "not_found", "没有这个终端会话");
      }
      let mode: TerminateMode = "process";
      if (request.body.byteLength > 0) {
        const parsed = json<{ mode?: TerminateMode }>(request);
        if (parsed?.mode !== undefined) mode = parsed.mode;
      }
      try {
        await manager.terminate(sessionId, mode);
      } catch (failure) {
        // A session that already finished is not an error for the caller.
        const alreadyOver =
          failure instanceof TerminalError &&
          failure.status === 404 &&
          manager.session(sessionId).status !== "running";
        if (!alreadyOver) throw failure;
      }
      return { status: 200, body: manager.session(sessionId) };
    },
  );

  route("POST", "/api/terminals/{sessionId}/recycle", async (params) => {
    const sessionId = params.sessionId as string;
    // The row, not the record: recycling a session this core never attached to
    // is a 404 about the session, not about the process behind it.
    manager.session(sessionId);
    return { status: 200, body: await manager.recycle(sessionId) };
  });

  /**
   * 人按节点头的「接管」/「交还」（设计 `agent-delivery.md` §6.1、§10）。
   *
   * 接管与抢占不是一回事，所以它需要一条自己的门而不是一次空写入：抢占是人
   * 敲键的副作用、十秒后自然过期；接管是一句明确的「现在归我」，Agent 一律
   * 收 `LEASE_REVOKED` 直到有人按「交还」。租约的变化由 `TerminalDriveBook`
   * 的 `onChange` 广播成一帧 `terminal.lease`，所以按下之后每台看着这块画布
   * 的设备都会同时翻徽标——不靠各自按「我刚点过」推断。
   */
  route("POST", "/api/terminals/{sessionId}/drive", (params, request) => {
    const sessionId = params.sessionId as string;
    manager.session(sessionId);
    const body = json<{ action?: unknown }>(request);
    const action = body?.action;
    if (action !== "takeover" && action !== "release") {
      throw new TerminalError(
        400,
        "bad_request",
        "action 只能是 takeover 或 release",
      );
    }
    const actor = humanActor("local", "");
    const lease =
      action === "takeover"
        ? manager.takeoverDrive(sessionId, actor)
        : manager.releaseDrive(sessionId, actor);
    return { status: 200, body: lease };
  });

  /* ---------------------------------- socket ------------------------------- */

  context.server.stream(
    "/api/terminals/{sessionId}/ws",
    (connection, params, request) => {
      const sessionId = params.sessionId as string;
      void serveTerminalSocket(connection, {
        manager,
        sessionId,
        writer: validWriter(request.query.get("writer")) ?? "",
        onError: (failure) =>
          context.log.warn("terminal socket", {
            sessionId,
            error: describe(failure),
          }),
      });
    },
    // Refused before the upgrade, the way the Rust face does it: an unknown
    // session is an HTTP 404, not a socket that opens and closes, and a
    // malformed `writer` is a 400 rather than a label nobody validated.
    async (params, request) => {
      // Behind the same gate as the routes: a socket that opened before the
      // adoption finished would be told its live pane is not running.
      await ready;
      if (!manager.exists(params.sessionId as string)) {
        return { status: 404, reason: "Not Found" };
      }
      if (validWriter(request.query.get("writer")) === undefined) {
        return { status: 400, reason: "Bad Request" };
      }
      return undefined;
    },
  );

  // The seam the agent domain published before this one was assembled. Until
  // it is handed a bridge, every verb that needs a pane — `context terminal`,
  // `canvas interrupt`, `canvas close`, the title suggestion, and every
  // scheduled delivery — refuses with "the terminal domain is not assembled",
  // on a canvas whose panes are running.
  setTerminalBridge(terminalBridge(manager, context.db.database));

  return {
    manager,
    backends,
    stop: async () => {
      // Withdrawn before the panes go: a verb that reached a bridge over a
      // manager that is shutting down would be told a session is missing
      // rather than that there is nothing to talk to.
      setTerminalBridge(undefined);
      await manager.shutdown();
    },
  };
}

/**
 * Writes the `armadra-hook` launcher and records where it went.
 *
 * Every terminal opened from the board is supposed to carry that directory at
 * the end of its PATH and the absolute path in `ARMADRA_HOOK_BIN` — the skill
 * tells the model to run the bare command and to fall back to the variable
 * when a shell profile has rewritten PATH. Neither was ever set, so
 * `armadra-hook` was `command not found` in every canvas terminal and none of
 * the three verb families could be reached: the hooks installed fine and were
 * unusable.
 *
 * It is done here rather than in the hook domain because of the order in
 * `DOMAINS`: hooks are assembled **last**, and by then this domain has already
 * built its backends — a tmux server started before the path was known would
 * carry the old PATH for as long as it lives. Writing the launcher is a pure
 * file operation with no service behind it, so doing it early costs nothing.
 *
 * No bundle on this box (a source checkout with no build) leaves it unset,
 * which is the truth; an empty `ARMADRA_HOOK_BIN` would point the skill's
 * fallback at a path that resolves to nothing.
 */
function publishHookClient(context: CoreContext): void {
  let path: string | undefined;
  try {
    path = launcherClientBinary({ dataDir: context.dataDir });
  } catch (error) {
    context.log.warn("could not write the armadra-hook launcher", {
      error: describe(error),
    });
  }
  setHookClient(path);
  if (path === undefined) {
    context.log.info("no armadra-hook bundle: the canvas verbs have no client");
  } else {
    context.log.debug("armadra-hook client", { path });
  }
}

/**
 * The SSH decorator, when this core has a remote domain to decorate with.
 *
 * `remoteDomain()` is `undefined` in the suites that install the terminal
 * domain alone. A missing remote domain is not an error: it means this build
 * has no askpass service and no host registry, so an SSH terminal could not be
 * started anyway, and the undecorated backend is exactly right. What must not
 * happen is the opposite — an `ssh` that silently runs a local shell — and
 * that cannot: `create` refuses an unknown host id rather than falling back.
 */
function wrapSsh(
  context: CoreContext,
  inner: TerminalBackend,
): TerminalBackend {
  const remote = remoteDomain();
  if (remote === undefined) return inner;
  return new SshBackend({
    dataDir: context.dataDir,
    inner,
    hosts: remote.host,
    askpass: remote.askpass,
  });
}

/* --------------------------------- sessions -------------------------------- */

export interface SessionSummary {
  readonly nodeId: string;
  readonly boardId: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly title: string;
  readonly cwd: string;
  readonly agentId?: string;
  readonly state?: string;
  readonly stateSource?: string;
  readonly unread: boolean;
  readonly pendingId?: string;
  readonly updatedAt: string;
  readonly alive: boolean;
}

/**
 * `GET /api/workspaces/{id}/sessions` — the Sessions panel's whole feed.
 *
 * Only node-owned sessions appear: the list is a list of *cards on a board*,
 * and a terminal with no node has none. `alive` is the one field that does not
 * come from the database — a row can say `running` while the process behind it
 * belongs to a core that is no longer here, and only the manager knows which.
 *
 * **One row per node.** A node accumulates a `terminal_sessions` row every
 * time it is restarted, recycled or reclaimed after a crash, and the packaged
 * build showed what listing all of them looks like: a Sessions panel where the
 * same node appears four times and three of them are dead. The panel's
 * question is "what is this node running *now*", which has exactly one answer
 * — so each node keeps the session that is alive, and failing that the newest
 * row, which is the one a reattach would pick up.
 *
 * `agent_status` is R3's table but exists in the schema from migration 0001
 * onwards, so the join is written now and simply finds nothing until then.
 */
export function listSessions(
  database: import("node:sqlite").DatabaseSync,
  workspaceId: string,
  alive: (sessionId: string) => boolean,
): SessionSummary[] {
  const rows = database
    .prepare(
      `SELECT s.id AS session_id, s.cwd AS cwd, s.owner_node_id AS node_id,
              s.agent_id AS session_agent_id, s.created_at AS created_at,
              n.board_id AS board_id, n.title AS title,
              st.agent_id AS status_agent_id, st.state AS state,
              st.state_source AS state_source, st.unread AS unread,
              st.pending_id AS pending_id, st.updated_at AS status_updated_at
         FROM terminal_sessions s
         JOIN nodes n ON n.id = s.owner_node_id
         LEFT JOIN agent_status st ON st.node_id = s.owner_node_id
        WHERE s.workspace_id = ? AND s.owner_node_id IS NOT NULL
        ORDER BY s.created_at DESC LIMIT 500`,
    )
    .all(workspaceId) as Record<string, unknown>[];
  // 行按 `created_at DESC` 来，所以每个节点第一次见到的就是最新那行；后面的只
  // 有在它活着而先前留下的那行已经死了的时候才顶掉它。
  const perNode = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const nodeId = String(row.node_id);
    const kept = perNode.get(nodeId);
    if (kept === undefined) {
      perNode.set(nodeId, row);
      continue;
    }
    if (!alive(String(kept.session_id)) && alive(String(row.session_id))) {
      perNode.set(nodeId, row);
    }
  }
  return [...perNode.values()].map((row) => {
    const sessionId = String(row.session_id);
    const agentId =
      (row.status_agent_id as string | null) ??
      (row.session_agent_id as string | null);
    const state = row.state as string | null;
    const stateSource = row.state_source as string | null;
    const pendingId = row.pending_id as string | null;
    return {
      nodeId: String(row.node_id),
      boardId: String(row.board_id),
      sessionId,
      kind: "terminal",
      title: String(row.title ?? ""),
      cwd: String(row.cwd),
      ...(agentId === null || agentId === undefined ? {} : { agentId }),
      ...(state === null ? {} : { state }),
      ...(stateSource === null ? {} : { stateSource }),
      unread: Number(row.unread ?? 0) !== 0,
      ...(pendingId === null ? {} : { pendingId }),
      updatedAt: String(
        (row.status_updated_at as string | null) ?? row.created_at,
      ),
      alive: alive(sessionId),
    };
  });
}

/* ---------------------------------- helpers -------------------------------- */

interface Answer {
  readonly status: number;
  readonly body?: unknown;
}

interface CreateTerminalRequest {
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly nodeId?: string;
  readonly agent?: { readonly id: string };
  /**
   * `ssh: { hostId }` — the session runs `ssh …` instead of a shell.
   *
   * **Only the id travels.** Everything else comes from
   * `settings.ssh.hosts[]`, so a client can never dictate the command line,
   * and an unknown id is refused by the backend rather than quietly falling
   * back to a local shell.
   */
  readonly ssh?: { readonly hostId?: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateCreate(body: CreateTerminalRequest): string | undefined {
  if (typeof body?.workspaceId !== "string" || body.workspaceId === "") {
    return "缺少 workspaceId";
  }
  if (typeof body.cwd !== "string" || body.cwd === "") return "缺少 cwd";
  if (body.nodeId !== undefined && !UUID.test(body.nodeId)) {
    return "Terminal node id is invalid";
  }
  if (body.agent !== undefined && body.nodeId === undefined) {
    // Without a node there is nothing to attribute hook reports to, and the
    // hook client would refuse to report anyway.
    return "An agent terminal requires the owning nodeId";
  }
  if (
    body.ssh !== undefined &&
    (typeof body.ssh.hostId !== "string" || body.ssh.hostId === "")
  ) {
    return "Unknown SSH host";
  }
  return undefined;
}

function json<T>(request: import("../http/router").CoreRequest): T {
  try {
    return request.json<T>();
  } catch {
    throw new TerminalError(400, "bad_request", "请求体不是 JSON");
  }
}

function positive(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** A backend failure, in the one error shape the core has (contract §5.1). */
function error(failure: unknown): {
  status: number;
  body: { code: string; message: string };
} {
  if (failure instanceof TerminalError) {
    return {
      status: failure.status,
      body: { code: failure.code, message: failure.message },
    };
  }
  return {
    status: 500,
    body: { code: "internal", message: describe(failure) },
  };
}

/** Typed asserted by `install`; `CoreContext` is the only thing it needs. */
export type { CoreContext };
