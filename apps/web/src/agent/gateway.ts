import type { HostAgentClient } from "@armadra/host-client";

import { RuntimeRequestError, runtimeApi } from "../api/client";
import type { CanvasOwnershipStatus } from "../canvas-ownership/store";
import { domainStatus, useOwnership } from "../ownership/store";
import { resolveHostAgentClient } from "./host-session";

/**
 * Agent 域网关（业务迁移 §2.7）—— 记录搬走了，CLI 没有。
 *
 * 搬过去的是**这些事说明了什么**：节点归约成什么状态、哪个权限问题还没人
 * 答、谁给谁留了话、投递到底写进去没有、交接走到哪一步。留在执行主机上的
 * 是 CLI 本身——Hook 端点、节点令牌、待答文件、转录、终端——它们就是那台
 * 机器，搬不走，切换前后也一直在那儿。
 *
 * 审批是这里最要紧的一条，顺序和会话域相反：会话是先问机器再记录，因为机器
 * 的答复就是事实；审批是**先记录**（带 revision CAS）再让机器写待答文件，
 * 因为记录才是「只答一次」的依据。两台设备同时读到同一个 revision，第二台在
 * 任何字节落到终端之前就被拒了。
 *
 * 路由规则和别的域一样：读跟着最后一次探到的归属走，探不到就读 Runtime
 * （它交出写权之后仍然照常答读）；写则相反，归属没落定就不写。
 */

/** 归属没落定，这一次写不该发生。 */
export class AgentReadOnlyError extends Error {
  readonly name = "AgentReadOnlyError";
  constructor(readonly status: CanvasOwnershipStatus) {
    super(`Agent records are read-only (${status}).`);
  }
}

/**
 * Runtime 已经交出写权。**不重试**：同一个请求再发一次还是 409，
 * 而且写方已经换人了。捕获它的地方应该重新探归属，再决定走哪边。
 */
export class AgentOwnershipMovedError extends Error {
  readonly name = "AgentOwnershipMovedError";
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
) => Promise<HostAgentClient>;

let resolver: HostResolver = resolveHostAgentClient;

/** 测试注入 Host 客户端；传 `null` 恢复真实实现。 */
export function setAgentHostResolver(next: HostResolver | null): void {
  resolver = next ?? resolveHostAgentClient;
}

async function settled(): Promise<CanvasOwnershipStatus> {
  const state = useOwnership.getState();
  const current = state.failed ? "error" : domainStatus("agent", state.domains);
  // `error` 和 `unknown` 一样要重探：探测失败是一次丢掉的请求，不是判决，
  // 把审批卡成只读直到有人点横幅，会把一次抖动变成一个停摆的 Agent。
  if (current !== "unknown" && current !== "error") return current;
  const domains = await state.probe();
  return useOwnership.getState().failed
    ? "error"
    : domainStatus("agent", domains);
}

async function writeRoute(): Promise<"runtime" | "host"> {
  const status = await settled();
  if (status !== "runtime" && status !== "host")
    throw new AgentReadOnlyError(status);
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
    throw new AgentOwnershipMovedError();
  }
}

/** 一个权限问题，两侧投影成同一个形状。 */
export interface ApprovalRecord {
  approvalId: string;
  nodeId: string;
  /** CLI 自己的词。答过才有值，没答是空串。 */
  decision: string;
  answered: boolean;
  /** Host 侧的 CAS 令牌；Runtime 侧恒为 0，那一侧不做 revision CAS。 */
  revision: bigint;
}

/**
 * 一个节点自己的材料：它说过什么、它现在显示什么。两侧都不存，读完就丢。
 *
 * `truncated` 单独一个字段，因为「截断的对话被当成完整的」是答错，不是答少。
 */
export interface TranscriptRecord {
  nodeId: string;
  text: string;
  truncated: boolean;
}

/** 一次投递的回执。`unknown` 不是失败，是「说不清」，谁都不许自动重发。 */
export interface DeliveryRecord {
  traceId: string;
  targetNodeId: string;
  outcome: "submitted" | "notWritten" | "unknown";
  bodyChars: number;
}

export const agentGateway = {
  /**
   * 清掉一个节点的未读标记。
   *
   * Host 那一侧带 revision：两个客户端同时清同一个标记是两个决定，输的那个
   * 要知道自己输了——否则手机上清掉的标记会被笔记本的旧写法重新点亮。
   */
  async markRead(workspaceId: string, nodeId: string): Promise<void> {
    if ((await writeRoute()) === "runtime") {
      await runtimeWrite(() => runtimeApi.markAgentRead(nodeId));
      return;
    }
    const client = await resolver(workspaceId, true);
    const [status] = await client.listStatus(previousOf(nodeId), 1);
    const revision = status?.nodeId === nodeId ? status.revision : 0n;
    await client.markRead({
      operationId: `agent/${nodeId}/read/${revision}`,
      expectedRevision: revision,
      nodeId,
    });
  },

  /**
   * 答一个权限问题。
   *
   * Runtime 那一侧是一次 `POST /api/approvals/{id}/answer`，那一侧「记录」和
   * 「写待答文件」本来就是同一件事。Host 这一侧先读到 revision 再带着它答，
   * 因为记录先落、机器后知道：中间断了留下的是一条「已答但机器没听见」的
   * 记录——一个人能处理的状态——而不是一个又变回没人答的问题。
   */
  async answerApproval(
    workspaceId: string,
    approvalId: string,
    decision: string,
  ): Promise<ApprovalRecord> {
    if ((await writeRoute()) === "runtime") {
      // Runtime 只认 allow / deny 两个词；别的词是 Host 侧 CLI 自己的词汇，
      // 那一侧没有存放处，所以在这里就拒掉而不是发出去被 400。
      if (decision !== "allow" && decision !== "deny")
        throw new AgentReadOnlyError("runtime");
      await runtimeWrite(() => runtimeApi.answerApproval(approvalId, decision));
      return { approvalId, nodeId: "", decision, answered: true, revision: 0n };
    }
    const client = await resolver(workspaceId, true);
    const record = await client.answerApproval({
      operationId: `agent/${approvalId}/answer`,
      // 0 表示「这条记录还没被答过」，正是 CAS 要比的东西。
      expectedRevision: await revisionOf(client, approvalId),
      approvalId,
      decision,
    });
    return {
      approvalId: record.approvalId,
      nodeId: record.nodeId,
      decision: record.decision,
      answered: record.state === "answered",
      revision: record.revision,
    };
  },

  /**
   * 一个节点自己的对话尾部。
   *
   * 转录是执行主机上的一份文件，两侧读的是同一份；差别只在谁来读。没有可读
   * 转录的 CLI 两侧都是拒绝并说明原因，绝不是一段空正文——空正文和「这一轮
   * 还没说话」在界面上分不开。
   */
  async readTranscript(
    workspaceId: string,
    nodeId: string,
  ): Promise<TranscriptRecord> {
    if ((await readRoute()) === "runtime") {
      const answer = await runtimeApi.agentTranscript(nodeId);
      return {
        nodeId: answer.nodeId,
        text: answer.text,
        truncated: answer.truncated,
      };
    }
    const client = await resolver(workspaceId, false);
    const record = await client.readTranscript({ nodeId });
    return {
      nodeId: record.nodeId,
      text: record.text,
      truncated: record.truncated,
    };
  },

  /**
   * 这个节点的终端此刻显示的内容。
   *
   * Runtime 那一侧按会话抓屏——它就是持有 PTY 的进程；Host 那一侧按节点问，
   * 会话 id 由 Host 自己的记录填，客户端指定不了别人的会话。
   */
  async captureScreen(
    workspaceId: string,
    nodeId: string,
    sessionId: string,
    lines?: number,
  ): Promise<string> {
    if ((await readRoute()) === "runtime") {
      // 没有会话就没有画面。这不是一屏空白：那个节点底下没有东西在跑。
      if (!sessionId)
        throw new RuntimeRequestError(404, "No session is running", "not_found");
      const answer = await runtimeApi.captureTerminal(sessionId, { lines });
      return answer.data;
    }
    const client = await resolver(workspaceId, false);
    return client.captureScreen({ nodeId, lines });
  },

  /** 一个节点被告知了什么，新的在前。 */
  async listDeliveries(
    workspaceId: string,
    nodeId: string,
  ): Promise<DeliveryRecord[]> {
    if ((await readRoute()) === "runtime") {
      const answer = await runtimeApi.deliveries(workspaceId);
      return answer
        .filter((entry) => entry.targetNodeId === nodeId)
        .map((entry) => ({
          traceId: entry.traceId,
          targetNodeId: entry.targetNodeId,
          outcome: fromRuntimeOutcome(entry.outcome),
          bodyChars: entry.bodyChars,
        }));
    }
    const client = await resolver(workspaceId, false);
    const records = await client.listDeliveries(nodeId);
    return records.map((record) => ({
      traceId: record.traceId,
      targetNodeId: record.targetNodeId,
      outcome: record.outcome,
      bodyChars: record.bodyChars,
    }));
  },
};

/**
 * Runtime 的 outcome 词表映射。认不出的词读成 `unknown` 而不是 `submitted`：
 * 「说不清」和「已经写进去了」是两件事，只有前者是安全的默认。
 */
function fromRuntimeOutcome(value: string): DeliveryRecord["outcome"] {
  if (value === "submitted" || value === "delivered") return "submitted";
  if (value === "notWritten" || value === "refused") return "notWritten";
  return "unknown";
}

/**
 * 列出一个节点的状态时用的游标：节点 id 是按字典序分页的，所以要从它前面
 * 一位开始才能把它自己列进来。空串（第一个节点）就从头列。
 */
function previousOf(nodeId: string): string {
  if (!nodeId) return "";
  const last = nodeId.charCodeAt(nodeId.length - 1);
  if (last <= 0) return "";
  return nodeId.slice(0, -1) + String.fromCharCode(last - 1);
}

/** 读一条审批当前的 revision。读不到（还没记录过）就是 0。 */
async function revisionOf(
  client: HostAgentClient,
  approvalId: string,
): Promise<bigint> {
  const nodeId = approvalId.split("/")[0] ?? approvalId;
  const approvals = await client.listApprovals(nodeId, true).catch(() => []);
  return (
    approvals.find((entry) => entry.approvalId === approvalId)?.revision ?? 0n
  );
}
