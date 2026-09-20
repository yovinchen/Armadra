/**
 * 受管进程的追踪：哪些终端会话该被测，它们的领头进程是哪个 pid。
 *
 * ## 为什么从库 + tmux 读，而不是从终端域拿
 *
 * Rust 那边的 `TerminalManager` 在内存里记着每个会话的 pid，采样直接问它。TS core
 * 的终端域不导出一个可变的全局句柄（`terminal/install.ts` 把 `TerminalDomain`
 * 交给装配方，`main.ts` 并不保存它），所以这里走两个都能独立核对的来源：
 *
 *   * `terminal_sessions` 表给身份——工作空间、节点、代次、cwd、后端句柄；
 *   * `tmux -S <dataDir>/tmux.sock list-panes -a` 给**当前**的 pane pid。问的必须是
 *     core 自己那台服务器，不是用户默认的那台（见 `tmuxServerArgs`）。
 *
 * 这比缓存一个 pid 更不容易说谎：一个被重建过的 pane 会带着新的 pid 回来，而一个
 * 内存里的副本会继续指着一个已经不在的号码。tmux 不在或者没有服务器在跑时那张表
 * 是空的——于是每个会话报 `no-pid`，而不是报一个零。
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { isRemoteExecutable, type SessionTarget } from "./sample";

/** `terminal_sessions` 里一行的样子，只取采样要用的列。 */
interface SessionRow {
  readonly id: string;
  readonly sessionKey: string;
  readonly workspaceId: string;
  readonly ownerNodeId: string | null;
  readonly backendKind: string;
  readonly backendRef: string | null;
  readonly generation: number;
  readonly cwd: string;
  readonly shell: string;
  readonly attachState: string;
  readonly status: string;
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

function nullableText(
  row: Record<string, unknown>,
  column: string,
): string | null {
  const value = row[column];
  return typeof value === "string" && value !== "" ? value : null;
}

function integer(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" ? value : 0;
}

const SESSION_COLUMNS =
  "SELECT id, session_key, workspace_id, owner_node_id, backend_kind, backend_ref, generation, cwd, shell, attach_state, status FROM terminal_sessions";

function toRow(row: Record<string, unknown>): SessionRow {
  return {
    id: text(row, "id"),
    sessionKey: text(row, "session_key"),
    workspaceId: text(row, "workspace_id"),
    ownerNodeId: nullableText(row, "owner_node_id"),
    backendKind: text(row, "backend_kind"),
    backendRef: nullableText(row, "backend_ref"),
    generation: integer(row, "generation"),
    cwd: text(row, "cwd"),
    shell: text(row, "shell"),
    attachState: text(row, "attach_state"),
    status: text(row, "status"),
  };
}

/**
 * core 自己那台 tmux 服务器的寻址参数。
 *
 * 少了它，`tmux list-panes -a` 问的是**用户默认的**那台服务器
 * （`/tmp/tmux-<uid>/default`），而 core 的会话全部活在
 * `-S <dataDir>/tmux.sock` 上（`terminal/tmux/control.ts`）。两台服务器互不
 * 知情，于是每个会话都报 `no-pid`：面板里没有进程号、没有 CPU、没有内存、
 * 没有进程树，`no-row` 孤立会话也永远扫不出来。
 *
 * 数据目录取不到时退回裸 `tmux`——单测与移植期的调用方还这么用，而一个问错
 * 服务器的空表和今天的行为一模一样，不会更糟。
 */
export function tmuxServerArgs(dataDir: string | undefined): string[] {
  if (dataDir === undefined) return [];
  return ["-S", join(dataDir, "tmux.sock"), "-f", join(dataDir, "tmux.conf")];
}

/** tmux 会话名 → pane pid。tmux 不在就是空表。 */
export function panePids(dataDir?: string): Map<string, number> {
  const pids = new Map<string, number>();
  if (process.platform === "win32") return pids;
  let output: string;
  try {
    output = execFileSync(
      "tmux",
      [
        ...tmuxServerArgs(dataDir),
        "list-panes",
        "-a",
        "-F",
        "#{session_name} #{pane_pid}",
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    // 「没有服务器在跑」是空的情况，不是失败。
    return pids;
  }
  for (const line of output.split("\n")) {
    const [name, raw] = line.trim().split(/\s+/);
    if (name === undefined || raw === undefined) continue;
    const pid = Number.parseInt(raw, 10);
    // 一个 tmux 会话里可能有多个 pane；第一个是领头的那个。
    if (Number.isInteger(pid) && pid > 0 && !pids.has(name)) {
      pids.set(name, pid);
    }
  }
  return pids;
}

/**
 * 一个工作空间里该被测的会话，按面板显示的顺序：活着的在前，然后按会话 id，这样
 * 表不会跳。
 */
export function sessionTargets(
  database: DatabaseSync,
  workspaceId: string,
  pids: ReadonlyMap<string, number> = panePids(),
): SessionTarget[] {
  const rows = database
    .prepare(
      `${SESSION_COLUMNS} WHERE workspace_id = ? AND status = 'running' ORDER BY id`,
    )
    .all(workspaceId) as Record<string, unknown>[];
  const targets = rows.map((raw) => {
    const row = toRow(raw);
    const pid = row.backendRef === null ? undefined : pids.get(row.backendRef);
    return {
      sessionId: row.id,
      sessionKey: row.sessionKey,
      workspaceId: row.workspaceId,
      nodeId: row.ownerNodeId,
      generation: row.generation,
      backend: row.backendKind,
      cwd: row.cwd,
      pid: pid ?? null,
      exited: row.attachState === "exited",
      remote: isRemoteExecutable(row.shell),
    } satisfies SessionTarget;
  });
  targets.sort(
    (left, right) =>
      Number(left.exited) - Number(right.exited) ||
      left.sessionId.localeCompare(right.sessionId),
  );
  return targets;
}

/* -------------------------------- 孤立会话 -------------------------------- */
//
// 两种形状，而且它们不是同一个问题（移植自 `apps/runtime/src/resources/orphans.rs`）：
//
//   * **`no-node`** —— 一个会话行，它归属的节点被从画布上删掉了（或者它从来没有
//     节点）。这行还知道工作目录、shell 和工作空间，所以可以再给它一个节点。
//   * **`no-row`** —— 一个 `armadra-*` 的 tmux 会话，一行都没有。除了名字之外对它
//     一无所知，所以只能把它终止掉。
//
// 孤立会话不会在没被要求时被碰：列出来是只读的。

export type OrphanReason = "no-node" | "no-row";

export interface OrphanSession {
  /** 两个动作用的不透明句柄。有行的是 `session:<id>`，没行的是 `ref:<后端句柄>`。 */
  readonly id: string;
  readonly reason: OrphanReason;
  readonly sessionId: string | null;
  readonly backendRef: string | null;
  readonly workspaceId: string | null;
  /**
   * 这个会话过去归属的节点。它已经不在任何板子上了；认领会重用这个 id，所以会话
   * 保住自己的身份。
   */
  readonly nodeId: string | null;
  readonly sessionKey: string | null;
  readonly cwd: string | null;
  readonly agentId: string | null;
  readonly createdAt: string | null;
  readonly lastOutputAt: string | null;
  /** 有行的会话可以被重新给一个节点；没行的不行。 */
  readonly adoptable: boolean;
}

/** `adopt` 答什么：客户端该建哪个节点，这个会话才算重新有主。 */
export interface AdoptedSession {
  readonly sessionId: string;
  /**
   * 新画布节点必须用的那个 id。
   *
   * 它是这个会话自己的 key，所以 `by_key` 查找、上下文报告和回收都和节点被删之前
   * 一模一样地继续工作。
   */
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly agentId: string | null;
  readonly generation: number;
}

/** 一个工作空间的全部孤立会话，加上那些没有行的后端会话。 */
export function listOrphans(
  database: DatabaseSync,
  workspaceId: string,
  aliveRefs: readonly string[],
): OrphanSession[] {
  const rows = database
    .prepare(
      "SELECT s.id AS id, s.session_key AS session_key, s.backend_ref AS backend_ref, " +
        "s.workspace_id AS workspace_id, s.owner_node_id AS owner_node_id, " +
        "s.cwd AS cwd, s.agent_id AS agent_id, s.created_at AS created_at, " +
        "s.last_output_at AS last_output_at " +
        "FROM terminal_sessions s " +
        "WHERE s.workspace_id = ? AND s.status = 'running' AND s.attach_state <> 'exited' " +
        "  AND (s.owner_node_id IS NULL " +
        "       OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = s.owner_node_id)) " +
        "ORDER BY s.created_at DESC LIMIT 200",
    )
    .all(workspaceId) as Record<string, unknown>[];

  const orphans: OrphanSession[] = [];
  const known = new Set<string>();
  for (const raw of rows) {
    const backendRef = nullableText(raw, "backend_ref");
    if (backendRef !== null) known.add(backendRef);
    orphans.push({
      id: `session:${text(raw, "id")}`,
      reason: "no-node",
      sessionId: text(raw, "id"),
      backendRef,
      workspaceId: nullableText(raw, "workspace_id"),
      nodeId: nullableText(raw, "owner_node_id"),
      sessionKey: nullableText(raw, "session_key"),
      cwd: nullableText(raw, "cwd"),
      agentId: nullableText(raw, "agent_id"),
      createdAt: nullableText(raw, "created_at"),
      lastOutputAt: nullableText(raw, "last_output_at"),
      adoptable: true,
    });
  }

  // 整个库里都没有行的后端会话——不只是这个工作空间里没有，否则每个工作空间都会
  // 认领其他工作空间的会话。
  const referenced = new Set(
    (
      database
        .prepare(
          "SELECT backend_ref FROM terminal_sessions WHERE backend_ref IS NOT NULL AND attach_state <> 'exited'",
        )
        .all() as Record<string, unknown>[]
    )
      .map((raw) => nullableText(raw, "backend_ref"))
      .filter((value): value is string => value !== null),
  );
  for (const reference of aliveRefs) {
    if (referenced.has(reference) || known.has(reference)) continue;
    orphans.push({
      id: `ref:${reference}`,
      reason: "no-row",
      sessionId: null,
      backendRef: reference,
      workspaceId: null,
      nodeId: null,
      sessionKey: null,
      cwd: null,
      agentId: null,
      createdAt: null,
      lastOutputAt: null,
      adoptable: false,
    });
  }
  return orphans;
}

/** 这台机器上 `armadra-` 开头的 tmux 会话名。 */
export function aliveBackendReferences(
  pids: ReadonlyMap<string, number> = panePids(),
): string[] {
  return [...pids.keys()].filter((name) => name.startsWith("armadra-")).sort();
}

export class OrphanError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrphanError";
  }
}

/**
 * 重新给一个孤立会话一个节点。
 *
 * core **不建这个节点**——板子由画布保存，`nodes` 表在每次保存时按文档重写。这里
 * 做的是把行重新绑定，并交回客户端必须使用的那个节点 id。这个 id 是会话自己的
 * key，所以用它建出来的节点会恢复成节点被删之前那条一模一样的绑定。
 */
export function adoptOrphan(
  database: DatabaseSync,
  workspaceId: string,
  sessionId: string,
): AdoptedSession {
  const raw = database
    .prepare(
      "SELECT session_key, workspace_id, owner_node_id, cwd, shell, agent_id, generation, status, attach_state FROM terminal_sessions WHERE id = ?",
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  if (raw === undefined) {
    throw new OrphanError(
      404,
      "not_found",
      "This terminal session does not exist",
    );
  }
  const owning = text(raw, "workspace_id");
  if (owning !== workspaceId) {
    throw new OrphanError(
      404,
      "not_found",
      "This terminal session belongs to another workspace",
    );
  }
  if (
    text(raw, "status") !== "running" ||
    text(raw, "attach_state") === "exited"
  ) {
    throw new OrphanError(
      409,
      "conflict",
      "This terminal session is no longer running",
    );
  }
  const sessionKey = text(raw, "session_key");
  // 节点 id 是 UUID（`create_terminal` 拒绝别的东西），一个没有节点的终端的 key
  // 也是——那是它自己的 UUIDv7。只有手改过的行会过不了这一条。
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      sessionKey,
    )
  ) {
    throw new OrphanError(
      409,
      "conflict",
      "This terminal session has no usable node identity",
    );
  }
  const nodeId = sessionKey;
  if (nullableText(raw, "owner_node_id") !== nodeId) {
    const existing = database
      .prepare(
        "SELECT id FROM terminal_sessions WHERE owner_node_id = ? AND id <> ? AND attach_state <> 'exited'",
      )
      .get(nodeId, sessionId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      throw new OrphanError(
        409,
        "conflict",
        "Another running session already owns that node",
      );
    }
    database
      .prepare("UPDATE terminal_sessions SET owner_node_id = ? WHERE id = ?")
      .run(nodeId, sessionId);
  }
  return {
    sessionId,
    nodeId,
    workspaceId: owning,
    cwd: text(raw, "cwd"),
    shell: text(raw, "shell"),
    agentId: nullableText(raw, "agent_id"),
    generation: integer(raw, "generation"),
  };
}

/**
 * 彻底结束一个孤立会话。
 *
 * 有行的走普通的会话拆除，只对 core 启动过的那棵进程树发信号。没有行的按后端句柄
 * 销毁——后端知道那个名字指的是它自己的哪个会话，别的一律拒绝。
 */
export function orphanTarget(
  database: DatabaseSync,
  workspaceId: string,
  orphanId: string,
): { kind: "session"; sessionId: string } | { kind: "ref"; reference: string } {
  if (orphanId.startsWith("session:")) {
    const sessionId = orphanId.slice("session:".length);
    const raw = database
      .prepare("SELECT workspace_id FROM terminal_sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (raw === undefined) {
      throw new OrphanError(
        404,
        "not_found",
        "This terminal session does not exist",
      );
    }
    if (text(raw, "workspace_id") !== workspaceId) {
      throw new OrphanError(
        404,
        "not_found",
        "This terminal session belongs to another workspace",
      );
    }
    return { kind: "session", sessionId };
  }
  if (orphanId.startsWith("ref:")) {
    return { kind: "ref", reference: orphanId.slice("ref:".length) };
  }
  throw new OrphanError(
    400,
    "bad_request",
    "An orphan id is `session:<id>` or `ref:<name>`",
  );
}
