import {
  adapterListSchema,
  boardDocumentSchema,
  boardListSchema,
  boardSchema,
  contextPreviewResponseSchema,
  createBoardRequestSchema,
  createWorkspaceRequestSchema,
  fileContentSchema,
  fileListSchema,
  gatewayStatusSchema,
  gitDiffSchema,
  gitPathsRequestSchema,
  gitRevertResponseSchema,
  gitStageResponseSchema,
  gitStatusSchema,
  healthSchema,
  runAgentResponseSchema,
  saveBoardRequestSchema,
  terminalSessionSchema,
  updateBoardRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceListSchema,
  workspaceSchema,
  type AdapterId,
  type BoardDocument,
  type ContextItem,
  type CreateWorkspaceRequest,
  type UpdateBoardRequest,
  type UpdateWorkspaceRequest,
} from "@ai-coding-canvas/shared";
import { z } from "zod";

export const RUNTIME_URL =
  import.meta.env.VITE_RUNTIME_URL ?? "http://127.0.0.1:43120";

/** 204/empty bodies parse to `null` before reaching the schema. */
const noContentSchema = z.unknown().transform(() => undefined);

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${RUNTIME_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new RuntimeConnectionError(RUNTIME_URL, cause);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : `Runtime request failed (${response.status})`;
    throw new Error(message);
  }
  return schema.parse(payload);
}

export class RuntimeConnectionError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, cause?: unknown) {
    super(
      `无法连接本地 Runtime（${endpoint}）。桌面版请重新启动应用；Web 开发模式请先启动 Runtime。`,
      { cause },
    );
    this.name = "RuntimeConnectionError";
    this.endpoint = endpoint;
  }
}

const query = (value: string) => encodeURIComponent(value);

export const runtimeApi = {
  health: () => request("/health", healthSchema),

  /* --------------------------------- workspaces -------------------------- */
  listWorkspaces: () => request("/api/workspaces", workspaceListSchema),
  createWorkspace: (input: CreateWorkspaceRequest) =>
    request("/api/workspaces", workspaceSchema, {
      method: "POST",
      body: JSON.stringify(createWorkspaceRequestSchema.parse(input)),
    }),
  updateWorkspace: (workspaceId: string, patch: UpdateWorkspaceRequest) =>
    request(`/api/workspaces/${workspaceId}`, workspaceSchema, {
      method: "PATCH",
      body: JSON.stringify(updateWorkspaceRequestSchema.parse(patch)),
    }),
  openWorkspace: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/open`, workspaceSchema, {
      method: "POST",
    }),

  /* ----------------------------------- boards ---------------------------- */
  listBoards: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/boards`, boardListSchema),
  createBoard: (workspaceId: string, name: string) =>
    request(`/api/workspaces/${workspaceId}/boards`, boardSchema, {
      method: "POST",
      body: JSON.stringify(createBoardRequestSchema.parse({ name })),
    }),
  updateBoard: (
    workspaceId: string,
    boardId: string,
    patch: UpdateBoardRequest,
  ) =>
    request(`/api/workspaces/${workspaceId}/boards/${boardId}`, boardSchema, {
      method: "PATCH",
      body: JSON.stringify(updateBoardRequestSchema.parse(patch)),
    }),
  deleteBoard: (workspaceId: string, boardId: string) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}`,
      noContentSchema,
      { method: "DELETE" },
    ),
  loadBoard: (workspaceId: string, boardId: string) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
      boardDocumentSchema,
    ),
  saveBoard: (workspaceId: string, boardId: string, document: BoardDocument) =>
    request(
      `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
      boardDocumentSchema,
      {
        method: "PUT",
        body: JSON.stringify(
          saveBoardRequestSchema.parse({
            expectedUpdatedAt: document.board.updatedAt,
            nodes: document.nodes,
            edges: document.edges,
            strokes: document.strokes,
            viewport: document.board.viewport,
          }),
        ),
      },
    ),

  /* ------------------------------------ files ---------------------------- */
  listFiles: (workspaceId: string, path = ".") =>
    request(
      `/api/workspaces/${workspaceId}/files?path=${query(path)}`,
      fileListSchema,
    ),
  readFile: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/file?path=${query(path)}`,
      fileContentSchema,
    ),

  /* ---------------------------------- terminals -------------------------- */
  createTerminal: (input: {
    workspaceId: string;
    cwd: string;
    shell?: string;
    command?: string;
    args?: string[];
  }) =>
    request("/api/terminals", terminalSessionSchema, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getTerminal: (sessionId: string) =>
    request(`/api/terminals/${sessionId}`, terminalSessionSchema),
  terminateTerminal: (sessionId: string) =>
    request(`/api/terminals/${sessionId}/terminate`, terminalSessionSchema, {
      method: "POST",
    }),

  /* ----------------------------------- agents ---------------------------- */
  listAdapters: () => request("/api/agents", adapterListSchema),
  previewContext: (agentNodeId: string, items: ContextItem[]) =>
    request("/api/agents/context-preview", contextPreviewResponseSchema, {
      method: "POST",
      body: JSON.stringify({ agentNodeId, items }),
    }),
  runAgent: (input: {
    workspaceId: string;
    agentNodeId: string;
    adapter: AdapterId;
    command?: string;
    args: string[];
    cwd: string;
    items: ContextItem[];
    sessionId?: string;
  }) =>
    request("/api/agents/run", runAgentResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* ------------------------------------- git ----------------------------- */
  gitStatus: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/git/status`, gitStatusSchema),
  gitDiff: (workspaceId: string, path = ".") =>
    request(
      `/api/workspaces/${workspaceId}/git/diff?path=${query(path)}`,
      gitDiffSchema,
    ),
  gitStage: (workspaceId: string, paths: string[]) =>
    request(
      `/api/workspaces/${workspaceId}/git/stage`,
      gitStageResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(gitPathsRequestSchema.parse({ paths })),
      },
    ),
  gitRevert: (workspaceId: string, paths: string[]) =>
    request(
      `/api/workspaces/${workspaceId}/git/revert`,
      gitRevertResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(gitPathsRequestSchema.parse({ paths })),
      },
    ),

  /* ----------------------------------- gateway --------------------------- */
  gatewayStatus: (workspaceId?: string) =>
    request(
      workspaceId
        ? `/api/gateway?workspaceId=${query(workspaceId)}`
        : "/api/gateway",
      gatewayStatusSchema,
    ),
};

export function terminalWebSocketUrl(sessionId: string): string {
  const url = new URL(RUNTIME_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/terminals/${sessionId}/ws`;
  return url.toString();
}

export function agentWebSocketUrl(sessionId: string): string {
  const url = new URL(RUNTIME_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/agents/${sessionId}/ws`;
  return url.toString();
}
