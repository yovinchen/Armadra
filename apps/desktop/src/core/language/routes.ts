/**
 * `/api/workspaces/{id}/language*` — the core ↔ web surface (design §2.9).
 *
 * The controller does not parse LSP. It authorises, it routes, and it moves
 * text frames; every decision about *what* a message may do is taken on the
 * execution host, which for a local workspace is this process.
 *
 * The session socket is its own WebSocket rather than the workspace event
 * stream: that stream is one-directional by design, and a session has to send.
 * Session *status* still goes on the event stream, so the status line and the
 * settings page follow a server without opening a socket.
 */

import type { WebSocket } from "ws";

import type { CoreRequest, RouteMatch } from "../http/router";
import type { HandlerResult } from "../http/router";
import {
  DomainError,
  badRequest,
  conflict,
  forbidden,
  jsonObject,
  notFound,
  optionalString,
  requiredString,
} from "../workspaces/support";
import { getWorkspace, type Workspace } from "../workspaces/table";
import type { SettingsStore } from "../settings";
import { discover } from "./discover";
import {
  applyEdits,
  dirtyFiles,
  parseEdit,
  type ApplyResult,
  type AppliedFile,
} from "./edits";
import type { JsonObject, JsonValue } from "./jsonrpc";
import { reason } from "./limits";
import type { Manager } from "./lifecycle";
import { handleSessionMessage } from "./session";
import {
  languages,
  type Control,
  type LanguageServiceStatus,
  type ServerDescriptor,
} from "./registry";

export interface LanguageRouteDeps {
  readonly manager: Manager;
  readonly settings: SettingsStore;
  /** A workspace row, or the 404 the Rust route answers. */
  readonly workspace: (workspaceId: string) => Workspace;
  /** Publishes one `file.changed` for a write this domain made. */
  readonly fileChanged: (workspaceId: string, file: AppliedFile) => void;
}

/**
 * Whether this workspace's files — and therefore its servers — live on another
 * machine.
 *
 * `crate::remote::resolve` reads it the same way: an empty execution host id is
 * this machine, anything else is a Worker over `ssh`.
 */
function isRemote(workspace: Workspace): boolean {
  return (workspace.executionHostId ?? "") !== "";
}

/**
 * The answer for a language request on a remote workspace: 501 with the stable
 * reason key, so the editor degrades to plain editing and says why.
 */
function unsupportedRemote(): DomainError {
  return new DomainError(501, "unsupported", reason.UNSUPPORTED_REMOTE);
}

function readable(deps: LanguageRouteDeps, workspaceId: string): Workspace {
  const workspace = deps.workspace(workspaceId);
  if (!workspace.permissions.read) {
    throw forbidden("This workspace is not readable");
  }
  return workspace;
}

/**
 * What the client is told the servers run on. Empty means this machine, and
 * the interface has one word for that.
 */
function executionHostId(workspace: Workspace): string {
  const hostId = workspace.executionHostId ?? "";
  return hostId === "" ? "local" : hostId;
}

/* ------------------------------- discovery -------------------------------- */

/**
 * `GET /api/workspaces/{id}/language-service`
 *
 * Rows are listed whatever the answer is. A workspace with no execute grant
 * still gets one row per language, each `unsupported / execution_not_granted`
 * — the settings page has to be able to say *what* is missing, and an empty
 * panel says nothing.
 */
export async function languageService(
  deps: LanguageRouteDeps,
  workspaceId: string,
  refresh: boolean,
): Promise<LanguageServiceStatus> {
  const workspace = readable(deps, workspaceId);
  const allowExecute = workspace.permissions.execute;
  if (isRemote(workspace)) {
    // Every row, and every row unsupported: see `remoteRows` for what is
    // missing before this can be a real answer.
    return {
      status: "unavailable",
      reason: reason.UNSUPPORTED_REMOTE,
      executionHostId: executionHostId(workspace),
      servers: remoteRows(),
    };
  }
  const servers = await discover(
    deps.settings,
    "local",
    allowExecute,
    refresh,
    true,
  );
  // A server that is actually running says so, over whatever the probe cached:
  // the probe answers "could this start", the hub answers "is it".
  const live = new Map(
    deps.manager
      .hubsFor(workspaceId)
      .map((hub) => [hub.serverId, hub.descriptor()]),
  );
  const rows = servers.map((row) => {
    const running = live.get(row.serverId);
    if (running === undefined) return row;
    const merged: ServerDescriptor = {
      ...row,
      state: running.state,
      restartCount: running.restartCount,
      pid: running.pid,
      startTimeUnixMs: running.startTimeUnixMs,
      openDocuments: running.openDocuments,
      ...(running.features.length > 0 ? { features: running.features } : {}),
    };
    return running.reason === undefined
      ? withoutReason(merged)
      : { ...merged, reason: running.reason };
  });
  const usable = rows.some((row) => row.state !== "unsupported");
  return {
    status: usable ? "available" : "unavailable",
    ...(usable
      ? {}
      : {
          reason: allowExecute
            ? reason.SERVER_NOT_FOUND
            : reason.EXECUTION_NOT_GRANTED,
        }),
    executionHostId: executionHostId(workspace),
    servers: rows,
  };
}

function withoutReason(descriptor: ServerDescriptor): ServerDescriptor {
  const { reason: _omitted, ...rest } = descriptor;
  return rest;
}

/**
 * One `unsupported` row per language for a workspace whose files are on
 * another machine.
 *
 * The remote language link is meant to be a second `ssh` connection carrying
 * JSON-RPC frames to a Worker that runs the servers there
 * (`worker --stdio --language-link`). The Worker's control connection now
 * executes files and Git on the execution host, but it refuses the language
 * link outright: carrying a server's stream needs its own framing, lifetime
 * and restart rules, and none of them exist yet. So every row says
 * `unsupported_remote` — a stable key the settings page translates — rather
 * than `link_lost`, which would promise that reconnecting could help.
 * Answering rows rather than an error is deliberate: the settings page still
 * lists every language and says, per language, that it is unavailable here.
 */
function remoteRows(): ServerDescriptor[] {
  const rows: ServerDescriptor[] = [];
  for (const entry of languages()) {
    const candidate = entry.candidates[0];
    if (candidate === undefined) continue;
    rows.push({
      serverId: candidate.serverId,
      languageId: entry.languageId,
      fileExtensions: [...entry.extensions],
      executable: "",
      version: "",
      state: "unsupported",
      reason: reason.UNSUPPORTED_REMOTE,
      features: [...candidate.features],
      restartCount: 0,
      pid: null,
      startTimeUnixMs: null,
      openDocuments: 0,
      probedAtUnixMs: 0,
    });
  }
  return rows;
}

/* -------------------------------- sessions -------------------------------- */

export interface OpenSessionResponse {
  readonly sessionId: string;
  readonly generation: number;
  readonly serverId: string;
  readonly state: string;
  readonly reason?: string;
  readonly serverCapabilities?: JsonValue;
}

/**
 * Sockets that have been opened but not yet connected.
 *
 * `POST` creates a session and `GET …/stream` connects it; between the two,
 * the server may already be publishing diagnostics. Holding the frames here
 * means those arrive when the socket opens instead of being dropped.
 */
interface Parked {
  readonly workspaceId: string;
  readonly queue: Buffer[];
  /** Set once the socket attaches; the queue is flushed into it. */
  socket: WebSocket | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** A session with no socket after this long is closed like any other. */
const PARK_TIMEOUT_MS = 60_000;

export class SessionSockets {
  private readonly parked = new Map<string, Parked>();
  private readonly manager: Manager;

  constructor(manager: Manager) {
    this.manager = manager;
  }

  /** The sink a new session writes into, before and after the socket exists. */
  park(workspaceId: string): {
    outbox: (body: Buffer) => void;
    attach: (sessionId: string) => void;
  } {
    const entry: Parked = {
      workspaceId,
      queue: [],
      socket: undefined,
      timer: undefined,
    };
    return {
      outbox: (body) => {
        if (entry.socket !== undefined) {
          entry.socket.send(body.toString("utf8"));
          return;
        }
        entry.queue.push(body);
      },
      attach: (sessionId) => {
        this.parked.set(sessionId, entry);
        entry.timer = setTimeout(() => {
          // A session nobody ever connects would hold a server open forever.
          if (this.parked.get(sessionId) !== entry) return;
          if (entry.socket !== undefined) return;
          this.parked.delete(sessionId);
          void this.manager.closeSession(workspaceId, sessionId);
        }, PARK_TIMEOUT_MS);
        entry.timer.unref?.();
      },
    };
  }

  has(sessionId: string): boolean {
    return this.parked.has(sessionId);
  }

  /**
   * Connects a socket to a parked session, or `false` when there is no such
   * session — or when it already has one.
   */
  connect(sessionId: string, socket: WebSocket): boolean {
    const entry = this.parked.get(sessionId);
    if (entry === undefined || entry.socket !== undefined) return false;
    entry.socket = socket;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    for (const body of entry.queue.splice(0))
      socket.send(body.toString("utf8"));
    return true;
  }

  release(sessionId: string): void {
    const entry = this.parked.get(sessionId);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    this.parked.delete(sessionId);
  }
}

/** `POST /api/workspaces/{id}/language/sessions` */
export async function openSession(
  deps: LanguageRouteDeps,
  sockets: SessionSockets,
  workspaceId: string,
  request: CoreRequest,
): Promise<OpenSessionResponse> {
  const workspace = readable(deps, workspaceId);
  const body = jsonObject(request.body);
  const languageId = requiredString(body, "languageId");
  const clientId = optionalString(body, "clientId") ?? "";
  if (isRemote(workspace)) {
    throw unsupportedRemote();
  }
  const { outbox, attach } = sockets.park(workspaceId);
  const opened = await deps.manager.openSession({
    workspaceId,
    root: workspace.rootPath,
    languageId,
    clientId,
    allowWrite: workspace.permissions.write,
    allowExecute: workspace.permissions.execute,
    outbox,
  });
  attach(opened.sessionId);
  return {
    sessionId: opened.sessionId,
    generation: opened.generation,
    serverId: opened.serverId,
    state: opened.state,
    ...(opened.reason === undefined ? {} : { reason: opened.reason }),
    ...(opened.capabilities === null
      ? {}
      : { serverCapabilities: opened.capabilities }),
  };
}

/** `DELETE /api/workspaces/{id}/language/sessions/{sessionId}` */
export async function closeSession(
  deps: LanguageRouteDeps,
  sockets: SessionSockets,
  workspaceId: string,
  sessionId: string,
): Promise<{ closed: boolean }> {
  readable(deps, workspaceId);
  const closed = await deps.manager.closeSession(workspaceId, sessionId);
  sockets.release(sessionId);
  return { closed };
}

/* ---------------------------------- edits --------------------------------- */

/** `POST /api/workspaces/{id}/language/sessions/{sessionId}/edits` */
export function applyEdit(
  deps: LanguageRouteDeps,
  workspaceId: string,
  sessionId: string,
  request: CoreRequest,
): ApplyResult {
  const workspace = deps.workspace(workspaceId);
  if (!workspace.permissions.write) {
    throw forbidden("This workspace is opened read-only");
  }
  if (isRemote(workspace)) throw notFound("No such language session");
  const body = jsonObject(request.body);
  const edit = body["edit"] as JsonValue | undefined;
  const expected = expectedVersions(body["expectedSha256"]);
  const hub = deps.manager.hubOfSession(workspaceId, sessionId);
  if (hub === undefined) throw notFound("No such language session");
  const files = parseEdit(edit ?? null, hub.rewriter);
  // A file with unsaved changes is not overwritten. The dialog lists them and
  // the user decides; nothing here silently discards a draft.
  const dirty = dirtyFiles(files, hub.documents, hub.rewriter);
  if (dirty.length > 0) {
    throw conflict(
      `Save these files before applying the edit: ${dirty.join(", ")}`,
    );
  }
  return applyEdits(workspace.rootPath, files, expected, (file) =>
    deps.fileChanged(workspaceId, file),
  );
}

function expectedVersions(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("expectedSha256 must be an object");
  }
  const versions: Record<string, string> = {};
  for (const [path, digest] of Object.entries(value as JsonObject)) {
    if (typeof digest !== "string") {
      throw badRequest("expectedSha256 values must be strings");
    }
    versions[path] = digest;
  }
  return versions;
}

/* ------------------------------ manual control ---------------------------- */

/**
 * `POST /api/workspaces/{id}/language/servers/{serverId}/{restart,stop}`
 *
 * Restart needs the execute grant, because it starts a process. Stop does not:
 * ending something is never the dangerous direction.
 */
export async function controlServer(
  deps: LanguageRouteDeps,
  workspaceId: string,
  serverId: string,
  action: Control,
): Promise<ServerDescriptor> {
  const workspace = readable(deps, workspaceId);
  if (action === "restart" && !workspace.permissions.execute) {
    throw forbidden(reason.EXECUTION_NOT_GRANTED);
  }
  if (isRemote(workspace)) throw unsupportedRemote();
  if (action === "stop") {
    await deps.manager.stop(workspaceId, serverId);
  } else {
    await deps.manager.restart(workspaceId, serverId);
  }
  const hub = deps.manager.hub(workspaceId, serverId);
  if (hub === undefined) throw notFound("No such language server");
  return hub.descriptor();
}

/* --------------------------------- the socket ------------------------------ */

/**
 * `GET /api/workspaces/{id}/language/sessions/{sessionId}/stream` (WebSocket)
 *
 * One text frame is one JSON-RPC message. The controller only forwards: it
 * does not read the payload, and it does not log it.
 *
 * The socket *is* the session's lifetime. A tab that reloads, a browser that
 * crashes and an explicit `DELETE` all end the same way, because a session
 * nobody can reach still holds its documents open — and the next session for
 * the same file would be told it is a follower and would sit there with no
 * diagnostics, waiting for a `didOpen` that already happened.
 */
export function attachSessionSocket(
  deps: LanguageRouteDeps,
  sockets: SessionSockets,
  socket: WebSocket,
  workspaceId: string,
  sessionId: string,
): void {
  if (!sockets.connect(sessionId, socket)) {
    socket.close(1008, "This language session already has a socket");
    return;
  }
  const hub = deps.manager.hubOfSession(workspaceId, sessionId);
  if (hub === undefined) {
    socket.close(1011, "No such language session");
    return;
  }
  socket.on("message", (data, isBinary) => {
    // A language message is text. A binary frame is not one, and guessing at
    // an encoding is how a payload gets corrupted.
    if (isBinary) return;
    handleSessionMessage(hub, sessionId, Buffer.from(data as Buffer));
  });
  const end = (): void => {
    sockets.release(sessionId);
    void deps.manager.closeSession(workspaceId, sessionId);
  };
  socket.on("close", end);
  socket.on("error", end);
}

/**
 * The upgrade guard: it answers a status *before* the socket exists, which is
 * the only way to say 404 the way an HTTP route would.
 */
export function sessionGuard(
  deps: LanguageRouteDeps,
  sockets: SessionSockets,
  params: Readonly<Record<string, string>>,
): { status: number; reason?: string } | undefined {
  const workspaceId = params["workspaceId"] ?? "";
  const sessionId = params["sessionId"] ?? "";
  try {
    readable(deps, workspaceId);
  } catch (error) {
    const status = error instanceof DomainError ? error.status : 404;
    return { status, reason: status === 403 ? "Forbidden" : "Not Found" };
  }
  if (deps.manager.hubOfSession(workspaceId, sessionId) === undefined) {
    return { status: 404, reason: "Not Found" };
  }
  if (!sockets.has(sessionId)) {
    return { status: 409, reason: "Conflict" };
  }
  return undefined;
}

/* --------------------------------- plumbing -------------------------------- */

/** `answered`, for the handlers here that have to await something. */
export function answeredAsync(
  handle: (
    match: RouteMatch,
    request: CoreRequest,
  ) => Promise<HandlerResult> | HandlerResult,
): (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult> {
  return async (match, request) => {
    try {
      return await handle(match, request);
    } catch (error) {
      if (error instanceof DomainError) {
        const { status, body } = error.response();
        return { status, body };
      }
      if (error instanceof SyntaxError) {
        const { status, body } = badRequest(
          "Request body is not valid JSON",
        ).response();
        return { status, body };
      }
      throw error;
    }
  };
}

export { getWorkspace };
