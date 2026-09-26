import { canvasLaunchLine, nodeDialect } from "../agent/canvas-launch";
import {
  LaunchRefused,
  expectedProcesses,
  paneRunsAgent,
} from "../agent/launch";
import { listAgents } from "../agent/list";
import { loadBoard, saveBoard } from "../canvas/documents";
import type { CanvasNode } from "../canvas/document-types";
import { loadNode, loadSession, workspaceRoot } from "../collab/nodes";
import { enqueue } from "../collab/send-queue";
import type { CollabContext } from "../collab/service";
import { DomainError, uuidV7 } from "../workspaces/support";
import type { LaunchRow } from "./store";

/**
 * 依赖满足之后，在服务端把下游启动起来（Agent 自动化设计 §6）。
 *
 * 页面上的那条启动路径是：挂载 → 起一个 shell → 等提示符安静下来 → 敲启动
 * 行。这里走的是**同一条**，只是由 core 自己走：
 *
 *   1. 节点已经有一个活着的终端（页面开着、shell 已经起了），就往那个 shell
 *      里敲——前台已经是这个 Agent 的话什么都不敲，那是它已经起来了；
 *   2. 没有，就借终端域的 `spawnForNode` 起一个，与 `POST /api/terminals` 同一
 *      套环境与节点令牌，再把会话 id 记进节点数据，页面之后挂载时贴回同一个
 *      pane 而不是再起一个；
 *   3. 第一条任务（`--task`）在这之后才进投递队列，`origin = 'first-task'`，由
 *      出队泵等它报出第一条真正的 idle 再投——与不带依赖的 `open-agent --task`
 *      是同一条路，这里不写第二套往 PTY 里敲正文的逻辑。
 *
 * 启动行与页面拼的是同一份，经 `agent/canvas-launch.ts` 这一个出口：权限模式
 * 与模型的旗标、`GET /api/agents` 那一行给的本机程序路径，加上画布注入的 argv
 * （Hook、技能、画布说明——少了 Hook 不上报，第一条任务就永远等不到 idle）。
 */

/** 提示符安静这么久就敲（与页面 `LAUNCH_QUIET_MS` 同一个数）。 */
export const LAUNCH_QUIET_MS = 400;
/** 一直没有输出也最多等这么久（与页面 `LAUNCH_COLD_MS` 同一个数）。 */
export const LAUNCH_COLD_MS = 3_000;
/** 轮询 shell 输出的间隔。 */
const QUIET_POLL_MS = 100;
/** 写回节点数据时撞上并发保存，最多重来几次。 */
const SAVE_ATTEMPTS = 3;

export interface LaunchEnvironment {
  readonly collab: CollabContext;
  readonly clock: () => number;
  readonly delay: (ms: number) => Promise<void>;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export type LaunchOutcome =
  | {
      readonly kind: "launched";
      readonly sessionId: string;
      readonly taskQueueId: string | null;
      readonly command: string;
    }
  /** 这一次没起来，但下一轮扫描还值得再试。 */
  | { readonly kind: "retry"; readonly reason: string }
  /** 再试也不会好。 */
  | { readonly kind: "failed"; readonly reason: string }
  /** 下游节点已经不在画布上了。 */
  | { readonly kind: "gone" };

export async function launchNode(
  environment: LaunchEnvironment,
  launch: LaunchRow,
): Promise<LaunchOutcome> {
  const { collab } = environment;
  const database = collab.database;
  const node = loadNode(database, launch.nodeId);
  if (node === undefined) return { kind: "gone" };
  const agentId = node.agentId;
  if (agentId === null) return { kind: "failed", reason: "notAgent" };

  let command: string;
  try {
    command = launchLine(
      collab,
      agentId,
      node.data,
      liveShell(database, launch.nodeId),
    );
  } catch (error) {
    if (error instanceof LaunchRefused) {
      return { kind: "failed", reason: "launchRefused" };
    }
    throw error;
  }

  const terminals = collab.terminals;
  if (terminals === undefined) return { kind: "retry", reason: "noTerminal" };

  let sessionId: string;
  let generation: number;
  let spawned = false;
  const existing = loadSession(database, launch.nodeId);
  const live =
    existing === undefined
      ? undefined
      : terminals.generation(existing.sessionId);
  if (existing !== undefined && live !== undefined) {
    sessionId = existing.sessionId;
    generation = live;
    const foreground = await terminals
      .foreground(sessionId)
      .catch(() => undefined);
    if (
      foreground !== undefined &&
      paneRunsAgent(foreground, expectedProcesses(agentId))
    ) {
      // 已经在跑这个 Agent（人手动起的，或者上一次启动写完行之后 core 没来得
      // 及落账就重启了）。再敲一遍就是往 Agent 的输入框里打一行命令。
      return finish(environment, launch, node, {
        sessionId,
        spawned,
        command,
        wrote: false,
      });
    }
    if (foreground !== undefined && (foreground.children ?? []).length > 0) {
      // shell 前台跑着别的程序：启动行敲进去就是那个程序的输入。
      return { kind: "retry", reason: "paneBusy" };
    }
  } else {
    if (terminals.spawnForNode === undefined) {
      return { kind: "retry", reason: "noTerminal" };
    }
    const cwd =
      stringField(node.data, "cwd") ??
      workspaceRoot(database, node.workspaceId);
    if (cwd === undefined) return { kind: "failed", reason: "noWorkspace" };
    const ssh = node.data.ssh;
    const sshHostId =
      ssh !== null && typeof ssh === "object"
        ? stringField(ssh as Record<string, unknown>, "hostId")
        : undefined;
    try {
      const started = await terminals.spawnForNode({
        workspaceId: node.workspaceId,
        nodeId: node.id,
        agentId,
        cwd,
        shell: stringField(node.data, "shell"),
        sshHostId,
      });
      sessionId = started.sessionId;
      generation = started.generation;
      spawned = true;
    } catch (error) {
      environment.log("依赖满足后无法为节点起终端", {
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "retry", reason: "spawnFailed" };
    }
  }

  const quiet = await waitForPrompt(environment, sessionId);
  if (quiet === "pending") {
    // 有人在这个 shell 里敲了半行：启动行接在后面就成了一条没人写过的命令。
    return { kind: "retry", reason: "inputPending" };
  }
  try {
    await terminals.write(sessionId, generation, `${command}\r`);
  } catch (error) {
    environment.log("依赖满足后无法写入启动行", {
      nodeId: node.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "retry", reason: "writeFailed" };
  }
  return finish(environment, launch, node, {
    sessionId,
    spawned,
    command,
    wrote: true,
  });
}

/**
 * 启动行已经落地（或者本来就在跑）：记账、排第一条任务。
 *
 * 任务排队的失败不回滚启动——节点已经起来了，那一条任务可以再 `send` 一次，
 * 而一个起来了却被记成「没启动」的节点会在下一轮扫描里被再敲一遍启动行。
 */
function finish(
  environment: LaunchEnvironment,
  launch: LaunchRow,
  node: {
    readonly id: string;
    readonly boardId: string;
    readonly workspaceId: string;
  },
  landed: {
    readonly sessionId: string;
    readonly spawned: boolean;
    readonly command: string;
    readonly wrote: boolean;
  },
): LaunchOutcome {
  const { collab } = environment;
  recordOnNode(environment, node, landed);
  let taskQueueId: string | null = null;
  if (launch.taskBody !== null) {
    const nowSeconds = Math.floor(environment.clock() / 1000);
    const inserted = enqueue(collab.database, {
      id: uuidV7(),
      workspaceId: launch.workspaceId,
      sourceNodeId: launch.taskSourceNodeId ?? launch.nodeId,
      targetNodeId: launch.nodeId,
      origin: "first-task",
      // 幂等键：记账之前 core 被杀掉、重启后再走一遍时，同一条任务不会排两次。
      messageKey: `dependency:${launch.nodeId}`,
      body: launch.taskBody,
      hops: launch.taskHops,
      trail: launch.taskTrail,
      now: nowSeconds,
      state: "queued",
    });
    if (inserted.kind === "inserted" || inserted.kind === "duplicate") {
      taskQueueId = inserted.item.id;
    } else {
      environment.log("依赖满足后第一条任务没有排上", {
        nodeId: launch.nodeId,
        outcome: inserted.kind,
      });
    }
    // 推一下泵：「启动不上报」的 CLI，第一条空闲只能靠探。
    collab.nudge?.(launch.nodeId);
  }
  return {
    kind: "launched",
    sessionId: landed.sessionId,
    taskQueueId,
    command: landed.command,
  };
}

/**
 * 与页面的 `buildAgentLaunch` 拼同一行：程序（本机解析到的路径优先）、权限
 * 模式与模型的旗标、自定义条目的 argv、画布注入的 argv。
 */
export function launchLine(
  collab: CollabContext,
  agentId: string,
  data: Record<string, unknown>,
  sessionShell?: string,
): string {
  const agent =
    data.agent !== null && typeof data.agent === "object"
      ? (data.agent as Record<string, unknown>)
      : {};
  const permissionMode = stringField(agent, "permissionMode");
  const model = stringField(agent, "model");
  let row: ReturnType<typeof listAgents>[number] | undefined;
  try {
    row = listAgents({
      dataDir: collab.dataDir,
      settings: collab.settings,
    }).find((entry) => entry.id === agentId);
  } catch {
    row = undefined;
  }
  // 写成节点终端那个 shell 的方言：已经有终端就是它实际跑的那个，否则是
  // `spawnForNode` 马上要起的那个（节点指定的，或者本机缺省的）。
  const ssh = data.ssh !== null && typeof data.ssh === "object";
  return canvasLaunchLine({
    settings: collab.settings,
    dataDir: collab.dataDir,
    agentId,
    dialect: nodeDialect(sessionShell ?? stringField(data, "shell"), ssh),
    ssh,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(model === undefined ? {} : { model }),
    ...(row?.resolvedPath == null ? {} : { program: row.resolvedPath }),
  });
}

/** 节点正在跑的那个终端的 shell；没有活着的终端时不答。 */
function liveShell(
  database: CollabContext["database"],
  nodeId: string,
): string | undefined {
  const row = database
    .prepare(
      "SELECT shell FROM terminal_sessions WHERE owner_node_id = ? AND status = 'running' " +
        "ORDER BY generation DESC, created_at DESC LIMIT 1",
    )
    .get(nodeId) as { shell?: unknown } | undefined;
  return typeof row?.shell === "string" && row.shell !== ""
    ? row.shell
    : undefined;
}

/**
 * 等提示符安静下来，与页面的启动时序同一个判据：有输出之后安静
 * {@link LAUNCH_QUIET_MS}，或者一直没有输出、等满 {@link LAUNCH_COLD_MS}。
 * 有半截没提交的输入时答 `pending`，由调用方改天再试。
 */
async function waitForPrompt(
  environment: LaunchEnvironment,
  sessionId: string,
): Promise<"quiet" | "pending"> {
  const terminals = environment.collab.terminals;
  const started = environment.clock();
  for (;;) {
    const observed = terminals?.observed?.(sessionId);
    if (observed?.pending === true) return "pending";
    const now = environment.clock();
    const last = observed?.lastOutputAt;
    if (last !== undefined && now - last >= LAUNCH_QUIET_MS) return "quiet";
    if (now - started >= LAUNCH_COLD_MS) return "quiet";
    await environment.delay(QUIET_POLL_MS);
  }
}

/**
 * 把这次启动记进节点数据：启动行是 `initialCommand`（记账，不是指令），自己起
 * 的终端还要记下会话 id，旧的 `pendingLaunch` 一并摘掉。
 *
 * 走画布自己的乐观并发保存，撞上页面同时在存就重读再来；三次都撞上只记一行
 * 日志——终端已经起来了，节点数据落后一拍比把启动记成失败要好。
 */
function recordOnNode(
  environment: LaunchEnvironment,
  node: {
    readonly id: string;
    readonly boardId: string;
    readonly workspaceId: string;
  },
  landed: {
    readonly sessionId: string;
    readonly spawned: boolean;
    readonly command: string;
  },
): void {
  const { collab } = environment;
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    let document;
    try {
      document = loadBoard(collab.database, node.workspaceId, node.boardId);
    } catch {
      return;
    }
    let changed = false;
    const nodes = document.nodes.map((entry): CanvasNode => {
      if (entry.id !== node.id) return entry;
      const data =
        entry.data !== null && typeof entry.data === "object"
          ? { ...(entry.data as Record<string, unknown>) }
          : {};
      const agent =
        data.agent !== null && typeof data.agent === "object"
          ? { ...(data.agent as Record<string, unknown>) }
          : {};
      delete agent.pendingLaunch;
      agent.initialCommand = landed.command;
      data.agent = agent;
      if (landed.spawned) {
        data.sessionId = landed.sessionId;
        data.lastExitCode = null;
      }
      changed = true;
      return { ...entry, data };
    });
    if (!changed) return;
    try {
      const saved = saveBoard(collab.database, node.workspaceId, node.boardId, {
        expectedUpdatedAt: document.board.updatedAt,
        nodes,
        edges: document.edges,
        viewport: document.board.viewport,
      });
      collab.publish(node.workspaceId, {
        type: "board.changed",
        boardId: saved.board.id,
        updatedAt: saved.board.updatedAt,
      });
      return;
    } catch (error) {
      if (error instanceof DomainError && error.status === 409) continue;
      environment.log("依赖启动后无法写回节点数据", {
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}
