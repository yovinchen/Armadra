import {
  type AdoptableBackend,
  type Attachment,
  type BackendCapabilities,
  type BackendKind,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  PASTE_END,
  PASTE_START,
  REPLAY_CHUNKS,
  type SessionKey,
  type TerminalHandle,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  TerminalError,
  conflict,
  internal,
  notFound,
  sanitizePaste,
  sessionKey as asSessionKey,
  stripEscapes,
  tailLines,
  trimCaptured,
} from "../backend";
import {
  type ClientMessage,
  type HostErrorCode,
  type HostMessage,
  type SessionSummary,
  RequestIds,
  START_TIMEOUT_MS,
  clampSize,
  createMessage,
  hostReference,
  keyOfReference,
  resizeMessage,
} from "./protocol";
import {
  type EventSink,
  type LinkEvent,
  Link,
  endpointFor,
  resolveHostBinary,
  startHost,
  waitForHost,
} from "./link";

/**
 * The Windows backend: terminals owned by `armadra-session-host`.
 *
 * What makes this different from `DirectBackend` is a process boundary. The
 * pseudo console belongs to the session host, not to the core, so:
 *
 *   * `create` is a request, not a spawn. Two cores racing to start a host
 *     end up with one, because only one can own the first pipe instance.
 *   * `attach` opens **its own** pipe connection, so a slow socket cannot
 *     delay a control request — and closing that connection is a detach and
 *     never an end.
 *   * `detachAll` closes connections and leaves the host alone. Core shutdown
 *     must not take a user's agents with it; that is the whole point.
 *
 * ## R6 boundary
 *
 * The host on the other end of this pipe is still the Rust binary. This batch
 * makes the TypeScript core able to **drive** it; R6 replaces the host itself.
 * Two consequences are written down rather than discovered:
 *
 *   * **No machine here can run this.** The protocol, the pipe name and the
 *     gap detector are pure functions in `protocol.ts` and are tested exactly
 *     against the Rust unit tests' vectors; the socket is not tested at all.
 *     `TODO(R6)`: first real-hardware run of create / attach / detach /
 *     re-attach / restart.
 *   * **The server-identity check is missing.** See the note at the top of
 *     `link.ts`. Windows should stay on `ARMADRA_CORE=rust` until R6.
 */

/** Everything this core remembers about one host session. */
interface Remembered {
  generation: number;
  pid: number | undefined;
  /**
   * The last replay this core saw, for `capture`. The host keeps bytes rather
   * than a screen, so this is the same approximation `DirectBackend` makes —
   * labelled as such, not presented as a real capture.
   */
  screen: Buffer[];
}

export interface SessionHostBackendOptions {
  readonly dataDir: string;
  readonly version: string;
  /** Injected by the tests; production derives it from the user's SID. */
  readonly endpoint?: string | undefined;
}

export class SessionHostBackend implements AdoptableBackend {
  readonly kind: BackendKind = "sessionHost";
  private readonly sessions = new Map<SessionKey, Remembered>();
  private readonly sinks: ((notice: BackendNotice) => void)[] = [];
  private readonly ids = new RequestIds();
  /** One pipe connection per attachment; closing it is the detach. */
  private readonly attachments = new Map<number, Link>();
  private readonly options: SessionHostBackendOptions;
  /** The one long-lived connection every control request goes through. */
  private control: Link | undefined;
  private connecting: Promise<Link> | undefined;
  /**
   * Identifies the host process this core is talking to. A change means the
   * host restarted and the sessions it held are gone — a fact worth reporting,
   * not one to infer from an empty list.
   */
  private instance: string | undefined;

  constructor(options: SessionHostBackendOptions) {
    this.options = options;
  }

  getCapabilities(): BackendCapabilities {
    const windows = process.platform === "win32";
    return {
      kind: "sessionHost",
      persistent: true,
      // The host sends its own replay down the attach connection, as ordinary
      // output frames, so this side owes the socket no `snapshot` of its own.
      // The bytes this backend keeps are for `capture`, not for redrawing.
      redrawsOnAttach: true,
      usable: windows,
      ...(windows ? {} : { reason: "会话宿主只在 Windows 上存在" }),
    };
  }

  notices(listener: (notice: BackendNotice) => void): void {
    this.sinks.push(listener);
  }

  private announce(notice: BackendNotice): void {
    for (const sink of this.sinks) sink(notice);
  }

  /**
   * Reaches the host, starting it if needed, so a failure is reported before
   * the first terminal rather than inside it.
   */
  async probe(): Promise<void> {
    await this.link();
  }

  /* -------------------------------- transport ----------------------------- */

  private endpoint(): string {
    return this.options.endpoint ?? endpointFor(this.options.dataDir);
  }

  /**
   * The control connection, opened or reopened as needed.
   *
   * Reconnecting is normal — the host may have been upgraded, or this core may
   * have been asleep. What must not happen is silently moving to a *different*
   * host instance, so the instance id is compared and a change clears what
   * this core thought it knew.
   */
  private async link(): Promise<Link> {
    const held = this.control;
    if (held !== undefined && held.alive) return held;
    // One connect at a time: two terminals created in the same tick would
    // otherwise each start a host.
    this.connecting ??= this.openControl().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openControl(): Promise<Link> {
    const endpoint = this.endpoint();
    const sink = this.controlSink();
    let link: Link;
    try {
      link = await Link.connect(endpoint, sink);
    } catch (first) {
      const executable = resolveHostBinary();
      startHost(executable, this.options.dataDir);
      try {
        link = await waitForHost(endpoint, sink, START_TIMEOUT_MS);
      } catch {
        throw internal(
          `会话宿主没有起来（${first instanceof Error ? first.message : String(first)}）；终端将无法在重启后存活`,
        );
      }
    }
    const greeting = await link.handshake(
      `armadra-core/${this.options.version}`,
    );
    if (this.instance !== undefined && this.instance !== greeting.instanceId) {
      // The host restarted: everything this core remembered about its sessions
      // describes consoles that no longer exist.
      for (const [key, remembered] of this.sessions) {
        this.announce({
          type: "exited",
          key,
          generation: remembered.generation,
        });
      }
      this.sessions.clear();
    }
    this.instance = greeting.instanceId;
    this.control = link;
    return link;
  }

  /** Turns control-connection events into the notices the manager understands. */
  private controlSink(): EventSink {
    return (event: LinkEvent) => {
      if (event.type !== "exit") return;
      this.announce({
        type: "exited",
        key: asSessionKey(event.sessionKey),
        generation: event.generation,
        ...(event.exitCode === null ? {} : { exitCode: event.exitCode }),
      });
    };
  }

  /** Sends one control request and waits for its answer. */
  private async request(
    build: (id: number) => ClientMessage,
  ): Promise<HostMessage> {
    const id = this.ids.issue();
    const message = build(id);
    // One reconnect, then give up: retrying forever would hide a host that is
    // refusing rather than absent.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const link = await this.link();
      try {
        return await link.request(id, message);
      } catch (error) {
        if (attempt === 1) {
          throw internal(
            error instanceof Error ? error.message : String(error),
          );
        }
        this.control = undefined;
      }
    }
    throw internal("会话宿主不再应答");
  }

  /** A request whose only interesting outcome is success or the refusal. */
  private async call(
    build: (id: number) => ClientMessage,
  ): Promise<SessionSummary | undefined> {
    const answer = await this.request(build);
    if (answer.type === "ok") return answer.session;
    if (answer.type === "error") throw hostError(answer.code, answer.message);
    throw internal(`会话宿主给了意料之外的回复：${answer.type}`);
  }

  private remembered(key: SessionKey): Remembered {
    const session = this.sessions.get(key);
    if (session === undefined) {
      throw notFound("Terminal session is not running");
    }
    return session;
  }

  /* -------------------------------- lifecycle ----------------------------- */

  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    const summary = await this.call((id) =>
      createMessage(id, {
        sessionKey: spec.sessionKey,
        generation: spec.generation,
        workspaceId: spec.workspaceId,
        cwd: spec.cwd,
        shell: spec.shell,
        command: spec.command ?? null,
        args: spec.args,
        env: spec.env,
        size: spec.size,
      }),
    );
    if (summary === undefined) throw internal("会话宿主什么都没创建");
    const pid = summary.pid ?? undefined;
    this.sessions.set(spec.sessionKey, {
      generation: spec.generation,
      pid,
      screen: [],
    });
    return {
      sessionKey: spec.sessionKey,
      generation: spec.generation,
      // The host addresses sessions by key; the generation makes the reference
      // unique across a recycle, as the tmux name does.
      backendRef: hostReference(summary.sessionKey, summary.generation),
      ...(pid === undefined ? {} : { pid }),
    };
  }

  /**
   * Takes a session the host still holds back under management after a core
   * restart, and reports the pid behind it. The console was never this
   * process', so coming back is bookkeeping and the CLI sees nothing at all.
   */
  async adopt(
    key: SessionKey,
    _reference: string,
    generation: number,
  ): Promise<number | undefined> {
    let pid: number | undefined;
    try {
      const answer = await this.request((id) => ({ type: "list", id }));
      if (answer.type === "ok") {
        pid =
          answer.sessions?.find(
            (summary) =>
              summary.sessionKey === key && summary.generation === generation,
          )?.pid ?? undefined;
      }
    } catch {
      // The host is unreachable. The row stays as it is — see `reconcile`,
      // which does not call this at all unless the probe succeeded.
    }
    this.sessions.set(key, { generation, pid, screen: [] });
    return pid;
  }

  async attach(
    key: SessionKey,
    generation: number,
    size: TerminalSize,
  ): Promise<Attachment> {
    const remembered = this.remembered(key);
    if (remembered.generation !== generation) {
      throw conflict(
        `Terminal generation ${generation} is stale; the session is at ${remembered.generation}`,
      );
    }

    const dataListeners: ((chunk: Buffer) => void)[] = [];
    const exitListeners: ((exitCode: number | undefined) => void)[] = [];
    const buffered: Buffer[] = [];
    let subscribed = false;
    let ended = false;

    const deliver = (payload: Buffer, replacing: boolean): void => {
      // A snapshot is the session's past being redrawn, so it replaces this
      // core's idea of the screen; live output appends to it.
      if (replacing) remembered.screen.length = 0;
      remembered.screen.push(payload);
      while (remembered.screen.length > REPLAY_CHUNKS)
        remembered.screen.shift();
      if (!subscribed) {
        buffered.push(payload);
        return;
      }
      for (const listener of dataListeners) listener(payload);
    };
    /**
     * A gap or a stale generation must resolve into a fresh attach with a
     * fresh replay, never into misaligned bytes on screen. Ending the stream
     * is how the socket layer is told to clear and reconnect — the same path
     * tmux and direct already use.
     */
    const end = (exitCode: number | undefined): void => {
      if (ended) return;
      ended = true;
      for (const listener of exitListeners) listener(exitCode);
    };

    // Its own connection, so a slow socket delays only itself. It never starts
    // a host: if the host is gone the session is gone, and a fresh empty host
    // would look like the session had merely ended.
    let link: Link;
    try {
      link = await Link.connect(this.endpoint(), (event) => {
        switch (event.type) {
          case "snapshot":
            deliver(event.payload, true);
            return;
          case "output":
            deliver(event.payload, false);
            return;
          case "exit":
            end(event.exitCode ?? undefined);
            return;
          case "gap":
          case "stale":
          case "closed":
            end(undefined);
        }
      });
    } catch (error) {
      throw notFound(
        `会话宿主没有在运行：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await link.handshake(`armadra-core-attach/${this.options.version}`);
    // Registered before the request goes out, so no frame can arrive unchecked.
    link.expectOutput(generation);

    const id = this.ids.issue();
    const answer = await link.request(id, {
      type: "attach",
      id,
      sessionKey: key,
      generation,
      size: clampSize(size),
    });
    if (answer.type === "error") {
      link.close();
      throw hostError(answer.code, answer.message);
    }
    this.attachments.set(id, link);

    return {
      attachmentId: id,
      generation,
      onData: (listener) => {
        dataListeners.push(listener);
        if (subscribed) return;
        subscribed = true;
        for (const chunk of buffered.splice(0)) listener(chunk);
      },
      onExit: (listener) => exitListeners.push(listener),
    };
  }

  async detach(_key: SessionKey, attachmentId: number): Promise<void> {
    const link = this.attachments.get(attachmentId);
    if (link === undefined) return;
    this.attachments.delete(attachmentId);
    // Closing the connection is the detach. The host keeps the session; only
    // `destroy` ends one.
    link.close();
  }

  /* ---------------------------------- io ---------------------------------- */

  async input(key: SessionKey, bytes: Buffer): Promise<void> {
    await this.call((id) => ({
      type: "write",
      id,
      sessionKey: key,
      data: bytes.toString("base64"),
    }));
  }

  /**
   * ConPTY has no paste buffer, so bracketed paste is written straight into
   * the console. A CLI that does not understand the brackets sees multi-line
   * text as separate lines — a real difference from tmux, and not one this
   * side can work around.
   */
  async paste(
    key: SessionKey,
    text: string,
    pressEnter: boolean,
  ): Promise<void> {
    const payload = `${PASTE_START}${sanitizePaste(text)}${PASTE_END}${pressEnter ? "\r" : ""}`;
    await this.input(key, Buffer.from(payload, "utf8"));
  }

  async resize(key: SessionKey, size: TerminalSize): Promise<void> {
    await this.call((id) => resizeMessage(id, key, size));
  }

  /**
   * The host keeps bytes, not a screen, so this is the replay this core has
   * seen — the same approximation the direct backend makes.
   */
  async capture(
    key: SessionKey,
    lines: number,
    withEscapes: boolean,
  ): Promise<string> {
    const remembered = this.remembered(key);
    const raw = Buffer.concat(remembered.screen).toString("utf8");
    const text = withEscapes ? raw : stripEscapes(raw);
    return tailLines(trimCaptured(text.replaceAll("\r", "")), lines);
  }

  async signal(key: SessionKey, _signal: "interrupt"): Promise<void> {
    await this.call((id) => ({ type: "interrupt", id, sessionKey: key }));
  }

  /**
   * The host reports the session's own pid. Walking the tree needs a process
   * snapshot this core does not take on Windows, so the children are honestly
   * empty rather than guessed at.
   */
  async getForeground(key: SessionKey): Promise<ForegroundInfo> {
    const remembered = this.remembered(key);
    return {
      ...(remembered.pid === undefined ? {} : { pid: remembered.pid }),
      children: [],
    };
  }

  async terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    if (mode === "interrupt") {
      await this.signal(key, "interrupt");
      return;
    }
    await this.call((id) => ({ type: "kill", id, sessionKey: key }));
    if (mode !== "session") return;
    try {
      await this.call((id) => ({ type: "destroy", id, sessionKey: key }));
    } finally {
      this.sessions.delete(key);
    }
  }

  async list(): Promise<BackendRef[]> {
    const answer = await this.request((id) => ({ type: "list", id }));
    if (answer.type !== "ok" || answer.sessions === undefined) return [];
    return answer.sessions
      .filter((summary) => !summary.exited)
      .map((summary) => ({
        name: hostReference(summary.sessionKey, summary.generation),
        attached: summary.subscribers > 0,
      }));
  }

  async destroyByReference(reference: string): Promise<void> {
    await this.call((id) => ({
      type: "destroy",
      id,
      sessionKey: keyOfReference(reference),
    }));
  }

  /** The host owns the console's history; there is no second one to move. */
  async scroll(_key: SessionKey, _lines: number): Promise<void> {}

  /**
   * Back pressure this connection owns, which is the host's own name for the
   * same idea: a dormant session's subscriber stops asking for frames. It is
   * idempotent by connection and released unconditionally when the connection
   * goes away, so a core that crashes while paused cannot freeze the CLI.
   */
  async setDormant(key: SessionKey, dormant: boolean): Promise<void> {
    this.remembered(key);
    await this.call((id) => ({
      type: "flow",
      id,
      sessionKey: key,
      paused: dormant,
    }));
  }

  /**
   * Core shutdown. Connections go, sessions stay — the whole reason this
   * backend exists.
   */
  async detachAll(): Promise<void> {
    for (const link of this.attachments.values()) link.close();
    this.attachments.clear();
    this.control?.close();
    this.control = undefined;
  }
}

function hostError(code: HostErrorCode, message: string): TerminalError {
  switch (code) {
    case "notFound":
      return notFound(message);
    case "stale":
    case "conflict":
    case "draining":
      return conflict(message);
    case "badRequest":
      return new TerminalError(400, "bad_request", message);
    default:
      return internal(message);
  }
}
