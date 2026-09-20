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
 * ## What is not here, and why
 *
 * **A remote workspace answers `unsupported`, per language, with a reason.**
 * The Rust Runtime reaches a remote language server over a *second* `ssh`
 * connection to `armadra-runtime worker`, carrying protobuf `LanguageFrame`s
 * with a credit window and a link epoch (the pre-merge implementation).
 * The core's remote domain (`core/remote`) brings up the control connection
 * and its version handshake, but the Worker *service* surface those frames
 * ride on is not connected yet — `registerRoot`, `listDirectory` and the
 * rest are still unimplemented there. Three things are missing before the
 * remote path can be written:
 *
 *   1. a framed, full-duplex channel on top of `core/remote`'s stdio frames
 *      that is not the serial request/response queue the control connection
 *      is;
 *   2. the Worker side of `language.link.v1` — the capability the second
 *      connection must advertise before a frame is written;
 *   3. the link epoch and credit window, so a connection that dies marks its
 *      sessions `disconnected` instead of delivering an in-flight answer to
 *      the session that replaced them.
 *
 * Until then `language-service` lists every language as `unsupported` with
 * `link_lost`, and `POST …/language/sessions` refuses with the same reason,
 * which is honest in a way that a silently empty panel is not.
 */

import type { WorkspaceEvent } from "../bus";
import type { CoreContext } from "../main";
import { VERSION } from "../instance";
import { settingsDomain } from "../settings";
import { answered, workspaceId } from "../workspaces/routes";
import { internalError } from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import type { AppliedFile } from "./edits";
import type { HubEvents } from "./mux";
import { Manager } from "./lifecycle";
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
    answered((match, request) => ({
      status: 200,
      body: applyEdit(
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

  assembled = {
    manager,
    stop: () => manager.shutdown(),
  };
  return assembled;
}
