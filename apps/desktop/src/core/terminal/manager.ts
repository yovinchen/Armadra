import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Attachment,
  type BackendKind,
  type SessionKey,
  type TerminalBackend,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  conflict,
  notFound,
  sessionKey,
} from "./backend";
import {
  type EnvPairs,
  contextSessionEnvironment,
  defaultShell,
  withUtf8Locale,
} from "./environment";

/**
 * The manager: what a session *is*, as opposed to what a backend *runs*.
 *
 * It owns the row in `terminal_sessions`, the generation counter and the
 * in-memory record that ties a session id to a backend key. The backend below
 * it knows nothing about either.
 *
 * ## What this batch deliberately does not do
 *
 * No GC, no start-up recovery, no recycle, no SSH, no `direct` or
 * `sessionHost`, and no `session_runs`/`session_claims` (the Host's half of
 * the session domain, which R1's merge migration brings over). Each of those
 * is a separate decision with its own failure mode, and the point of the
 * vertical slice is to prove the byte path, not to finish the domain.
 *
 * The columns written here are the Rust Runtime's, and are written with the
 * same values, because both implementations open the same database during the
 * changeover: `attach_state` is `detached` at creation and moves to `live` on
 * the first socket, `generation` starts at 1, `termination_intent` is `none`,
 * and `status` is `running` until an exit is observed.
 */

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

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
}

interface SessionRecord {
  readonly id: string;
  readonly key: SessionKey;
  readonly workspaceId: string;
  readonly kind: BackendKind;
  generation: number;
  pid: number | undefined;
  cols: number;
  rows: number;
  exited: boolean;
}

export interface TerminalManagerOptions {
  readonly database: DatabaseSync;
  readonly backend: TerminalBackend;
  /** Injected so a test can make the timestamps deterministic. */
  readonly now?: () => string;
}

export class TerminalManager {
  private readonly database: DatabaseSync;
  private readonly backend: TerminalBackend;
  private readonly records = new Map<string, SessionRecord>();
  private readonly now: () => string;

  constructor(options: TerminalManagerOptions) {
    this.database = options.database;
    this.backend = options.backend;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /* -------------------------------- lifecycle ------------------------------ */

  async spawn(request: SpawnRequest): Promise<TerminalSession> {
    const id = randomUUID();
    // A terminal that belongs to a node keys on the node, so the pane survives
    // the session row being replaced; one that does not keys on itself.
    const key = sessionKey(request.ownerNodeId ?? id);
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
    };
    const handle = await this.backend.create(spec);

    const createdAt = this.now();
    const kind = request.kind ?? "terminal";
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
        kind,
        request.ownerNodeId ?? null,
        request.agentId ?? null,
        createdAt,
        key,
        this.backend.kind,
        handle.backendRef ?? null,
        handle.generation,
      );

    this.records.set(id, {
      id,
      key,
      workspaceId: request.workspaceId,
      kind: this.backend.kind,
      generation: handle.generation,
      pid: handle.pid,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      exited: false,
    });

    return {
      id,
      workspaceId: request.workspaceId,
      cwd: request.cwd,
      shell,
      command: request.command ?? null,
      kind,
      ownerNodeId: request.ownerNodeId ?? null,
      agentId: request.agentId ?? null,
      status: "running",
      exitCode: null,
      pid: handle.pid ?? null,
      createdAt,
      endedAt: null,
      sessionKey: key,
      backend: this.backend.kind,
      generation: handle.generation,
      attachState: "detached",
      lastOutputAt: null,
    };
  }

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
      pid: this.records.get(sessionId)?.pid ?? null,
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

  isAlive(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    return record !== undefined && !record.exited;
  }

  /* --------------------------------- attach -------------------------------- */

  async attach(
    sessionId: string,
    size: TerminalSize,
  ): Promise<{
    readonly attachment: Attachment;
    readonly record: SessionRecord;
  }> {
    const record = this.records.get(sessionId);
    if (record === undefined || record.exited) {
      throw notFound("Terminal session is not running");
    }
    const attachment = await this.backend.attach(
      record.key,
      record.generation,
      size,
    );
    record.cols = size.cols;
    record.rows = size.rows;
    this.setAttachState(sessionId, "live");
    return { attachment, record };
  }

  /** Called when a socket closes. Detaching is not terminating. */
  async detached(sessionId: string, attachmentId: number): Promise<void> {
    const record = this.records.get(sessionId);
    if (record === undefined) return;
    await this.backend.detach(record.key, attachmentId);
    if (!record.exited) this.setAttachState(sessionId, "detached");
  }

  async input(
    sessionId: string,
    generation: number,
    data: string,
  ): Promise<void> {
    const record = this.require(sessionId, generation);
    await this.backend.input(record.key, Buffer.from(data, "utf8"));
  }

  async resize(
    sessionId: string,
    generation: number,
    size: TerminalSize,
  ): Promise<void> {
    const record = this.require(sessionId, generation);
    record.cols = size.cols;
    record.rows = size.rows;
    await this.backend.resize(record.key, size);
  }

  async terminate(sessionId: string, mode: TerminateMode): Promise<void> {
    const record = this.records.get(sessionId);
    if (record === undefined) throw notFound("Terminal session is not running");
    await this.backend.terminate(record.key, mode);
    if (mode === "session") this.markExited(sessionId, null);
  }

  /* --------------------------------- rows ---------------------------------- */

  /**
   * Output moves `last_output_at` and nothing else. It is a **row update, not
   * a row per chunk**: the byte stream never touches SQLite (design §9), and
   * this is called at most once a second by the socket, which is what makes
   * that true.
   */
  noteOutput(sessionId: string): void {
    this.database
      .prepare("UPDATE terminal_sessions SET last_output_at = ? WHERE id = ?")
      .run(this.now(), sessionId);
  }

  setAttachState(sessionId: string, state: "live" | "detached"): void {
    this.database
      .prepare("UPDATE terminal_sessions SET attach_state = ? WHERE id = ?")
      .run(state, sessionId);
  }

  markExited(sessionId: string, exitCode: number | null): void {
    const record = this.records.get(sessionId);
    if (record !== undefined) record.exited = true;
    this.database
      .prepare(
        `UPDATE terminal_sessions
            SET status = 'exited', exit_code = ?, ended_at = ?, attach_state = 'exited'
          WHERE id = ? AND status = 'running'`,
      )
      .run(exitCode, this.now(), sessionId);
  }

  async shutdown(): Promise<void> {
    await this.backend.detachAll();
  }

  /**
   * The record, refusing a caller that is a generation behind.
   *
   * A write against an old generation is a 409, never a silent write to the
   * session that replaced it: the socket turns that into a `stale` frame and
   * the page clears and reconnects.
   */
  private require(sessionId: string, generation: number): SessionRecord {
    const record = this.records.get(sessionId);
    if (record === undefined || record.exited) {
      throw notFound("Terminal session is not running");
    }
    if (record.generation !== generation) {
      throw conflict(
        `Terminal generation ${generation} is stale; the session is at ${record.generation}`,
      );
    }
    return record;
  }
}
