import {
  handoffListSchema,
  handoffPrepareSchema,
  handoffViewSchema,
  type HandoffPrepare,
} from "@armadra/shared";
import { json, query, request } from "./request";

export const handoffApi = {
  /* --------------------------------- 对话交接 ---------------------------- */
  /**
   * 交接（design §7）。四个动词分得很开，是因为它们的授权含义不同：
   *
   *  - `prepareHandoff` 只冻结材料并生成预览，不通知任何人；
   *  - `acceptHandoff` 是**唯一**的用户授权，`expectedDigest` 必须是预览里
   *    那一份，Runtime 用它挡住「看到的和批准的不是同一份」；
   *  - `cancelHandoff` 在真正写入目标之前撤回排队中的通知；
   *  - `handoffs` / `handoff` 只读，来源和目标两边都能看到同一个包。
   */
  handoffs: (workspaceId: string, nodeId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/handoffs?sourceNodeId=${query(nodeId)}`,
      handoffListSchema,
      { signal },
    ),
  /**
   * 整个工作空间的交接历史（自动化设计 §7）。
   *
   * 行里的来源/目标读的是冻结在包里的身份，不重新解析：节点被删掉之后，一条
   * 记录仍然要说清当时发生了什么。
   */
  workspaceHandoffs: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/handoffs`,
      handoffListSchema,
      { signal },
    ),
  handoff: (workspaceId: string, handoffId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/handoffs/${query(handoffId)}`,
      handoffViewSchema,
      { signal },
    ),
  prepareHandoff: (workspaceId: string, value: HandoffPrepare) =>
    request(
      `/api/workspaces/${query(workspaceId)}/handoffs`,
      handoffViewSchema,
      { method: "POST", ...json(handoffPrepareSchema.parse(value)) },
    ),
  acceptHandoff: (workspaceId: string, handoffId: string, digest: string) =>
    request(
      `/api/workspaces/${query(workspaceId)}/handoffs/${query(handoffId)}/accept`,
      handoffViewSchema,
      { method: "POST", ...json({ expectedDigest: digest }) },
    ),
  cancelHandoff: (workspaceId: string, handoffId: string, digest: string) =>
    request(
      `/api/workspaces/${query(workspaceId)}/handoffs/${query(handoffId)}/cancel`,
      handoffViewSchema,
      { method: "POST", ...json({ expectedDigest: digest }) },
    ),
};
