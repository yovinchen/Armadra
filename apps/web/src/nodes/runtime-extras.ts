import { agentGateway } from "@/agent";

/**
 * 权限直答。
 *
 * 走网关而不是直接打 Runtime：agent 域搬到 Host 之后，`POST /api/approvals/
 * {id}/answer` 会回 409 `ownership_moved`，而记录已经换了一侧（业务迁移
 * §2.7）。网关按最后一次探到的归属决定往哪边发，调用方不需要知道。
 *
 * 答复本身仍然只有执行主机能兑现——待答文件在那台机器上——搬走的只是「谁来
 * 决定、谁来记下这个决定」。
 */
export async function answerApproval(
  workspaceId: string,
  pendingId: string,
  decision: "allow" | "deny",
): Promise<void> {
  await agentGateway.answerApproval(workspaceId, pendingId, decision);
}
