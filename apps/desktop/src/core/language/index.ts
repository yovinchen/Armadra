/**
 * The language-service domain: seven phase-5 routes, one session socket, and
 * the `Manager` behind them.
 *
 * ## What is here
 *
 * Everything an execution host does for LSP when that host is *this machine*:
 * discovery by `--version`, one process per `(workspace, server)`, one session
 * per browser connection, shadow documents, the method allowlist, and the
 * `WorkspaceEdit` apply. `apps/web/src/editor/language/*` is the client and is
 * unchanged — it speaks the same seven routes and the same raw JSON-RPC text
 * frames it always did.
 *
 * ## A remote workspace
 *
 * Its servers run on the execution host, under a second Worker reached over
 * its own `ssh` connection (`worker --stdio --language-link`, see
 * `remote/language.ts` for why a second connection rather than multiplexing
 * the control one). The routes here authorise exactly as they do locally and
 * then hand the same request to that link (`remote.ts`); the session socket
 * carries text both ways as before. When the link drops, every session on that
 * host is told `disconnected / link_lost` and its socket is closed, so the
 * editor's transport reconnects and the next session brings the link back.
 * A workspace that moves to another host mid-session hears it through
 * `workspace.grants` and stops the servers on its old root.
 */

import type { WorkspaceEvent } from "../bus";
import type { CoreContext } from "../main";
import { VERSION } from "../instance";
import { settingsDomain } from "../settings";
import { workspaceId } from "../workspaces/routes";
import { internalError } from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import type { AppliedFile } from "./edits";
import type { HubEvents } from "./mux";
import { Manager } from "./lifecycle";
import { remoteLanguage } from "./remote";
import {
  SessionSockets,
  answeredAsync,
  applyEdit,
  attachSessionSocket,
  closeSession,
  controlServer,
  languageService,
  openSession,
  sessionGuard,
  type LanguageRouteDeps,
} from "./routes";

export { Manager } from "./lifecycle";
export { languageIdFor } from "./registry";

export const LANGUAGE_SERVICE_PATH =
  "/api/workspaces/{workspaceId}/language-service";
export const SESSIONS_PATH = "/api/workspaces/{workspaceId}/language/sessions";
export const SESSION_PATH =
  "/api/workspaces/{workspaceId}/language/sessions/{sessionId}";
export const SESSION_STREAM_PATH = `${SESSION_PATH}/stream`;
export const SESSION_EDITS_PATH = `${SESSION_PATH}/edits`;
export const SERVER_RESTART_PATH =
  "/api/workspaces/{workspaceId}/language/servers/{serverId}/restart";
export const SERVER_STOP_PATH =
  "/api/workspaces/{workspaceId}/language/servers/{serverId}/stop";

export interface LanguageDomain {
  readonly manager: Manager;
  stop(): Promise<void>;
}

let assembled: LanguageDomain | undefined;

/**
 * The manager of the running core, for the resource panel — a language server
 * is an ordinary child process and only this domain can say which pids are
 * ones.
 */
export function languageDomain(): LanguageDomain | undefined {
  return assembled;
}

export function install(context: CoreContext): LanguageDomain {
  const settings = settingsDomain()?.settings;
  if (settings === undefined) {
    // `installSettings` runs before this one in `DOMAINS`; a core assembled
    // without it would probe against defaults and silently ignore every
    // override, which is worse than refusing to assemble.
    throw internalError("the language domain needs the settings store");
  }
  const database = context.db.database;

  /**
   * One frame on the workspace stream.
   *
   * The payload is built as a plain record and cast once here: the bus carries
   * a `WorkspaceEvent` union whose language members hold `OpaquePayload`
   * values, and a readonly descriptor is not one by assignment. The shape is
   * checked where it is built — against the pre-merge implementation, field
   * for field — rather than by the union, which deliberately does not describe
   * a server descriptor.
   */
  const publish = (
    targetWorkspaceId: string,
    event: Record<string, unknown>,
  ): void => {
    context.bus.emit("workspace.event", {
      workspaceId: targetWorkspaceId,
      event: event as unknown as WorkspaceEvent,
    });
  };

  const events = (targetWorkspaceId: string): HubEvents => ({
    session: (event) =>
      publish(targetWorkspaceId, {
        type: "language.session",
        workspaceId: targetWorkspaceId,
        ...event,
      }),
    server: (event) =>
      publish(targetWorkspaceId, {
        type: "language.server",
        workspaceId: targetWorkspaceId,
        executionHostId: "local",
        server: event.server,
        ...(event.stderrTail === undefined
          ? {}
          : { stderrTail: event.stderrTail }),
      }),
    fileChanged: (file) => fileChanged(targetWorkspaceId, file),
  });

  const fileChanged = (targetWorkspaceId: string, file: AppliedFile): void => {
    publish(targetWorkspaceId, {
      type: "file.changed",
      workspaceId: targetWorkspaceId,
      path: file.path,
      kind: "modified",
      sha256: file.sha256,
      size: file.size,
      mtime: new Date().toISOString(),
    });
  };

  const manager = new Manager({ settings, events, version: VERSION });
  // 远端工作空间的服务器状态由那台机器推来，经同一条事件流发出去。
  remoteLanguage.attachSink({ publish, fileChanged });
  const sockets = new SessionSockets(manager);
  const deps: LanguageRouteDeps = {
    manager,
    settings,
    workspace: (id) => getWorkspace(database, id),
    fileChanged,
  };

  const { router } = context.server;

  router.handle(
    "GET",
    LANGUAGE_SERVICE_PATH,
    answeredAsync(async (match, request) => {
      const refresh = request.query.get("refresh");
      return {
        status: 200,
        body: await languageService(
          deps,
          workspaceId(match),
          refresh === "1" || refresh === "true",
        ),
      };
    }),
  );

  router.handle(
    "POST",
    SESSIONS_PATH,
    answeredAsync(async (match, request) => ({
      status: 200,
      body: await openSession(deps, sockets, workspaceId(match), request),
    })),
  );

  router.handle(
    "DELETE",
    SESSION_PATH,
    answeredAsync(async (match) => ({
      status: 200,
      body: await closeSession(
        deps,
        sockets,
        workspaceId(match),
        match.params.sessionId ?? "",
      ),
    })),
  );

  router.handle(
    "POST",
    SESSION_EDITS_PATH,
    answeredAsync(async (match, request) => ({
      status: 200,
      body: await applyEdit(
        deps,
        workspaceId(match),
        match.params.sessionId ?? "",
        request,
      ),
    })),
  );

  router.handle(
    "POST",
    SERVER_RESTART_PATH,
    answeredAsync(async (match) => ({
      status: 200,
      body: await controlServer(
        deps,
        workspaceId(match),
        match.params.serverId ?? "",
        "restart",
      ),
    })),
  );

  router.handle(
    "POST",
    SERVER_STOP_PATH,
    answeredAsync(async (match) => ({
      status: 200,
      body: await controlServer(
        deps,
        workspaceId(match),
        match.params.serverId ?? "",
        "stop",
      ),
    })),
  );

  context.server.stream(
    SESSION_STREAM_PATH,
    (socket, params) => {
      attachSessionSocket(
        deps,
        sockets,
        socket,
        params.workspaceId ?? "",
        params.sessionId ?? "",
      );
    },
    // Before the upgrade, exactly as the Rust route does: a session that does
    // not exist is an HTTP 404, not a socket that opens and closes.
    (params) => sessionGuard(deps, sockets, params),
  );

  // 失去 execute（或工作区被删）就立刻停掉它的语言服务器（设计 §1.3）：进程是
  // 按旧授权起的，等空闲清扫就等于在撤销之后还让它跑上好几分钟。
  const offGrants = context.bus.on("workspace.grants", (change) => {
    void Promise.all([
      manager.applyGrants(
        change.workspaceId,
        change.permissions,
        change.executionHostId,
      ),
      remoteLanguage.grants(change.workspaceId, change.permissions),
    ]).catch((error: unknown) =>
      context.log.warn("could not apply language grants", {
        workspaceId: change.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });

  assembled = {
    manager,
    stop: () => {
      offGrants();
      remoteLanguage.attachSink(undefined);
      return manager.shutdown();
    },
  };
  return assembled;
}
