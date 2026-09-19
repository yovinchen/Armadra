import { RuntimeRequestError, runtimeApi } from "../api/client";

/**
 * Agent 域网关。
 *
 * 搬迁时代这里要在 Runtime 与 Host 两份 agent 记录之间选一侧；单一 core 之后
 * 状态、审批、投递、转录都只有一份，所以只剩 core 自己那几条 `/api/` 路由。
 *
 * 模块留着是因为它把四件事投影成界面认得的形状：一个权限问题、一段转录、
 * 一屏终端、一条投递回执。
 */

/** 一个权限问题。 */
export interface ApprovalRecord {
  approvalId: string;
  nodeId: string;
  /** CLI 自己的词。答过才有值，没答是空串。 */
  decision: string;
  answered: boolean;
  /** 保留字段：core 不做 revision CAS，恒为 0。 */
  revision: bigint;
}

/**
 * 一个节点自己的材料：它说过什么、它现在显示什么。不存，读完就丢。
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

/** 答一个权限问题时用的词不在 core 的词表里。 */
export class UnsupportedDecisionError extends Error {
  readonly name = "UnsupportedDecisionError";
  constructor(readonly decision: string) {
    super(`Unsupported approval decision: ${decision}.`);
  }
}

export const agentGateway = {
  /** 清掉一个节点的未读标记。 */
  async markRead(_workspaceId: string, nodeId: string): Promise<void> {
    await runtimeApi.markAgentRead(nodeId);
  },

  /**
   * 答一个权限问题。
   *
   * core 只认 allow / deny 两个词；别的词是某个 CLI 自己的词汇，这里没有
   * 存放处，所以当场拒掉而不是发出去被 400。
   */
  async answerApproval(
    _workspaceId: string,
    approvalId: string,
    decision: string,
  ): Promise<ApprovalRecord> {
    if (decision !== "allow" && decision !== "deny")
      throw new UnsupportedDecisionError(decision);
    await runtimeApi.answerApproval(approvalId, decision);
    return { approvalId, nodeId: "", decision, answered: true, revision: 0n };
  },

  /**
   * 一个节点自己的对话尾部。
   *
   * 没有可读转录的 CLI 是拒绝并说明原因，绝不是一段空正文——空正文和
   * 「这一轮还没说话」在界面上分不开。
   */
  async readTranscript(
    _workspaceId: string,
    nodeId: string,
  ): Promise<TranscriptRecord> {
    const answer = await runtimeApi.agentTranscript(nodeId);
    return {
      nodeId: answer.nodeId,
      text: answer.text,
      truncated: answer.truncated,
    };
  },

  /** 这个节点的终端此刻显示的内容。 */
  async captureScreen(
    _workspaceId: string,
    _nodeId: string,
    sessionId: string,
    lines?: number,
  ): Promise<string> {
    // 没有会话就没有画面。这不是一屏空白：那个节点底下没有东西在跑。
    if (!sessionId)
      throw new RuntimeRequestError(404, "No session is running", "not_found");
    const answer = await runtimeApi.captureTerminal(sessionId, { lines });
    return answer.data;
  },

  /** 一个节点被告知了什么，新的在前。 */
  async listDeliveries(
    workspaceId: string,
    nodeId: string,
  ): Promise<DeliveryRecord[]> {
    const answer = await runtimeApi.deliveries(workspaceId);
    return answer
      .filter((entry) => entry.targetNodeId === nodeId)
      .map((entry) => ({
        traceId: entry.traceId,
        targetNodeId: entry.targetNodeId,
        outcome: toOutcome(entry.outcome),
        bodyChars: entry.bodyChars,
      }));
  },
};

/**
 * outcome 词表映射。认不出的词读成 `unknown` 而不是 `submitted`：
 * 「说不清」和「已经写进去了」是两件事，只有前者是安全的默认。
 */
function toOutcome(value: string): DeliveryRecord["outcome"] {
  if (value === "submitted" || value === "delivered") return "submitted";
  if (value === "notWritten" || value === "refused") return "notWritten";
  return "unknown";
}
