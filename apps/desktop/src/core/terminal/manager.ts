import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Attachment,
  type BackendKind,
  type BackendNotice,
  type ForegroundInfo,
  type SessionKey,
  type TerminalBackend,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  conflict,
  isAdoptable,
  notFound,
  persistent,
  sessionKey,
} from "./backend";
import { AttachmentBook } from "./attachments";
import {
  type EnvPairs,
  contextSessionEnvironment,
  defaultShell,
  withUtf8Locale,
} from "./environment";
import {
  DORMANCY_INTERVAL_MS,
  LIVENESS_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
  attachableRows,
  type ReconcileReport,
  EMPTY_REPORT,
  failNonPersistentRows,
  gcCandidates,
  mergeReports,
  reconcile,
} from "./gc";
import { InputLedger, InputSafety } from "./input";

/**
 * The manager: what a session *is*, as opposed to what a backend *runs*.
 *
 * It owns the row in `terminal_sessions`, the generation counter, the
 * in-memory record that ties a session id to a backend key, and the four
 * periodic jobs that keep the database honest about processes it does not own:
 *
 *   * the **liveness** poll (every 3 s) — a persistent session can end while
 *     nothing is attached, and nobody would notice until the next attach;
 *   * the **sweeper** (every 10 min) — contract §15.6's reclamation;
 *   * the **dormancy** pass (every 5 s) — design §7.2's delivery budget;
 *   * **start-up reconciliation**, once, before the first request is served.
 *
 * The columns written here are the Rust Runtime's, and are written with the
 * same values, because both implementations open the same database during the
 * changeover.
 *
 * ## One writer per key
 *
 * Every path that can create, replace or destroy the process behind a key runs
 * under {@link withKey}. Without it, a recycle racing a write would destroy
 * the pty between the generation check and the write, and the caller would see
 * a 500 where the honest answer is `stale`.
 */

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** `last_output_at` is a "how long has this been quiet" signal, not an audit
 * trail: one write every few seconds of continuous output is enough. */
export const ACTIVITY_THROTTLE_MS = 5_000;

/** The row shape `/api/terminals` answers with. camelCase, contract §5.1. */
export interface TerminalSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly command: string | null;
  readonly kind: string;
  readonly ownerNodeId: string | null;
  readonly agentId: string | null;
  readonly status: string;
  readonly exitCode: number | null;
  readonly pid: number | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly sessionKey: string;
  readonly backend: string;
  readonly generation: number;
  readonly attachState: string;
  readonly lastOutputAt: string | null;
}

export interface SpawnRequest {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell?: string | undefined;
  readonly command?: string | undefined;
  readonly args?: readonly string[];
  readonly kind?: string;
  readonly ownerNodeId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly env?: EnvPairs;
  /**
   * `ssh: { hostId }` — this session runs `ssh …` instead of a shell.
   *
   * It travels as an extra field on the spec rather than as a decision here:
   * the manager does not know what an SSH host is, and the backend decorator
   * that does (`ssh/backend.ts`) rewrites the command from the *stored* host.
   * A spec without it passes through every backend untouched, which is what
   * lets one decorated backend serve every terminal.
   */
  readonly sshHostId?: string | undefined;
}

export interface SessionRecord {
  readonly id: string;
  readonly key: SessionKey;
  readonly workspaceId: string;
  readonly ownerNodeId: string | null;
  kind: BackendKind;
  generation: number;
  pid: number | undefined;
  cols: number;
  rows: number;
  exited: boolean;
  /** Kept so `recycle` can restart the same terminal, environment included. */
  spec: TerminalSpec;
  inputRevision: number;
  inputSafety: InputSafety;
  /** When this session last had input written in, or output come back out. */
  lastActivity: number | undefined;
}

/** What one socket needs to serve a terminal. */
export interface AttachSession {
  readonly attachment: Attachment;
  readonly record: SessionRecord;
  /** The replay, for a backend that does not redraw on attach. */
  readonly snapshot: string | undefined;
}

export interface TerminalManagerOptions {
  readonly database: DatabaseSync;
  /** Every backend this build can reach, by kind. */
  readonly backends: ReadonlyMap<BackendKind, TerminalBackend>;
  /** The one new sessions are created with (contract §15.1). */
  readonly effective: BackendKind;
  /** `terminal.detachedGraceMinutes` / `terminal.dormantAfterSeconds`. */
  readonly policy?: () => {
    detachedGraceMinutes: number;
    dormantAfterSeconds: number;
  };
  /** Injected so a test can make the timestamps deterministic. */
  readonly now?: () => string;
  readonly clock?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  readonly onExit?: (event: {
    workspaceId: string;
    sessionId: string;
    nodeId: string | null;
    exitCode: number | null;
  }) => void;
}

const DEFAULT_POLICY = {
  detachedGraceMinutes: 1_440,
  dormantAfterSeconds: 120,
};

export class TerminalManager {
  private readonly database: DatabaseSync;
  private readonly backends: ReadonlyMap<BackendKind, TerminalBackend>;
  private readonly effective: BackendKind;
  private readonly records = new Map<string, SessionRecord>();
  private readonly byKey = new Map<SessionKey, string>();
  private readonly gates = new Map<SessionKey, Promise<unknown>>();
  private readonly attachments: AttachmentBook;
  private readonly inputs = new InputLedger();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly lastRowWrite = new Map<string, number>();
  private readonly now: () => string;
  private readonly clock: () => number;
  private readonly log: (
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  private readonly policy: () => {
    detachedGraceMinutes: number;
    dormantAfterSeconds: number;
  };
  private readonly onExit: TerminalManagerOptions["onExit"];
  private stopping = false;

  constructor(options: TerminalManagerOptions) {
    this.database = options.database;
    this.backends = options.backends;
    this.effective = options.effective;
    this.now = options.now ?? (() => new Date().toISOString());
    this.clock = options.clock ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.policy = options.policy ?? (() => DEFAULT_POLICY);
    this.onExit = options.onExit;
    this.attachments = new AttachmentBook(this.clock);
    for (const [kind, backend] of this.backends) {
      backend.notices((notice) => {
        void this.noticed(kind, notice);
      });
    }
  }

  /* -------------------------------- start-up ------------------------------- */

  /**
   * Start-up recovery, then the periodic jobs.
   *
   * Recovery runs **before** the first request is served, in this order and no
   * other: settle the rows nothing can bring back (a direct PTY died with
   * whoever wrote its row), then ask each persistent backend what it still
   * holds. Doing it the other way around would let a row describe a session
   * this build is about to adopt as failed.
   */
  async start(): Promise<ReconcileReport> {
    const failed = failNonPersistentRows(this.database, this.now());
    if (failed > 0) {
      this.log("非持久后端的终端行已标记为 failed", { rows: failed });
    }
    const report = await this.reconcile();
    this.spawnLoops();
    return report;
  }

  async reconcile(): Promise<ReconcileReport> {
    let report = EMPTY_REPORT;
    for (const [kind, backend] of this.backends) {
      if (!persistent(kind) || !isAdoptable(backend)) continue;
      // Reaching the backend is what tells this core whether the sessions it
      // remembers are still there. One that cannot be reached leaves its rows
      // exactly as they are: they may be perfectly alive under a host this
      // process merely failed to reach, and marking them exited would lose
      // them for good.
      let round;
      try {
        round = await reconcile(this.database, backend, kind, this.now());
      } catch (error) {
        this.log("无法与持久后端对账，保留其数据库行", {
          backend: kind,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      report = mergeReports(report, round.report);
      for (const adopted of round.adopted) {
        const pid = await backend.adopt(
          adopted.key,
          adopted.reference,
          adopted.generation,
        );
        this.rememberAdopted(adopted.key, adopted.generation, pid);
      }
    }
    return report;
  }

  /** Rebuilds the in-memory record of a session this process did not create. */
  private rememberAdopted(
    key: SessionKey,
    generation: number,
    pid: number | undefined,
  ): void {
    const row = this.database
      .prepare("SELECT * FROM terminal_sessions WHERE session_key = ?")
      .get(key) as Record<string, unknown> | undefined;
    if (row === undefined) return;
    const id = String(row.id);
    const kindOfRow = String(row.backend_kind) as BackendKind;
    const shell = String(row.shell);
    const command = (row.command as string | null) ?? undefined;
    this.remember({
      id,
      key,
      workspaceId: String(row.workspace_id),
      ownerNodeId: (row.owner_node_id as string | null) ?? null,
      kind: kindOfRow,
      generation,
      pid,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      exited: false,
      inputRevision: 0,
      inputSafety: new InputSafety(),
      // An adopted session has been running without us watching it; the first
      // byte after adoption is the first thing worth an opinion.
      lastActivity: undefined,
      spec: {
        sessionKey: key,
        workspaceId: String(row.workspace_id),
        generation,
        cwd: String(row.cwd),
        shell,
        ...(command === undefined ? {} : { command }),
        args: [],
        env: [],
        size: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
      },
    });
  }

  private spawnLoops(): void {
    const every = (ms: number, job: () => Promise<void>): void => {
      const timer = setInterval(() => {
        if (this.stopping) return;
        void job().catch((error: unknown) => {
          this.log("终端后台任务失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(LIVENESS_INTERVAL_MS, () => this.pollLiveness());
    every(SWEEP_INTERVAL_MS, async () => {
      const destroyed = await this.sweep();
      if (destroyed.length > 0) {
        this.log("回收了长期无人附着的终端", { count: destroyed.length });
      }
    });
    every(DORMANCY_INTERVAL_MS, () => this.applyDormancy());
  }

  /* -------------------------------- lifecycle ------------------------------ */

  async spawn(request: SpawnRequest): Promise<TerminalSession> {
    const id = randomUUID();
    // A terminal that belongs to a node keys on the node, so the pane survives
    // the session row being replaced; one that does not keys on itself.
    const key = sessionKey(request.ownerNodeId ?? id);
    return this.withKey(key, async () => {
      const shell = request.shell ?? defaultShell();
      const env = contextSessionEnvironment(
        withUtf8Locale(request.env ?? []),
        id,
        1,
      );
      const spec: TerminalSpec = {
        sessionKey: key,
        workspaceId: request.workspaceId,
        generation: 1,
        cwd: request.cwd,
        shell,
        ...(request.command === undefined ? {} : { command: request.command }),
        args: request.args ?? [],
        env,
        size: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        // Carried, never interpreted. It is kept on the record so a recycle
        // reaches the same host rather than dropping back to a local shell.
        ...(request.sshHostId === undefined
          ? {}
          : { sshHostId: request.sshHostId }),
      };
      const kind = this.effective;
      const handle = await this.backend(kind).create(spec);

      const createdAt = this.now();
      const rowKind = request.kind ?? "terminal";
      this.database
        .prepare(
          `INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, command, kind,
             owner_node_id, agent_id, status, created_at, session_key, backend_kind,
             backend_ref, generation, attach_state, termination_intent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 'detached', 'none')`,
        )
        .run(
          id,
          request.workspaceId,
          request.cwd,
          shell,
          request.command ?? null,
          rowKind,
          request.ownerNodeId ?? null,
          request.agentId ?? null,
          createdAt,
          key,
          kind,
          handle.backendRef ?? null,
          handle.generation,
        );

      this.remember({
        id,
        key,
        workspaceId: request.workspaceId,
        ownerNodeId: request.ownerNodeId ?? null,
        kind,
        generation: handle.generation,
        pid: handle.pid,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        exited: false,
        inputRevision: 0,
        inputSafety: new InputSafety(),
        lastActivity: undefined,
        spec,
      });

      return {
        id,
        workspaceId: request.workspaceId,
        cwd: request.cwd,
        shell,
        command: request.command ?? null,
        kind: rowKind,
        ownerNodeId: request.ownerNodeId ?? null,
        agentId: request.agentId ?? null,
        status: "running",
        exitCode: null,
        pid: handle.pid ?? null,
        createdAt,
        endedAt: null,
        sessionKey: key,
        backend: kind,
        generation: handle.generation,
        attachState: "detached",
        lastOutputAt: null,
      };
    });
  }

  /**
   * Same `session_key`, next generation (contract §15.5). Sockets attached to
   * the old generation are told to clear and reconnect.
   */
  async recycle(sessionId: string): Promise<TerminalSession> {
    const first = this.require(sessionId);
    return this.withKey(first.key, async () => {
      const record = this.require(sessionId);
      const nextGeneration = record.generation + 1;
      // The bump has to be visible *before* the old session is destroyed.
      // Destroying it ends the output stream every attached socket is reading,
      // and each of those sockets then asks what the current generation is:
      // still seeing the old one, they would close silently instead of sending
      // `stale`, and the client would treat a planned recycle as a dropped
      // connection. Marking it exited at the same time silences the exit its
      // own watcher is about to report.
      record.generation = nextGeneration;
      record.exited = true;
      try {
        await this.backend(record.kind).terminate(record.key, "session");
      } catch {
        // Already gone is the normal case for a session that exited by itself.
      }

      const kind = this.effective;
      const spec: TerminalSpec = {
        ...record.spec,
        generation: nextGeneration,
        env: contextSessionEnvironment(
          record.spec.env,
          sessionId,
          nextGeneration,
        ),
        size: { cols: record.cols, rows: record.rows },
      };
      let handle;
      try {
        handle = await this.backend(kind).create(spec);
      } catch (error) {
        // The old session is already gone, so the row must not keep claiming
        // to be running.
        this.database
          .prepare(
            `UPDATE terminal_sessions SET status = 'exited', attach_state = 'exited',
                 ended_at = ? WHERE id = ? AND status = 'running'`,
          )
          .run(this.now(), sessionId);
        throw error;
      }

      this.database
        .prepare(
          `UPDATE terminal_sessions SET generation = ?, backend_kind = ?, backend_ref = ?,
               status = 'running', exit_code = NULL, ended_at = NULL,
               attach_state = 'detached', termination_intent = 'recycle',
               last_output_at = NULL WHERE id = ?`,
        )
        .run(handle.generation, kind, handle.backendRef ?? null, sessionId);

      // A recycled session is a new terminal in an old shell: the marks, the
      // half-typed line and what the previous process was doing all belong to
      // a pty that no longer exists.
      this.inputs.forget(sessionId);
      this.remember({
        ...record,
        kind,
        generation: handle.generation,
        pid: handle.pid,
        exited: false,
        inputRevision: 0,
        inputSafety: new InputSafety(),
        lastActivity: undefined,
        spec,
      });
      return this.session(sessionId);
    });
  }

  private remember(record: SessionRecord): void {
    this.byKey.set(record.key, record.id);
    this.attachments.register(record.id);
    this.records.set(record.id, record);
  }

  private forget(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record !== undefined) this.byKey.delete(record.key);
    this.records.delete(sessionId);
    this.attachments.forget(sessionId);
    this.lastRowWrite.delete(sessionId);
    // The marks describe a pty that no longer exists. Keeping them would let a
    // later session with the same id claim input it never wrote.
    this.inputs.forget(sessionId);
  }

  /* ---------------------------------- reads -------------------------------- */

  /** The row, whether or not this process has a live record for it. */
  session(sessionId: string): TerminalSession {
    const row = this.database
      .prepare("SELECT * FROM terminal_sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound("Terminal session not found");
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      cwd: String(row.cwd),
      shell: String(row.shell),
      command: (row.command as string | null) ?? null,
      kind: String(row.kind),
      ownerNodeId: (row.owner_node_id as string | null) ?? null,
      agentId: (row.agent_id as string | null) ?? null,
      status: String(row.status),
      exitCode: (row.exit_code as number | null) ?? null,
      pid: this.pid(sessionId),
      createdAt: String(row.created_at),
      endedAt: (row.ended_at as string | null) ?? null,
      sessionKey: String(row.session_key),
      backend: String(row.backend_kind),
      generation: Number(row.generation ?? 0),
      attachState: String(row.attach_state),
      lastOutputAt: (row.last_output_at as string | null) ?? null,
    };
  }

  exists(sessionId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM terminal_sessions WHERE id = ?")
        .get(sessionId) !== undefined
    );
  }

  generation(sessionId: string): number | undefined {
    const record = this.records.get(sessionId);
    if (record !== undefined) return record.generation;
    if (!this.exists(sessionId)) return undefined;
    return this.session(sessionId).generation;
  }

  /** `null` once the session has ended, so the sidebar can show it as gone. */
  pid(sessionId: string): number | null {
    const record = this.records.get(sessionId);
    if (record === undefined || record.exited) return null;
    return record.pid ?? null;
  }

  isAlive(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    return record !== undefined && !record.exited;
  }

  /** The highest input this session applied for a writer. */
  acknowledgedInput(sessionId: string, writerId: string): number {
    return this.inputs.acknowledged(sessionId, writerId);
  }

  /** Whether a backend of this build can reach this kind of session at all. */
  backendKinds(): BackendKind[] {
    return [...this.backends.keys()];
  }

  effectiveKind(): BackendKind {
    return this.effective;
  }

  /* --------------------------------- attach -------------------------------- */

  async attach(sessionId: string, size: TerminalSize): Promise<AttachSession> {
    if (this.stopping) throw conflict("Core is shutting down");
    const record = this.records.get(sessionId);
    if (record === undefined || record.exited) {
      throw notFound("Terminal session is not running");
    }
    const backend = this.backend(record.kind);
    const attachment = await backend.attach(
      record.key,
      record.generation,
      size,
    );
    // Waking is deliberately *after* the backend attach and deliberately not a
    // create: a dormant session is a running process whose delivery was slowed
    // down, so all that has to be undone is the slowing down.
    if (this.attachments.takeDormant(sessionId)) {
      try {
        await backend.setDormant(record.key, false);
      } catch {
        // A session that cannot be woken still attaches; the worst outcome is
        // half a second of extra latency, which is not worth a failed attach.
      }
    }
    this.attachments.acquire(sessionId);
    record.cols = size.cols;
    record.rows = size.rows;
    this.setAttachState(sessionId, "live");
    // Only a backend that does not redraw owes the socket a replay.
    const snapshot = backend.getCapabilities().redrawsOnAttach
      ? undefined
      : backend.snapshot?.(record.key);
    return { attachment, record, snapshot };
  }

  /** Called when a socket closes. Detaching is not terminating. */
  async detached(sessionId: string, attachmentId: number): Promise<void> {
    const record = this.records.get(sessionId);
    this.attachments.release(sessionId);
    if (record === undefined) return;
    await this.backend(record.kind).detach(record.key, attachmentId);
    if (!record.exited) this.setAttachState(sessionId, "detached");
  }

  /* ---------------------------------- input -------------------------------- */

  async input(
    sessionId: string,
    generation: number,
    data: string,
  ): Promise<void> {
    const first = this.checked(sessionId, generation);
    return this.withKey(first.key, async () => {
      const record = this.checked(sessionId, generation);
      const bytes = Buffer.from(data, "utf8");
      this.noteInput(record, bytes);
      await this.backend(record.kind).input(record.key, bytes);
    });
  }

  /** Records that `inputId` from `writerId` reached the pty. */
  noteInputApplied(sessionId: string, writerId: string, inputId: number): void {
    this.inputs.applied(sessionId, writerId, inputId);
  }

  async resize(
    sessionId: string,
    generation: number,
    size: TerminalSize,
  ): Promise<void> {
    const record = this.checked(sessionId, generation);
    record.cols = Math.max(2, size.cols);
    record.rows = Math.max(2, size.rows);
    await this.backend(record.kind).resize(record.key, {
      cols: record.cols,
      rows: record.rows,
    });
  }

  /**
   * Bracketed paste. The text is stripped of escapes before it goes anywhere:
   * a paste must be data, and a pasted `[201~` that closed the bracket
   * itself would turn the rest into keystrokes.
   */
  async paste(
    sessionId: string,
    text: string,
    pressEnter: boolean,
  ): Promise<void> {
    const first = this.require(sessionId);
    return this.withKey(first.key, async () => {
      const record = this.require(sessionId);
      this.noteInput(record, Buffer.from(text, "utf8"));
      await this.backend(record.kind).paste(record.key, text, pressEnter);
    });
  }

  async capture(
    sessionId: string,
    lines: number,
    withEscapes: boolean,
  ): Promise<{ generation: number; lines: number; data: string }> {
    const record = this.require(sessionId);
    const data = await this.backend(record.kind).capture(
      record.key,
      lines,
      withEscapes,
    );
    return {
      generation: record.generation,
      lines: data === "" ? 0 : data.split("\n").length,
      data,
    };
  }

  async scroll(sessionId: string, lines: number): Promise<void> {
    const record = this.require(sessionId);
    await this.backend(record.kind).scroll(record.key, lines);
  }

  async foreground(sessionId: string): Promise<ForegroundInfo> {
    const record = this.require(sessionId);
    return this.backend(record.kind).getForeground(record.key);
  }

  private noteInput(record: SessionRecord, bytes: Buffer): void {
    const { edited } = record.inputSafety.consume(bytes);
    if (edited) record.inputRevision += 1;
    // Typing counts as activity even when the CLI answers with nothing at all,
    // which is what gives "asked, and then silence" its quiet period.
    record.lastActivity = this.clock();
  }

  /**
   * Whether an automated write may be delivered into this node right now.
   *
   * A paste into a node showing a permission prompt answers the prompt: the
   * first character of the text becomes the answer to "allow this?". That is
   * the one input mistake a person cannot undo, so the programmatic paths ask
   * here first. A person typing at their own prompt is not gated.
   */
  writable(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (record === undefined || record.exited) return false;
    if (record.ownerNodeId === null) return true;
    const row = this.database
      .prepare("SELECT state FROM agent_status WHERE node_id = ?")
      .get(record.ownerNodeId) as { state?: string } | undefined;
    const state = row?.state;
    return state !== "blocked" && state !== "waiting";
  }

  /* -------------------------------- terminate ------------------------------ */

  async terminate(sessionId: string, mode: TerminateMode): Promise<void> {
    const first = this.require(sessionId);
    return this.withKey(first.key, async () => {
      const record = this.require(sessionId);
      this.database
        .prepare(
          "UPDATE terminal_sessions SET termination_intent = ? WHERE id = ?",
        )
        .run(mode === "interrupt" ? "none" : mode, sessionId);
      if (mode === "interrupt") {
        await this.backend(record.kind).signal(record.key, "interrupt");
        return;
      }
      // Marked before the kill: the exit that follows is this termination, not
      // an independent one, and must not overwrite it with `exited`.
      record.exited = true;
      await this.backend(record.kind).terminate(record.key, mode);
      // The exit watcher would report `exited`; an explicit kill is recorded
      // as `terminated` and wins because the watcher only touches `running`.
      this.database
        .prepare(
          `UPDATE terminal_sessions SET status = 'terminated', attach_state = 'exited',
               ended_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(this.now(), sessionId);
    });
  }

  /**
   * Every session of one workspace, killed and destroyed for good.
   *
   * Deleting a workspace cascades the rows out of the database, so anything
   * still running — a direct PTY, or a tmux session designed to outlive us —
   * would be left with nothing pointing at it. Hence destroy, not terminate.
   */
  async destroyWorkspace(workspaceId: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const record of this.records.values()) {
      if (record.workspaceId === workspaceId) ids.add(record.id);
    }
    const rows = this.database
      .prepare(
        "SELECT id, backend_ref, backend_kind FROM terminal_sessions WHERE workspace_id = ?",
      )
      .all(workspaceId) as Record<string, unknown>[];
    for (const row of rows) ids.add(String(row.id));

    for (const sessionId of ids) {
      const record = this.records.get(sessionId);
      if (record !== undefined) {
        record.exited = true;
        try {
          await this.backend(record.kind).terminate(record.key, "session");
        } catch {
          // A session we cannot reach is already gone as far as the removal
          // is concerned.
        }
        this.forget(sessionId);
        continue;
      }
      // Not ours to attach to, but the backend may still have it.
      const row = rows.find((entry) => String(entry.id) === sessionId);
      const reference = (row?.backend_ref as string | null) ?? null;
      const kind = String(row?.backend_kind ?? "");
      const backend = this.backends.get(kind as BackendKind);
      if (reference === null || backend === undefined) continue;
      try {
        await backend.destroyByReference(reference);
      } catch {
        // Same reasoning: unreachable is indistinguishable from already gone.
      }
    }
    return [...ids];
  }

  /* ---------------------------------- rows --------------------------------- */

  /**
   * Output moves `last_output_at` and nothing else. It is a **row update, not
   * a row per chunk**: the byte stream never touches SQLite (design §9), and
   * this is throttled so continuous output costs one write every few seconds.
   */
  noteOutput(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record !== undefined) record.lastActivity = this.clock();
    const now = this.clock();
    const last = this.lastRowWrite.get(sessionId) ?? 0;
    if (now - last < ACTIVITY_THROTTLE_MS) return;
    this.lastRowWrite.set(sessionId, now);
    this.database
      .prepare("UPDATE terminal_sessions SET last_output_at = ? WHERE id = ?")
      .run(this.now(), sessionId);
  }

  setAttachState(sessionId: string, state: "live" | "detached"): void {
    this.database
      .prepare(
        `UPDATE terminal_sessions SET attach_state = ?
           WHERE id = ? AND status = 'running'`,
      )
      .run(state, sessionId);
  }

  markExited(sessionId: string, exitCode: number | null): void {
    const record = this.records.get(sessionId);
    if (record !== undefined) record.exited = true;
    const result = this.database
      .prepare(
        `UPDATE terminal_sessions
            SET status = 'exited', exit_code = ?, ended_at = ?, attach_state = 'exited'
          WHERE id = ? AND status = 'running'`,
      )
      .run(exitCode, this.now(), sessionId);
    // `AND status = 'running'` keeps an explicit `terminated` from being
    // overwritten by the exit that follows it — but the attach state still has
    // to move, or the row claims somebody is watching a dead pane.
    if (Number(result.changes ?? 0) === 0) {
      this.database
        .prepare(
          "UPDATE terminal_sessions SET attach_state = 'exited' WHERE id = ?",
        )
        .run(sessionId);
      return;
    }
    if (record !== undefined) {
      this.onExit?.({
        workspaceId: record.workspaceId,
        sessionId,
        nodeId: record.ownerNodeId,
        exitCode,
      });
    }
  }

  /* ------------------------------- background ------------------------------ */

  /**
   * A persistent session can end while nothing is attached, and nobody would
   * notice until the next attach. One `list` covers every session at once.
   */
  async pollLiveness(): Promise<void> {
    for (const [kind, backend] of this.backends) {
      if (!persistent(kind)) continue;
      const records = [...this.records.values()].filter(
        (record) => record.kind === kind && !record.exited,
      );
      if (records.length === 0) continue;
      let alive: Set<string>;
      try {
        alive = new Set((await backend.list()).map((entry) => entry.name));
      } catch {
        continue;
      }
      for (const record of records) {
        const reference = this.database
          .prepare("SELECT backend_ref FROM terminal_sessions WHERE id = ?")
          .get(record.id) as { backend_ref?: string | null } | undefined;
        const name = reference?.backend_ref;
        if (name === undefined || name === null) continue;
        if (alive.has(name)) continue;
        this.markExited(record.id, null);
      }
    }
  }

  /** One reclamation round (contract §15.6). Returns what it destroyed. */
  async sweep(): Promise<string[]> {
    const grace = this.policy().detachedGraceMinutes;
    const candidates = gcCandidates(
      attachableRows(this.database),
      this.clock(),
      grace,
    );
    const destroyed: string[] = [];
    for (const sessionId of candidates) {
      // Somebody may have attached between the query and now.
      const state = this.database
        .prepare("SELECT attach_state FROM terminal_sessions WHERE id = ?")
        .get(sessionId) as { attach_state?: string } | undefined;
      if (state?.attach_state !== "detached") continue;
      if (this.attachments.sockets(sessionId) > 0) continue;
      const record = this.records.get(sessionId);
      if (record !== undefined) {
        try {
          await this.backend(record.kind).terminate(record.key, "session");
        } catch {
          // Unreachable is the same as gone for the purposes of a sweep.
        }
        this.forget(sessionId);
      } else {
        const row = this.database
          .prepare(
            "SELECT backend_ref, backend_kind FROM terminal_sessions WHERE id = ?",
          )
          .get(sessionId) as
          | { backend_ref?: string | null; backend_kind?: string }
          | undefined;
        const backend = this.backends.get(row?.backend_kind as BackendKind);
        if (backend !== undefined && row?.backend_ref) {
          try {
            await backend.destroyByReference(row.backend_ref);
          } catch {
            // Same.
          }
        }
      }
      this.database
        .prepare(
          `UPDATE terminal_sessions
              SET attach_state = 'exited',
                  status = CASE WHEN status = 'running' THEN 'exited' ELSE status END,
                  ended_at = COALESCE(ended_at, ?)
            WHERE id = ?`,
        )
        .run(this.now(), sessionId);
      destroyed.push(sessionId);
    }
    return destroyed;
  }

  /** Runs the dormancy policy. Separate from the loop so a test can drive it. */
  async applyDormancy(): Promise<void> {
    const after = this.policy().dormantAfterSeconds;
    if (after === 0) return;
    for (const sessionId of this.attachments.due(after * 1_000)) {
      const record = this.records.get(sessionId);
      if (record === undefined || record.exited) {
        this.attachments.forget(sessionId);
        continue;
      }
      try {
        await this.backend(record.kind).setDormant(record.key, true);
      } catch {
        continue;
      }
      this.attachments.markDormant(sessionId);
    }
  }

  isDormant(sessionId: string): boolean {
    return this.attachments.isDormant(sessionId);
  }

  /** How many sockets are watching this session right now. */
  attachedSockets(sessionId: string): number {
    return this.attachments.sockets(sessionId);
  }

  private async noticed(
    kind: BackendKind,
    notice: BackendNotice,
  ): Promise<void> {
    const sessionId = this.byKey.get(notice.key);
    if (sessionId === undefined) return;
    const record = this.records.get(sessionId);
    if (record === undefined || record.kind !== kind) return;
    if (record.generation !== notice.generation || record.exited) return;
    this.markExited(sessionId, notice.exitCode ?? null);
  }

  /**
   * Core shutdown.
   *
   * Sessions of a persistent backend are left running on purpose: that is the
   * whole point of those backends, and their rows move to `detached` rather
   * than to an end. Direct sessions cannot survive us and are killed by their
   * own `detachAll`.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    for (const [kind, backend] of this.backends) {
      if (persistent(kind)) {
        this.database
          .prepare(
            `UPDATE terminal_sessions SET attach_state = 'detached'
               WHERE backend_kind = ? AND attach_state = 'live' AND status = 'running'`,
          )
          .run(kind);
      }
      try {
        await backend.detachAll();
      } catch {
        // Shutdown must not stall on one backend that is already gone.
      }
    }
  }

  /* --------------------------------- helpers ------------------------------- */

  private backend(kind: BackendKind): TerminalBackend {
    const backend = this.backends.get(kind);
    if (backend !== undefined) return backend;
    // A row whose backend this build cannot reach is not silently served by
    // another one: attaching a `sessionHost` row to the direct backend would
    // start a second process behind a key that already has one.
    throw notFound(`这个构建没有 ${kind} 终端后端`);
  }

  private require(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (record === undefined || record.exited) {
      throw notFound("Terminal session is not running");
    }
    return record;
  }

  /**
   * The record, refusing a caller that is a generation behind.
   *
   * A write against an old generation is a 409, never a silent write to the
   * session that replaced it: the socket turns that into a `stale` frame and
   * the page clears and reconnects.
   */
  private checked(sessionId: string, generation: number): SessionRecord {
    const record = this.require(sessionId);
    if (this.byKey.get(record.key) !== sessionId) {
      throw notFound("Terminal session is no longer current");
    }
    if (record.generation !== generation) {
      throw conflict(
        `Terminal generation ${generation} is stale; the session is at ${record.generation}`,
      );
    }
    return record;
  }

  /**
   * Serialises everything that can replace the process behind one key.
   *
   * A promise chain rather than a mutex: there is no `Drop` to release a lock
   * on a throw, and a chain releases by construction — the next waiter is the
   * `.then` of the previous one, whether it settled or rejected.
   */
  private withKey<T>(key: SessionKey, job: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    this.gates.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
