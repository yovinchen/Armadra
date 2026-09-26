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
import { nodeRole } from "../canvas/context-links";
import { handleForNode } from "../canvas/handles";
import { type EnvPairs, agentEnvironment, setHookClient } from "./environment";
import { launcherClientBinary } from "../hook/install/shared";
import { collab, setTerminalBridge } from "../agent";
import { canvasEnvironment, nodeDialect } from "../agent/canvas-launch";
import type { ShellDialect } from "./shell";
import { listAgents } from "../agent/list";
import { baseAgent } from "../agent/registry";
import { parseCustomAgents } from "../settings/custom-agents";
import {
  HIBERNATE_INTERVAL_MS,
  ecoPolicy,
  ecoTestOverride,
  hibernatedSession,
  setHibernationWaker,
} from "./hibernate";
import { Hibernator } from "./hibernator";
import { setAgentLauncher } from "../schedule/cold-start";
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
  readonly hibernator: Hibernator;
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

  // The agent's four address variables, when a node owns this terminal. The
  // per-node token is *minted* here and never travels here: it goes into
  // `<data>/node-tokens/<nodeId>`, 0600, because any process of the same
  // user can read another process' environment (contract §5 item 5).
  //
  // Shared by the route and the scheduler's cold start: a session the core
  // starts on its own has to report exactly like one the page started, or the
  // delivery gate would wait for a status that never comes.
  // 自定义 Agent 的注册表每次现读：设置里刚加的条目下一次启动就认得。
  const agentSettings = () =>
    collab()?.settings ?? {
      customAgents: () =>
        parseCustomAgents(settingsDomain()?.settings.snapshot() ?? {}),
    };
  // `dialect`：这个终端要跑的 shell 的方言。Codex 那两个由启动行展开的环境变
  // 量要按它写（`hook/install/inject.ts::codexTomlString`）。
  const ownedEnvironment = (
    nodeId: string,
    agentId: string,
    dialect: ShellDialect,
  ) => {
    try {
      issueNodeToken(context.dataDir, nodeId);
    } catch (failure) {
      // A token we could not write downgrades every report from this
      // terminal to `legacy`; it must not stop the terminal opening.
      context.log.warn("could not mint the node token", {
        nodeId,
        error: failure instanceof Error ? failure.message : String(failure),
      });
    }
    return [
      ...agentEnvironment(
        nodeId,
        agentId,
        context.dataDir,
        handleForNode(context.db.database, nodeId),
        nodeRole(context.db.database, nodeId),
      ),
      // Contract §5.5: the one variable that switches the hook client from
      // "report and exit" to "wait for the canvas' answer".
      ...permissionWaitEnvironment(
        agentId,
        settingsDomain()?.settings.get("hooks.replyApprovals") !== false,
        (id) => baseAgent(agentSettings(), id),
      ),
      // 画布注入的环境半边（OpenCode 的配置目录、Copilot 的说明目录）；也是
      // 注入产物确保为最新的时刻——这个终端就要起这个 CLI 了。
      ...canvasEnvironment(
        agentSettings(),
        context.dataDir,
        agentId,
        nodeId,
        (message, fields) => context.log.warn(message, fields),
        dialect,
      ),
    ];
  };

  /* ------------------------------ Eco 休眠 -------------------------------- */

  // 终端宿主设计 §7.2。设置每次现读：开关与阈值改了下一轮巡检就生效。
  // 探针的秒级阈值（`hibernate.ts::ecoTestOverride`）：开关仍听设置的。
  const ecoOverride = ecoTestOverride();
  const hibernator = new Hibernator({
    database: context.db.database,
    manager,
    settings: agentSettings,
    policy: () => {
      const policy = ecoPolicy(
        (path) => settingsDomain()?.settings.get(path) ?? undefined,
      );
      return ecoOverride === undefined
        ? policy
        : { ...policy, idleMinutes: ecoOverride.idleMinutes };
    },
    environment: (nodeId, agentId, dialect) =>
      ownedEnvironment(nodeId, agentId, dialect),
    // 与依赖编排拼启动行时同一个来源：本机解析到的程序路径；画布注入的 argv
    // 由恢复行经 `agent/canvas-launch.ts` 从数据目录取。
    program: (agentId) => {
      try {
        const row = listAgents({
          dataDir: context.dataDir,
          settings: agentSettings(),
        }).find((entry) => entry.id === agentId);
        return { path: row?.resolvedPath ?? undefined };
      } catch {
        return {};
      }
    },
    dataDir: context.dataDir,
    publish: (workspaceId, event) => {
      context.bus.emit("workspace.event", { workspaceId, event });
    },
    nudge: (nodeId) => collab()?.nudge?.(nodeId),
    log: (message, fields) => context.log.info(message, fields),
  });
  setHibernationWaker((nodeId, reason) => hibernator.wake(nodeId, reason));
  const hibernateTimer = setInterval(() => {
    void ready
      .then(() => hibernator.tick())
      .catch((failure: unknown) => {
        context.log.warn("Eco 休眠巡检失败", { error: describe(failure) });
      });
  }, ecoOverride?.intervalMs ?? HIBERNATE_INTERVAL_MS);
  hibernateTimer.unref?.();

  route("POST", "/api/terminals", async (_params, request) => {
    const body = json<CreateTerminalRequest>(request);
    const invalid = validateCreate(body);
    if (invalid !== undefined) {
      throw new TerminalError(400, "bad_request", invalid);
    }
    const owned = body.agent !== undefined && body.nodeId !== undefined;
    const env = owned
      ? ownedEnvironment(
          body.nodeId as string,
          (body.agent as { id: string }).id,
          nodeDialect(body.shell, body.ssh !== undefined),
        )
      : [];
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
   * 页面上点了（或聚焦了）一个休眠中的节点：用 CLI 自己的 resume 在同一个会话
   * id 上接回来（终端宿主设计 §7.2）。已经醒着就答它现在的样子——两台设备同时
   * 点、或者投递先一步叫醒了它，都不会起第二个 CLI。
   */
  route("POST", "/api/terminals/{sessionId}/wake", async (params) => {
    const sessionId = params.sessionId as string;
    const row = manager.session(sessionId);
    if (row.ownerNodeId === null) {
      throw new TerminalError(
        409,
        "not_hibernated",
        "This terminal does not belong to a node",
      );
    }
    const woken = await hibernator.wake(row.ownerNodeId, "focus");
    return { status: 200, body: manager.session(woken.sessionId) };
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
    // 「谁在交还」不是「谁按了按钮」。人的抢占是**敲键那一侧**记下的，持有者
    // 于是是那条 socket 的设备 id，而按钮来自同一个人的另一条路（HTTP）。按
    // `local` 去交还会被状态机当成「放别人的租约」而拒绝，于是按钮一按什么都
    // 不发生——真机上就是这么撞出来的。所以这里认的是**当前持有者**：这台壳
    // 前面只有一个人，他敲键与他按钮是同一个人。Agent 的租约不在此列，它仍然
    // 只能由 Agent 自己放掉，或者由人「接管」撤销。
    const held = manager.driveLease(sessionId).holder;
    const actor =
      held?.kind === "human"
        ? humanActor(held.id, held.displayName)
        : humanActor("local", "");
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
  setTerminalBridge({
    ...terminalBridge(manager, context.db.database),
    // 投给休眠节点的消息：先叫醒再走 `send` 的整条门链（§7.2）。不是休眠着的
    // 节点立刻答 `false`，只多一次库查询。
    wakeNode: async (nodeId) => {
      await ready;
      if (hibernatedSession(context.db.database, nodeId) === undefined) {
        return false;
      }
      await hibernator.wake(nodeId, "delivery");
      return true;
    },
    // 休眠着或正在接回：`send` 的门链把这段时间的「没有会话」当「还早」排队。
    sleeping: (nodeId) => hibernator.sleeping(nodeId),
    // 依赖编排在页面没开时替节点起终端（Agent 自动化设计 §6）。与
    // `POST /api/terminals` 同一套环境与令牌，只是请求来自 core 自己。
    spawnForNode: async (request) => {
      await ready;
      const session = await manager.spawn({
        workspaceId: request.workspaceId,
        cwd: resolve(request.cwd),
        ...(request.shell === undefined ? {} : { shell: request.shell }),
        args: [],
        kind: "terminal",
        ownerNodeId: request.nodeId,
        agentId: request.agentId,
        ...(request.sshHostId === undefined
          ? {}
          : { sshHostId: request.sshHostId }),
        env: ownedEnvironment(
          request.nodeId,
          request.agentId,
          nodeDialect(request.shell, request.sshHostId !== undefined),
        ),
      });
      return { sessionId: session.id, generation: session.generation };
    },
  });
  // 定时任务的冷启动（自动化设计 §4.2）：同一条建会话的路，外加敲一行启动行。
  setAgentLauncher(async (request) => {
    const session = await manager.spawn({
      workspaceId: request.workspaceId,
      cwd: resolve(request.cwd),
      args: [],
      kind: "terminal",
      ownerNodeId: request.nodeId,
      agentId: request.agentId,
      // 冷启动起的是本机缺省的 shell，启动行（`schedule/cold-start.ts`）也按它写。
      env: ownedEnvironment(
        request.nodeId,
        request.agentId,
        nodeDialect(undefined),
      ),
    });
    void typeLaunchLine(
      manager,
      session.id,
      session.generation,
      request.line,
    ).catch((failure: unknown) => {
      context.log.warn("could not type the cold-start launch line", {
        nodeId: request.nodeId,
        error: failure instanceof Error ? failure.message : String(failure),
      });
    });
    return { sessionId: session.id, generation: session.generation };
  });

  return {
    manager,
    backends,
    hibernator,
    stop: async () => {
      // Withdrawn before the panes go: a verb that reached a bridge over a
      // manager that is shutting down would be told a session is missing
      // rather than that there is nothing to talk to.
      setTerminalBridge(undefined);
      setAgentLauncher(undefined);
      setHibernationWaker(undefined);
      clearInterval(hibernateTimer);
      await manager.shutdown();
    },
  };
}

/** How long a fresh shell may stay silent before the launch line goes in anyway. */
const LAUNCH_COLD_MS = 3_000;
/** How long its output has to settle once it has said something. */
const LAUNCH_QUIET_MS = 400;
const LAUNCH_POLL_MS = 100;

/**
 * 在一个刚起的 shell 里敲启动行——页面挂载终端节点时做的同一件事
 * （`apps/web/src/terminal/surface/use-launch.ts`）：等提示符画完、安静下来再
 * 敲；一直不出声就在冷启动上限到了之后照敲。敲早了，有些 shell 的初始化会把
 * 预输入的字吞掉。
 */
async function typeLaunchLine(
  manager: TerminalManager,
  sessionId: string,
  generation: number,
  line: string,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
    const activity = manager.observedActivity(sessionId);
    if (activity === undefined) return;
    const now = Date.now();
    const last = activity.lastOutputAt;
    if (last !== undefined && now - last >= LAUNCH_QUIET_MS) break;
    if (now - started >= LAUNCH_COLD_MS) break;
  }
  await manager.input(sessionId, generation, `${line}\r`);
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
    remote: (hostId, env) => remote.integration.terminal(hostId, env),
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
