import {
  boardDocumentSchema,
  boardListSchema,
  boardSchema,
  createBoardRequestSchema,
  saveBoardRequestSchema,
  updateBoardRequestSchema,
  type BoardDocument,
  type UpdateBoardRequest,
} from "@armadra/shared";
import { json, noContentSchema, request } from "./request";

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
  /** PUT 带 `expectedUpdatedAt`（CAS）：并发写入由 Runtime 拒绝。 */
  saveBoard: (workspaceId: string, boardId: string, document: BoardDocument) =>
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
          }),
        ),
      },
    ),
};
