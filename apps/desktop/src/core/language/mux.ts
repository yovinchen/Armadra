/**
 * One server, many sessions (design §2.2 `mux`, §1.3).
 *
 * A {@link Hub} is everything that belongs to one `(workspace, serverId)`
 * pair: the process, the shadow documents, the sessions watching it and the
 * table that maps a request id back to whoever asked.
 *
 * ## The four directions
 *
 * * **Session → server** lives in `./session`; it filters, rewrites and
 *   renames ids before anything is written.
 * * **Server → session** is here. A response goes to exactly the session that
 *   asked; `publishDiagnostics` goes to all of them; `$/progress` becomes a
 *   status rather than a message.
 * * **Server → client request** (`workspace/configuration`,
 *   `client/registerCapability`, `window/workDoneProgress/create`) is answered
 *   here and never reaches the browser. The browser is not the LSP client and
 *   cannot answer for a server it does not own.
 * * **Host → session** is the status stream: state changes, restarts and
 *   progress, published on the workspace event bus.
 *
 * ## Restarting is invisible
 *
 * A crash or an idle stop keeps the sessions and the shadow documents. The
 * restart re-runs `initialize` and replays `didOpen` for every open document,
 * so the editor sees diagnostics reappear rather than a session ending.
 *
 * ## Why there is no lock
 *
 * The Rust original guards its state with a `Mutex` because its reader runs on
 * another thread. Node's loop is single-threaded and nothing here awaits while
 * holding a half-updated state, so the mutex is the event loop itself. The one
 * place that matters — the `await` inside `ensureStarted` — is guarded by the
 * `starting` promise instead, which is what makes two sessions opening the
 * same language share one server rather than racing two into existence.
 */

import { Documents, isClean, type Document } from "./documents";
import {
  applyEdits,
  currentVersions,
  dirtyFiles,
  parseEdit,
  type AppliedFile,
  type FailedFile,
} from "./edits";
import {
  METHOD_NOT_FOUND,
  REQUEST_FAILED,
  errorResponse,
  fromValue,
  idText,
  messageIdText,
  notification,
  parseMessage,
  request,
  resultResponse,
  type JsonObject,
  type JsonValue,
  type Message,
} from "./jsonrpc";
import {
  MAX_MESSAGE_BYTES,
  MAX_RESTARTS,
  RESTART_BACKOFF_SECONDS,
  RESTART_WINDOW_SECONDS,
  STDERR_TAIL_BYTES,
  reason,
} from "./limits";
import { redactSecrets } from "../terminal/ssh/redact";
import { codeActionIsOffered, serverEditAllowed } from "./policy";
import {
  candidate as registryCandidate,
  featuresFromCapabilities,
  type Feature,
  type ServerDescriptor,
  type ServerState,
} from "./registry";
import {
  ServerProcess,
  hostCapabilities,
  initializeParams,
  type Launch,
  type ServerEvent,
} from "./server";
import { Rewriter } from "./uri";

/**
 * The id `initialize` travels under. It is not namespaced to any session,
 * because the host — not a session — is the client that sends it.
 */
const INITIALIZE_ID = "armadra:initialize";
/** A server that has not answered `initialize` by now is not going to. */
const INITIALIZE_TIMEOUT_MS = 60_000;

/** One session's end of the socket, plus what it is allowed to do. */
export interface Sink {
  readonly clientId: string;
  readonly allowWrite: boolean;
  /** Messages towards this browser connection. */
  readonly outbox: (body: Buffer) => void;
  /**
   * Requests sent and not yet answered. Bounded by `MAX_IN_FLIGHT`, so one
   * session cannot make the server's queue everybody else's problem.
   */
  inFlight: number;
}

/** A request the server owes an answer to. */
export interface Pending {
  readonly sessionId: string;
  /** The id the *client* used, restored before the answer goes back. */
  readonly clientId: JsonValue;
  readonly method: string;
  readonly sentAt: number;
}

/** What the hub tells the world about itself. */
export interface HubEvents {
  session(event: {
    sessionId: string;
    serverId: string;
    generation: number;
    state: ServerState;
    reason?: string;
    restartCount: number;
    progress?: { percent?: number; title: string };
  }): void;
  server(event: { server: ServerDescriptor; stderrTail?: string }): void;
  fileChanged(file: AppliedFile): void;
}

export interface HubOptions {
  readonly workspaceId: string;
  readonly languageId: string;
  readonly root: string;
  readonly launch: Launch;
  readonly events: HubEvents;
  /** `clientInfo.version` in `initialize`. */
  readonly version: string;
  /**
   * How long a server is given to act on `shutdown`/`exit` before the process
   * group is signalled. Five seconds in production — long enough for a server
   * to close its index files — and short in tests, which would otherwise spend
   * the whole grace period per case waiting for a mock that exits at once.
   */
  readonly shutdownGraceMs?: number;
}

/** One server and everything watching it. */
export class Hub {
  readonly workspaceId: string;
  readonly serverId: string;
  readonly languageId: string;
  readonly root: string;
  readonly rewriter: Rewriter;
  /**
   * Not `readonly`: an explicit restart re-reads the settings, so a path the
   * user has just corrected is the one that starts. The `serverId` inside it
   * never changes — it is the half of this hub's identity.
   */
  launch: Launch;
  private readonly events: HubEvents;
  private readonly version: string;
  private readonly shutdownGraceMs: number;

  process: ServerProcess | undefined;
  generation = 0;
  state: ServerState = "available";
  reason: string | undefined;
  restartCount = 0;
  /** Crash timestamps inside the restart window, in seconds. */
  crashes: number[] = [];
  capabilities: JsonValue = null;
  features: Feature[] = [];
  readonly documents = new Documents();
  readonly sessions = new Map<string, Sink>();
  readonly pending = new Map<string, Pending>();
  sequence = 0;
  stderrTail = "";
  /** When the last document closed; `undefined` while something is open. */
  idleSince: number | undefined = Date.now();
  /** Consecutive samples above the RSS ceiling. */
  overRss = 0;
  /**
   * Set while a deliberate stop is in progress, so the exit that follows is
   * not read as a crash.
   */
  stopping = false;

  private initializeResolve:
    | ((value: JsonValue | undefined) => void)
    | undefined;
  /**
   * The message from the last `initialize` the server refused, so the panel
   * can show the server's own words rather than the word "crashed".
   */
  private initializeError = "";
  private starting: Promise<string | undefined> | undefined;

  constructor(options: HubOptions) {
    this.workspaceId = options.workspaceId;
    this.serverId = options.launch.serverId;
    this.languageId = options.languageId;
    this.root = options.root;
    this.rewriter = new Rewriter(options.root);
    this.launch = options.launch;
    this.events = options.events;
    this.version = options.version;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
  }

  /**
   * Starts the process and completes the handshake.
   *
   * Idempotent: a hub that is already running returns immediately, and two
   * callers that arrive while a start is in flight await the same promise.
   */
  async ensureStarted(): Promise<string | undefined> {
    if (this.state === "running") return undefined;
    if (this.starting !== undefined) return this.starting;
    if (
      (this.state === "stopped" || this.state === "crashed") &&
      (this.reason === reason.RESOURCE_EXHAUSTED ||
        this.reason === reason.RESTART_BUDGET_EXHAUSTED)
    ) {
      // A ceiling or an exhausted budget is not retried on its own; only an
      // explicit restart clears it.
      return this.reason;
    }
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<string | undefined> {
    // The generation is decided before the process exists, so the reader can
    // stamp every event with it: an event from a process that has already been
    // replaced belongs to a generation nobody is listening to.
    const generation = this.generation + 1;
    const started = ServerProcess.start(this.launch, (event) =>
      this.onProcessEvent(event, generation),
    );
    if (started === "containmentUnavailable") {
      this.setState("unsupported", reason.CONTAINMENT_UNAVAILABLE);
      return reason.CONTAINMENT_UNAVAILABLE;
    }
    if (started === "spawnFailed") {
      this.setState("crashed", reason.SERVER_PROBE_FAILED);
      return reason.SERVER_PROBE_FAILED;
    }
    this.process = started;
    this.generation = generation;
    this.state = "starting";
    this.reason = undefined;
    this.stopping = false;
    const handshake = new Promise<JsonValue | undefined>((resolve) => {
      this.initializeResolve = resolve;
    });
    this.publishStatus();

    this.write(
      request(
        INITIALIZE_ID,
        "initialize",
        initializeParams(
          this.root,
          hostCapabilities(),
          this.launch.initializationOptions,
          this.version,
        ),
      ),
    );
    const capabilities = await withTimeout(handshake, INITIALIZE_TIMEOUT_MS);
    if (capabilities === undefined || capabilities === null) {
      // A refused `initialize` is the server telling us why it cannot serve
      // this project — "no TypeScript installation here", "unreadable
      // project file". That sentence is the only useful thing anyone has, so
      // it rides the same in-memory tail a crash uses instead of being
      // dropped for a bare `crashed`.
      if (this.initializeError !== "") {
        const why = this.initializeError;
        this.initializeError = "";
        await this.stopProcess("crashed", reason.INITIALIZE_FAILED);
        this.stderrTail = why;
        this.publishStatus();
        return reason.INITIALIZE_FAILED;
      }
      await this.stopProcess("crashed", reason.CRASHED);
      return reason.CRASHED;
    }
    this.write(notification("initialized", {}));
    this.features = featuresFromCapabilities(capabilities);
    this.capabilities = capabilities;
    this.state = "running";
    this.reason = undefined;
    this.replayDocuments();
    this.publishStatus();
    return undefined;
  }

  /**
   * Re-sends `didOpen` for every shadow document (design §1.3).
   *
   * This is what makes a restart invisible: the server comes back knowing
   * exactly the buffers the editor has open, including unsaved text, and
   * republishes diagnostics without the browser doing anything.
   */
  private replayDocuments(): void {
    for (const document of this.documents.all()) {
      this.write(
        notification("textDocument/didOpen", {
          textDocument: {
            uri: this.hostUri(document.uri),
            languageId: document.languageId,
            version: document.version,
            text: document.text,
          },
        }),
      );
    }
  }

  /** The `file://` uri a workspace uri names, unchanged when it is not ours. */
  hostUri(uri: string): string {
    const relative = this.rewriter.relativeOf(uri);
    return relative === undefined ? uri : this.rewriter.fileUri(relative);
  }

  /**
   * Writes one message to the server. A hub with no process drops it: the
   * caller has already been told the state, and queueing for a process that
   * does not exist would deliver a stale request after a restart.
   */
  write(message: JsonValue): void {
    this.process?.send(Buffer.from(JSON.stringify(message), "utf8"));
  }

  setState(next: ServerState, why: string | undefined): void {
    this.state = next;
    this.reason = why;
    this.publishStatus();
  }

  /** Ends the process and tells every session why. */
  async stopProcess(next: ServerState, why: string): Promise<void> {
    this.stopping = true;
    this.state = next;
    this.reason = why;
    const process = this.process;
    if (process !== undefined) this.stderrTail = process.stderrTail();
    this.pending.clear();
    this.process = undefined;
    if (process !== undefined) {
      // Ask first, then insist. A server given `shutdown`/`exit` closes its
      // own index files; one that ignores them gets five seconds.
      process.send(
        Buffer.from(
          JSON.stringify(request("armadra:shutdown", "shutdown", null)),
          "utf8",
        ),
      );
      process.send(
        Buffer.from(JSON.stringify(notification("exit", null)), "utf8"),
      );
      await new Promise((resolve) => setTimeout(resolve, this.shutdownGraceMs));
      await process.terminate();
    }
    this.publishStatus();
  }

  /** The descriptor the settings page and the resource panel read. */
  descriptor(): ServerDescriptor {
    const known = registryCandidate(this.serverId);
    const base: ServerDescriptor = {
      serverId: this.serverId,
      languageId: this.languageId,
      fileExtensions: [...(known?.entry.extensions ?? [])],
      executable: this.launch.executable,
      version: "",
      state: this.state,
      features:
        this.features.length === 0
          ? [...(known?.candidate.features ?? [])]
          : [...this.features],
      restartCount: this.restartCount,
      pid: this.process?.pid ?? null,
      startTimeUnixMs: this.process?.startTimeUnixMs ?? null,
      openDocuments: this.documents.size,
      probedAtUnixMs: 0,
    };
    return this.reason === undefined ? base : { ...base, reason: this.reason };
  }

  publishStatus(): void {
    for (const sessionId of this.sessions.keys()) {
      this.events.session({
        sessionId,
        serverId: this.serverId,
        generation: this.generation,
        state: this.state,
        ...(this.reason === undefined ? {} : { reason: this.reason }),
        restartCount: this.restartCount,
      });
    }
    this.events.server({
      server: this.descriptor(),
      // Only a crash carries the tail, and only in memory: it is never written
      // to a log or the database (design §3.4).
      ...(this.state === "crashed" && this.stderrTail !== ""
        ? { stderrTail: this.stderrTail }
        : {}),
    });
  }

  /** Sends one already-rewritten message to one session. */
  deliver(sessionId: string, message: JsonValue): void {
    this.sessions
      .get(sessionId)
      ?.outbox(Buffer.from(JSON.stringify(message), "utf8"));
  }

  private broadcast(message: JsonValue): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    for (const sink of this.sessions.values()) sink.outbox(body);
  }

  /* ------------------------------- the reader ------------------------------ */

  private onProcessEvent(event: ServerEvent, generation: number): void {
    // A message from a process that has already been replaced belongs to a
    // generation nobody is listening to.
    if (this.generation !== generation) return;
    if (event.kind === "message") {
      this.onMessage(event.body, event.oversize);
      return;
    }
    void this.onExit(event.code);
  }

  private onMessage(body: Buffer, oversize: boolean): void {
    const message = parseMessage(body);
    if (message === undefined) return;
    switch (message.kind) {
      case "response":
        this.onResponse(message, oversize);
        return;
      case "request":
        this.onServerRequest(message);
        return;
      case "notification":
        this.onNotification(message);
    }
  }

  private onResponse(message: Message, oversize: boolean): void {
    const id = messageIdText(message);
    if (id === INITIALIZE_ID) {
      const resolve = this.initializeResolve;
      this.initializeResolve = undefined;
      this.initializeError = errorMessageOf(message.value["error"]);
      const result = message.value["result"];
      const capabilities =
        result !== null && typeof result === "object" && !Array.isArray(result)
          ? result["capabilities"]
          : undefined;
      resolve?.(capabilities);
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) {
      // Nobody is waiting: an answer to a request whose session left, or to
      // one that already timed out. Dropping it is the whole handling.
      return;
    }
    this.pending.delete(id);
    const sink = this.sessions.get(pending.sessionId);
    if (sink !== undefined) sink.inFlight = Math.max(0, sink.inFlight - 1);
    if (oversize) {
      // The session gets a failure it can show, not silence.
      this.deliver(
        pending.sessionId,
        errorResponse(
          pending.clientId,
          REQUEST_FAILED,
          "The language server's answer was too large to deliver",
        ),
      );
      return;
    }
    this.rewriter.rewrite(message.value, "toWeb");
    message.value["id"] = pending.clientId;
    stripCommandActions(pending.method, message.value);
    this.deliver(pending.sessionId, message.value);
  }

  private onNotification(message: Message): void {
    switch (message.method) {
      case "textDocument/publishDiagnostics":
        this.rewriter.rewrite(message.value, "toWeb");
        this.broadcast(message.value);
        return;
      case "$/progress":
        this.publishProgress(message.value);
        return;
      default:
        // `window/logMessage` and `window/showMessage` carry server prose that
        // can quote file contents. It is not forwarded and not logged.
        return;
    }
  }

  private publishProgress(message: JsonObject): void {
    const params = message["params"];
    if (
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params)
    ) {
      return;
    }
    const value = params["value"];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const kind = value["kind"];
    const percent = value["percentage"];
    const title = value["title"] ?? value["message"];
    const progress =
      kind === "end"
        ? undefined
        : {
            ...(typeof percent === "number"
              ? { percent: Math.min(100, Math.max(0, Math.trunc(percent))) }
              : {}),
            title: typeof title === "string" ? title : "",
          };
    for (const sessionId of this.sessions.keys()) {
      this.events.session({
        sessionId,
        serverId: this.serverId,
        generation: this.generation,
        state: this.state,
        ...(this.reason === undefined ? {} : { reason: this.reason }),
        restartCount: this.restartCount,
        ...(progress === undefined ? {} : { progress }),
      });
    }
  }

  /**
   * Requests the server makes of its client. The Manager answers them; the
   * browser never sees them, because the browser is not the client.
   */
  private onServerRequest(message: Message): void {
    const id = message.id ?? null;
    switch (message.method) {
      // One entry per requested section. The core hands back the user's own
      // `language.servers.<id>.settings`, or null when they set none.
      case "workspace/configuration": {
        const params = message.value["params"];
        const items =
          params !== null &&
          typeof params === "object" &&
          !Array.isArray(params) &&
          Array.isArray(params["items"])
            ? params["items"].length
            : 1;
        const configuration = this.launch.initializationOptions ?? null;
        this.write(
          resultResponse(id, new Array(items).fill(configuration) as JsonValue),
        );
        return;
      }
      // Dynamic registration is accepted so a server that insists on it can
      // start; what it registers still has to pass the method allowlist.
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        this.write(resultResponse(id, null));
        return;
      case "workspace/workspaceFolders":
        this.write(
          resultResponse(id, [
            {
              uri: `file://${this.rewriter.root()}`,
              name: this.root.split(/[/\\]/).pop() ?? "",
            },
          ]),
        );
        return;
      // A server asking to write files goes through the same write grant and
      // the same sha-checked apply a rename does.
      case "workspace/applyEdit": {
        const params = message.value["params"] ?? null;
        // The server names files the way it knows them. Rewriting first means
        // the edit is validated by exactly the code a browser's own edit
        // passes through — including the part that turns a path outside the
        // root into an opaque external id the parser refuses.
        this.rewriter.rewrite(params, "toWeb");
        void this.applyServerEdit(params).then((answer) => {
          this.write(resultResponse(id, answer));
        });
        return;
      }
      default:
        this.write(
          errorResponse(
            id,
            METHOD_NOT_FOUND,
            "This client does not implement that request",
          ),
        );
    }
  }

  /**
   * Answers one `workspace/applyEdit` for real (design §2.6 step 5).
   *
   * The shape is deliberately the same as the client-initiated apply: the
   * write grant, the same parser, the same refusal to touch a file with an
   * unsaved draft, the same per-file digest check, the same `file.changed`
   * events that make the open editors reload. What is different is where the
   * digests come from — nobody previewed this edit, so they are read here,
   * immediately before the write.
   */
  private async applyServerEdit(params: JsonValue): Promise<JsonValue> {
    const allowWrite = [...this.sessions.values()].some(
      (sink) => sink.allowWrite,
    );
    if (serverEditAllowed(allowWrite) !== undefined) {
      return refused(reason.READ_ONLY);
    }
    const edit =
      params !== null && typeof params === "object" && !Array.isArray(params)
        ? params["edit"]
        : null;
    let files;
    try {
      files = parseEdit(edit ?? null, this.rewriter);
    } catch {
      // The parser's refusals are all the same class of answer: this edit
      // names something the workspace will not write.
      return refused(reason.EDIT_NOT_APPLICABLE);
    }
    if (dirtyFiles(files, this.documents, this.rewriter).length > 0) {
      return refused(reason.UNSAVED_CHANGES);
    }
    const expected = currentVersions(this.root, files);
    if (isFailure(expected)) return refused(expected.code);
    let result;
    try {
      result = applyEdits(this.root, files, expected, (file) =>
        this.events.fileChanged(file),
      );
    } catch {
      return refused("write_failed");
    }
    const failure = result.failed[0];
    if (failure === undefined) return { applied: true };
    return {
      applied: false,
      failureReason: failure.code,
      // The spec's index into `documentChanges`: how far the write got before
      // it stopped.
      failedChange: result.applied.length,
    };
  }

  /**
   * The process went away. Whether that is a crash depends on whether somebody
   * asked for it (design §1.3).
   */
  private async onExit(_code: number | null): Promise<void> {
    const tail = this.process?.stderrTail() ?? "";
    this.process = undefined;
    this.pending.clear();
    if (this.stopping) return;
    const now = Math.floor(Date.now() / 1000);
    this.crashes = this.crashes.filter(
      (when) => now - when < RESTART_WINDOW_SECONDS,
    );
    this.crashes.push(now);
    this.stderrTail = tail;
    this.state = "crashed";
    this.reason = reason.CRASHED;
    const backoff = restartDelay(this.crashes.length);
    if (backoff === undefined) {
      this.reason = reason.RESTART_BUDGET_EXHAUSTED;
    } else {
      this.restartCount += 1;
    }
    this.publishStatus();
    if (backoff === undefined) return;
    // Only restart while somebody is still watching: a server whose last
    // session left crashed on its way out, and reviving it would start a
    // process nobody asked for.
    if (this.sessions.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
    if (this.sessions.size === 0) return;
    await this.ensureStarted();
  }
}

function refused(why: string): JsonValue {
  return { applied: false, failureReason: why };
}

/**
 * The `message` of a JSON-RPC error object, bounded and stripped of secrets
 * the same way a stderr tail is; anything that is not an error object is no
 * message at all.
 */
function errorMessageOf(value: JsonValue | undefined): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return "";
  }
  const text = (value as JsonObject)["message"];
  if (typeof text !== "string" || text === "") return "";
  return redactSecrets(text.slice(0, STDERR_TAIL_BYTES));
}

function isFailure(
  value: Record<string, string> | FailedFile,
): value is FailedFile {
  return typeof (value as FailedFile).code === "string";
}

/**
 * A code action whose only effect is a `command` would need
 * `workspace/executeCommand` to apply, which is refused (design §6.2). It is
 * removed here rather than shown and then rejected on click.
 */
function stripCommandActions(method: string, message: JsonObject): void {
  if (method !== "textDocument/codeAction") return;
  const result = message["result"];
  if (!Array.isArray(result)) return;
  message["result"] = result.filter((action) => codeActionIsOffered(action));
}

/**
 * How long to wait before the `attempt`-th restart inside the window, or
 * `undefined` once the budget is spent.
 *
 * The budget exists because a server that fails on startup fails on startup
 * every time: without it, a broken `tsconfig` would become an endless restart
 * loop that looks like the machine is busy. Stopping at three, and staying
 * stopped until a person presses restart, is the honest end of that.
 */
export function restartDelay(attempt: number): number | undefined {
  if (attempt === 0 || attempt > MAX_RESTARTS) return undefined;
  return RESTART_BACKOFF_SECONDS[
    Math.min(attempt - 1, RESTART_BACKOFF_SECONDS.length - 1)
  ];
}

/**
 * Requests older than the ceiling, cancelled and answered.
 *
 * A hung server is the normal reason. The session is told `-32803` so the
 * editor stops waiting, and the server is sent `$/cancelRequest` so it stops
 * working on an answer nobody will read.
 */
export function expireRequests(hub: Hub, olderThanMs: number): void {
  const now = Date.now();
  // `>=`, not `>`: a millisecond clock can put `sentAt` and `now` in the same
  // tick, and a sweep asked to expire everything has to be able to.
  const expired = [...hub.pending.entries()].filter(
    ([, pending]) => now - pending.sentAt >= olderThanMs,
  );
  for (const [id, pending] of expired) {
    hub.pending.delete(id);
    const sink = hub.sessions.get(pending.sessionId);
    if (sink !== undefined) sink.inFlight = Math.max(0, sink.inFlight - 1);
    hub.write(notification("$/cancelRequest", { id }));
    hub.deliver(
      pending.sessionId,
      errorResponse(
        pending.clientId,
        REQUEST_FAILED,
        "The language server did not answer in time",
      ),
    );
  }
}

/** The message ceiling, applied to what a session is about to send. */
export function withinMessageCeiling(body: Buffer | string): boolean {
  const size =
    typeof body === "string"
      ? Buffer.byteLength(body, "utf8")
      : body.byteLength;
  return size <= MAX_MESSAGE_BYTES;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), milliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Re-exported so `session` and the tests share one spelling. */
export { fromValue, idText, isClean, type Document };
