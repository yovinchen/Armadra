import type { DatabaseSync } from "node:sqlite";

import { canvasLaunchLine } from "../agent/canvas-launch";
import type { AgentSettings } from "../agent/registry";
import { loadBoard, saveBoard } from "../canvas/documents";
import type { NodeRef } from "../collab/nodes";
import type { WorkspaceEvent } from "../bus";
import { DomainError } from "../workspaces/support";
import type { AgentLaunchSpec } from "./types";

/**
 * 冷启动：计划写明了 `LAUNCH_FROZEN`，而目标节点上什么都没在跑（自动化设计
 * §4.2、§5）。
 *
 * 三条规矩，写在这里而不是散在调用点：
 *
 *   * **只在运行的目标探测里发生。** 那时 run 已认领、授权刚复查过。激活时的
 *     探测与写入前的复核都不起进程——前者只是问「这个目标用不用得了」，后者离
 *     写入只差一步，起一个进程在那里等于把「起 CLI」和「往里写」拼成了一次动作。
 *   * **程序由这台机器解析，不由计划决定。** 冻结的定义只有 `agentId` 与参数；
 *     程序名按 `agentId` 从注册表（含自定义 Agent）取，参数逐个 shell 引用后敲
 *     进 shell——计划里写不进 `;` 或 `&&`，一份存下来的计划永远变不成「运行这个
 *     二进制」。
 *   * **同一节点 60 秒内只冷启动一次。** 一个起来就退出的 CLI 不会变成每秒起一
 *     个进程的循环；窗口里再探到没有会话，答「离线」，这一次运行照常跳过。
 *
 * 起来之后报 `busy`：刚起的 CLI 还在铺界面，更没有「上一回合已结束」。放行要
 * 等一条**冷启动之后**才到的上报（`idle` / `done`），或者对启动时不上报的 CLI
 * 走 §4.3 的首投门——节点上旧会话留下的那行 `agent_status` 不算。
 */

/** 同一节点两次冷启动之间至少隔这么久。 */
export const COLD_START_COOLDOWN_MS = 60_000;

/** 冷启动要终端域做的那件事。 */
export interface AgentLaunchRequest {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly cwd: string;
  /** 已经解析好、逐个引用过的启动行，不含回车。 */
  readonly line: string;
}

export interface LaunchedSession {
  readonly sessionId: string;
  readonly generation: number;
}

/**
 * 终端域交回来的启动器。
 *
 * 注入而不是 import：调度域排在终端域之后装配，而终端域不该知道自动化是什么；
 * 反过来 import 管理器就是一个环。没有终端域的装配里它缺席，冷启动如实答离线。
 */
export type AgentLauncher = (
  request: AgentLaunchRequest,
) => Promise<LaunchedSession>;

let launcher: AgentLauncher | undefined;

export function setAgentLauncher(next: AgentLauncher | undefined): void {
  launcher = next;
}

export function agentLauncher(): AgentLauncher | undefined {
  return launcher;
}

/**
 * 冻结定义 → 敲进 shell 的那一行，经 `agent/canvas-launch.ts` 这一个出口：
 * 冻结的 argv 原样照用（权限模式与模型已经在里面），后面加画布注入的 argv
 * ——计划只认 agent id，注入的路径是这台机器此刻的，所以在执行时现取，不进
 * 计划。`dataDir` 缺席（没有数据目录的装配）就不注入。
 */
export function launchLine(
  settings: AgentSettings,
  spec: AgentLaunchSpec,
  dataDir?: string,
): string {
  return canvasLaunchLine({
    settings,
    agentId: spec.agentId,
    frozenArgs: spec.args ?? [],
    ...(dataDir === undefined ? {} : { dataDir }),
  });
}

/** 每个节点最近一次冷启动：什么时候、起的是哪个会话。 */
export class ColdStarts {
  private readonly started = new Map<
    string,
    { readonly atMs: number; readonly sessionId: string }
  >();

  /** 冷却窗口还没过。 */
  cooling(nodeId: string, nowMs: number): boolean {
    const last = this.started.get(nodeId);
    return last !== undefined && nowMs - last.atMs < COLD_START_COOLDOWN_MS;
  }

  /** 占住冷却窗口。起之前就占：起失败也算一次，否则失败本身就是那个循环。 */
  claim(nodeId: string, nowMs: number): void {
    this.started.set(nodeId, { atMs: nowMs, sessionId: "" });
  }

  note(nodeId: string, sessionId: string, nowMs: number): void {
    this.started.set(nodeId, { atMs: nowMs, sessionId });
  }

  /** 这个会话是不是我们冷启动的；是的话答它起来的时刻。 */
  startedAt(nodeId: string, sessionId: string): number | undefined {
    const last = this.started.get(nodeId);
    return last !== undefined && last.sessionId === sessionId
      ? last.atMs
      : undefined;
  }
}

/**
 * 把新会话写回节点的 `data.sessionId`。
 *
 * `terminal_sessions.owner_node_id` 已经让 core 自己找得到它；这一笔是给页面的
 * ——终端节点挂载时按 `data.sessionId` 找会话，找不到就再起一个，而那会是同一个
 * 节点上的第二个 CLI。走画布同一条 CAS 存盘，撞上并发改动就重读再试一次；两次
 * 都撞上就算了：会话照样在，页面只是要等下一次挂载才贴得上。
 */
export function rememberSession(
  database: DatabaseSync,
  node: NodeRef,
  sessionId: string,
  publish: ((workspaceId: string, event: WorkspaceEvent) => void) | undefined,
): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const document = loadBoard(database, node.workspaceId, node.boardId);
      const nodes = document.nodes.map((item) =>
        item.id === node.id
          ? {
              ...item,
              data: {
                ...(item.data as Record<string, unknown>),
                sessionId,
                lastExitCode: null,
              },
            }
          : item,
      );
      const saved = saveBoard(database, node.workspaceId, node.boardId, {
        expectedUpdatedAt: document.board.updatedAt,
        nodes,
        edges: document.edges,
        viewport: document.board.viewport,
      });
      publish?.(node.workspaceId, {
        type: "board.changed",
        boardId: saved.board.id,
        updatedAt: saved.board.updatedAt,
      });
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.status === 409) continue;
      return false;
    }
  }
  return false;
}
