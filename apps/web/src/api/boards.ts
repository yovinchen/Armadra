import {
  boardDocumentSchema,
  boardPresenceSchema,
  leaseRequestSchema,
  presenceHeartbeatRequestSchema,
  boardListSchema,
  boardSchema,
  createBoardRequestSchema,
  saveBoardRequestSchema,
  updateBoardRequestSchema,
  type BoardDocument,
  type UpdateBoardRequest,
} from "@armadra/shared";
import {
  RuntimeRequestError,
  json,
  noContentSchema,
  query,
  request,
} from "./request";

export const boardsApi = {
  /* ----------------------------------- 画布 ----------------------------- */
  listBoards: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/boards`, boardListSchema),
  createBoard: (workspaceId: string, name: string) =>
    request(`/api/workspaces/${workspaceId}/boards`, boardSchema, {
      method: "POST",
      ...json(createBoardRequestSchema.parse({ name })),
    }),
  updateBoard: (
    workspaceId: string,
    boardId: string,
    patch: UpdateBoardRequest,
  ) =>
    request(`/api/workspaces/${workspaceId}/boards/${boardId}`, boardSchema, {
      method: "PATCH",
      ...json(updateBoardRequestSchema.parse(patch)),
    }),
  deleteBoard: (workspaceId: string, boardId: string) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}`,
      noContentSchema,
      { method: "DELETE" },
    ),

  /* --------------------------------- 画布文档 --------------------------- */
  loadBoard: (workspaceId: string, boardId: string) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
      boardDocumentSchema,
    ),
  /**
   * PUT 带 `expectedUpdatedAt`（CAS）：并发写入由 Runtime 拒绝。`clientId`
   * 是编辑租约的写者（core JSON §9.3）：别人持有租约时回 423。
   */
  saveBoard: (
    workspaceId: string,
    boardId: string,
    document: BoardDocument,
    clientId?: string,
  ) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
      boardDocumentSchema,
      {
        method: "PUT",
        ...json(
          saveBoardRequestSchema.parse({
            expectedUpdatedAt: document.board.updatedAt,
            nodes: document.nodes,
            edges: document.edges,
            viewport: document.board.viewport,
            // 白板快照（旧画布契约 §6.1）：同一次 PUT 带走，Runtime 原样存。
            whiteboard: document.board.whiteboard,
            clientId,
          }),
        ),
      },
    ),

  /* ----------------------------- 在线设备与租约 ------------------------- */
  /** 心跳（core JSON §9.1）：登记或续期，回当前的在线表与租约。 */
  presenceHeartbeat: (
    workspaceId: string,
    boardId: string,
    body: { clientId: string; deviceName: string; active: boolean },
  ) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}/presence`,
      boardPresenceSchema,
      {
        method: "POST",
        ...json(presenceHeartbeatRequestSchema.parse(body)),
      },
    ),
  /** 离开。关页面时也要能发出去，所以带 `keepalive`。 */
  leavePresence: (workspaceId: string, boardId: string, clientId: string) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}/presence/${query(clientId)}`,
      boardPresenceSchema,
      { method: "DELETE", keepalive: true },
    ),
  /** 拿租约；`takeover` 是用户确认过的接管（§9.2）。 */
  acquireLease: (
    workspaceId: string,
    boardId: string,
    body: { clientId: string; deviceName: string; takeover: boolean },
  ) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}/lease`,
      boardPresenceSchema,
      { method: "POST", ...json(leaseRequestSchema.parse(body)) },
    ),
};

/** 别人持有这块画布的编辑租约（423 `canvas_lease_held`）。 */
export function isLeaseHeld(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError && error.code === "canvas_lease_held"
  );
}
