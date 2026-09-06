import type { HostSessionClient } from "@armadra/host-client";
import type { CreateTerminalAgent, TerminateMode } from "@armadra/shared";

import { RuntimeRequestError, runtimeApi } from "../api/client";
import type { CanvasOwnershipStatus } from "../canvas-ownership/store";
import { domainStatus, useOwnership } from "../ownership/store";
import { resolveHostSessionClient } from "./host-session";

/**
 * 会话域网关（业务迁移 §2.6）—— 决定搬走了，进程没有。
 *
 * 搬过去的是**要不要有这个进程**：哪个节点要一个 shell、在哪、跑什么、被
 * 冻结成什么样。留在执行主机上的是进程本身——PTY、tmux 句柄、代次计数、
 * 回放日志——它们没法跨进程搬，附着仍然是同一条 WebSocket，切换前后都一样。
 *
 * 这条边界解释了这里为什么把「有没有」和「起不起」拆成两次调用。挂载一个
 * 终端节点以前会顺手建会话，于是渲染两次就起两个进程；现在挂载只读
 * `ensure` 的第一步，创建带 operationId 和 revision，第二个客户端拿旧
 * revision 去起会被拒，而不是起出第二个 shell。
 *
 * 路由规则和别的域一样：读跟着最后一次探到的归属走，探不到就读 Runtime
 * （它交出写权之后仍然照常答读）；写则相反，归属没落定就不写。
 */

/** 归属没落定，这一次写不该发生。 */
export class SessionReadOnlyError extends Error {
  readonly name = "SessionReadOnlyError";
  constructor(readonly status: CanvasOwnershipStatus) {
    super(`Terminal sessions are read-only (${status}).`);
  }
}

/**
 * Runtime 已经交出写权。**不重试**：同一个请求再发一次还是 409，
 * 而且写方已经换人了。捕获它的地方应该重新探归属，再决定走哪边。
 */
export class SessionOwnershipMovedError extends Error {
  readonly name = "SessionOwnershipMovedError";
}

function isOwnershipMoved(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    error.status === 409 &&
    error.code === "ownership_moved"
  );
}

type HostResolver = (
  workspaceId: string,
  mutation: boolean,
) => Promise<HostSessionClient>;

let resolver: HostResolver = resolveHostSessionClient;

/** 测试注入 Host 客户端；传 `null` 恢复真实实现。 */
export function setSessionHostResolver(next: HostResolver | null): void {
  resolver = next ?? resolveHostSessionClient;
}

async function settled(): Promise<CanvasOwnershipStatus> {
  const state = useOwnership.getState();
  const current = state.failed
    ? "error"
    : domainStatus("session", state.domains);
  // `error` 和 `unknown` 一样要重探：探测失败是一次丢掉的请求，不是判决，
  // 把终端卡成只读直到有人点横幅，会把一次抖动变成一次卡死。
  if (current !== "unknown" && current !== "error") return current;
  const domains = await state.probe();
  return useOwnership.getState().failed
    ? "error"
    : domainStatus("session", domains);
}

async function writeRoute(): Promise<"runtime" | "host"> {
  const status = await settled();
  if (status !== "runtime" && status !== "host")
    throw new SessionReadOnlyError(status);
  return status;
}

async function readRoute(): Promise<"runtime" | "host"> {
  return (await settled()) === "host" ? "host" : "runtime";
}

/** Runtime 写的统一出口：把 `ownership_moved` 从普通 409 里摘出来。 */
async function runtimeWrite<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isOwnershipMoved(error)) throw error;
    await useOwnership.getState().probe();
    throw new SessionOwnershipMovedError();
  }
}

/**
 * 一个会话，两侧投影成同一个形状。
 *
 * `state` 六个值里最要紧的是 `lost`：没人看见它结束，执行主机很可能还留着
 * 那个 pane。把它画成 `exited` 等于请用户在同一个 pane 上再起一个程序。
 */
export interface TerminalSessionRecord {
  sessionId: string;
  /** 跨 recycle 不变，挂载时按它找会话。 */
  sessionKey: string;
  state: "pending" | "starting" | "running" | "exited" | "lost" | "reclaiming";
  generation: bigint;
  exitCode?: number;
  /** Host 侧的 CAS 令牌；Runtime 侧恒为 0，那一侧不做 revision CAS。 */
  revision: bigint;
}

/** 建一个会话要说清楚的事，两侧共用。 */
export interface SessionLaunchInput {
  workspaceId: string;
  nodeId: string;
  cwd: string;
  shell?: string;
  agent?: CreateTerminalAgent;
  ssh?: { hostId: string };
}

/** Runtime 的会话行 → 网关的形状。它没有 revision，也不需要。 */
function fromRuntime(session: {
  id: string;
  // The Runtime's row predates the logical key, so a session created before it
  // has none. Falling back to the identifier is what that side has always
  // meant by "no node owns this", and it keeps the two projections the same
  // shape rather than making callers handle an absence on one side only.
  sessionKey?: string;
  status: string;
  // Absent on a row written before the column existed, which is the same
  // statement as "no run has been recorded": zero.
  generation?: number;
  exitCode?: number | null;
}): TerminalSessionRecord {
  const state =
    session.status === "running"
      ? "running"
      : session.status === "failed"
        ? "exited"
        : session.status === "terminated"
          ? "exited"
          : "exited";
  return {
    sessionId: session.id,
    sessionKey: session.sessionKey || session.id,
    state,
    generation: BigInt(Math.max(session.generation ?? 0, 0)),
    exitCode: session.exitCode ?? undefined,
    revision: 0n,
  };
}

export const sessionGateway = {
  /**
   * 挂载时的读：这个节点有没有一个还活着的会话。
   *
   * 只读。找不到不是错误，是「还没有」——起不起是另一次明确的决定，这正是
   * 这个域搬走的原因。
   */
  async find(
    workspaceId: string,
    nodeId: string,
    sessionId?: string,
  ): Promise<TerminalSessionRecord | null> {
    if ((await readRoute()) === "runtime") {
      if (!sessionId) return null;
      try {
        return fromRuntime(await runtimeApi.getTerminal(sessionId));
      } catch {
        // 404 / Runtime 重启：这个节点现在没有会话。
        return null;
      }
    }
    try {
      const { session } = await (
        await resolver(workspaceId, false)
      ).get({ sessionKey: nodeId });
      return {
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        state: session.state,
        generation: session.generation,
        exitCode: session.exitCode,
        revision: session.revision,
      };
    } catch {
      return null;
    }
  },

  /**
   * 建会话并起进程。
   *
   * Runtime 那一侧是一次 `POST /api/terminals`，因为那一侧本来就是两件事
   * 一起做的。Host 这一侧是两步，因为这两步本来就是两个决定：先记下意图，
   * 再让机器起进程。中间断了，留下的是一条 `pending` 记录——一个还没有进程
   * 的节点——而不是一条声称在跑却没有进程的记录。
   */
  async start(input: SessionLaunchInput): Promise<TerminalSessionRecord> {
    if ((await writeRoute()) === "runtime") {
      const created = await runtimeWrite(() =>
        runtimeApi.createTerminal({
          workspaceId: input.workspaceId,
          cwd: input.cwd,
          args: [],
          nodeId: input.nodeId,
          ...(input.shell ? { shell: input.shell } : {}),
          ...(input.ssh ? { ssh: { hostId: input.ssh.hostId } } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
        }),
      );
      return fromRuntime(created);
    }
    const client = await resolver(input.workspaceId, true);
    // 一个节点一个逻辑键：recycle 之后还是同一个键，所以挂载时找得回来。
    const sessionKey = input.nodeId;
    const existing = await client.get({ sessionKey }).catch(() => null);
    const sessionId =
      existing?.session.sessionId ?? globalThis.crypto.randomUUID();
    const created =
      existing?.session ??
      (await client.create({
        operationId: `session/${sessionId}/create`,
        sessionId,
        sessionKey,
        ownerNodeId: input.nodeId,
        kind: input.agent ? "agent" : "terminal",
        workingDirectory: input.cwd,
        ...(input.shell ? { shell: input.shell } : {}),
        ...(input.ssh ? { sshTargetId: input.ssh.hostId } : {}),
        ...(input.agent
          ? {
              agentId: input.agent.id,
              ...(input.agent.permissionMode
                ? { permissionMode: input.agent.permissionMode }
                : {}),
              ...(input.agent.model ? { modelId: input.agent.model } : {}),
            }
          : {}),
        expectedRevision: 0n,
      }));
    if (created.state === "running" || created.state === "starting") {
      // 已经有进程了。再起一个正是这个域存在的理由要防的事。
      return {
        sessionId: created.sessionId,
        sessionKey: created.sessionKey,
        state: created.state,
        generation: created.generation,
        exitCode: created.exitCode,
        revision: created.revision,
      };
    }
    const { session } = await client.start({
      operationId: `session/${created.sessionId}/start/${created.revision}`,
      sessionId: created.sessionId,
      expectedRevision: created.revision,
    });
    return {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      state: session.state,
      generation: session.generation,
      exitCode: session.exitCode,
      revision: session.revision,
    };
  },

  /** 结束这一次运行，记录还在——和「关掉这个节点」是两个决定。 */
  async terminate(
    workspaceId: string,
    sessionId: string,
    mode: TerminateMode = "process",
  ): Promise<TerminalSessionRecord> {
    if ((await writeRoute()) === "runtime") {
      return fromRuntime(
        await runtimeWrite(() => runtimeApi.terminateTerminal(sessionId, mode)),
      );
    }
    const client = await resolver(workspaceId, true);
    const { session } = await client.get({ sessionId });
    const ended = await client.terminate({
      operationId: `session/${sessionId}/terminate/${session.revision}`,
      sessionId,
      expectedRevision: session.revision,
      mode,
    });
    return {
      sessionId: ended.sessionId,
      sessionKey: ended.sessionKey,
      state: ended.state,
      generation: ended.generation,
      exitCode: ended.exitCode,
      revision: ended.revision,
    };
  },

  /** 同一个逻辑会话，下一个代次。一次调用，不是先停后起。 */
  async recycle(
    workspaceId: string,
    sessionId: string,
  ): Promise<TerminalSessionRecord> {
    if ((await writeRoute()) === "runtime") {
      return fromRuntime(
        await runtimeWrite(() => runtimeApi.recycleTerminal(sessionId)),
      );
    }
    const client = await resolver(workspaceId, true);
    const { session: before } = await client.get({ sessionId });
    const { session } = await client.recycle({
      operationId: `session/${sessionId}/recycle/${before.revision}`,
      sessionId,
      expectedRevision: before.revision,
    });
    return {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      state: session.state,
      generation: session.generation,
      exitCode: session.exitCode,
      revision: session.revision,
    };
  },
};
