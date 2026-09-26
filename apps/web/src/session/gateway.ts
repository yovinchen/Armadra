import type { CreateTerminalAgent, TerminateMode } from "@armadra/shared";

import { runtimeApi } from "../api/client";

/**
 * 会话域网关。
 *
 * 搬迁时代这里要在 Runtime 与 Host 两份会话记录之间选一侧；单一 core 之后
 * 记录只有一份，意图与 PTY 同库同事务，所以这里只剩 `/api/terminals` 一条路。
 *
 * 模块留着是因为**形状**仍然有用：把「有没有」和「起不起」分成两次调用。
 * 挂载一个终端节点只读 `find`，创建是另一次明确的决定——渲染两次不会起两个
 * 进程。
 */

/** 一个会话，界面看到的形状。 */
export interface TerminalSessionRecord {
  sessionId: string;
  /** 跨 recycle 不变，挂载时按它找会话。 */
  sessionKey: string;
  state:
    | "pending"
    | "starting"
    | "running"
    | "exited"
    | "lost"
    | "reclaiming"
    | "hibernated";
  generation: bigint;
  exitCode?: number;
  /** 保留字段：core 不做 revision CAS，恒为 0。 */
  revision: bigint;
  /** 这个会话跑的 shell：启动行按它的方言引用。 */
  shell?: string;
}

/** 建一个会话要说清楚的事。 */
export interface SessionLaunchInput {
  workspaceId: string;
  nodeId: string;
  cwd: string;
  shell?: string;
  agent?: CreateTerminalAgent;
  ssh?: { hostId: string };
}

/** core 的会话行 → 网关的形状。 */
function fromRuntime(session: {
  id: string;
  // The row predates the logical key, so a session created before it has none.
  // Falling back to the identifier is what that side has always meant by "no
  // node owns this".
  sessionKey?: string;
  status: string;
  // Absent on a row written before the column existed, which is the same
  // statement as "no run has been recorded": zero.
  generation?: number;
  exitCode?: number | null;
  hibernation?: "hibernated" | null;
  shell?: string;
}): TerminalSessionRecord {
  // 节能休眠的会话不是「已退出」：它还挂在节点上，点一下就用 CLI 的 resume
  // 接回来。当成退出的话，挂载会替它起一个全新的会话。
  const state =
    session.status === "running"
      ? "running"
      : session.hibernation === "hibernated"
        ? "hibernated"
        : "exited";
  return {
    sessionId: session.id,
    sessionKey: session.sessionKey || session.id,
    state,
    generation: BigInt(Math.max(session.generation ?? 0, 0)),
    exitCode: session.exitCode ?? undefined,
    revision: 0n,
    ...(session.shell ? { shell: session.shell } : {}),
  };
}

export const sessionGateway = {
  /**
   * 挂载时的读：这个节点有没有一个还活着的会话。
   *
   * 只读。找不到不是错误，是「还没有」——起不起是另一次明确的决定。
   */
  async find(
    _workspaceId: string,
    _nodeId: string,
    sessionId?: string,
  ): Promise<TerminalSessionRecord | null> {
    if (!sessionId) return null;
    try {
      return fromRuntime(await runtimeApi.getTerminal(sessionId));
    } catch {
      // 404 / core 重启：这个节点现在没有会话。
      return null;
    }
  },

  /** 建会话并起进程。 */
  async start(input: SessionLaunchInput): Promise<TerminalSessionRecord> {
    return fromRuntime(
      await runtimeApi.createTerminal({
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        args: [],
        nodeId: input.nodeId,
        ...(input.shell ? { shell: input.shell } : {}),
        ...(input.ssh ? { ssh: { hostId: input.ssh.hostId } } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      }),
    );
  },

  /** 结束这一次运行，记录还在——和「关掉这个节点」是两个决定。 */
  async terminate(
    _workspaceId: string,
    sessionId: string,
    mode: TerminateMode = "process",
  ): Promise<TerminalSessionRecord> {
    return fromRuntime(await runtimeApi.terminateTerminal(sessionId, mode));
  },

  /** 唤醒节能休眠的会话：同一个会话 id，下一个代次，接回原来那段对话。 */
  async wake(
    _workspaceId: string,
    sessionId: string,
  ): Promise<TerminalSessionRecord> {
    return fromRuntime(await runtimeApi.wakeTerminal(sessionId));
  },

  /** 同一个逻辑会话，下一个代次。一次调用，不是先停后起。 */
  async recycle(
    _workspaceId: string,
    sessionId: string,
  ): Promise<TerminalSessionRecord> {
    return fromRuntime(await runtimeApi.recycleTerminal(sessionId));
  },
};
