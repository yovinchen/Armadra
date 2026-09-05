import {
  isHostServed,
  resolveRuntimeUrl,
  resolveSocketBase,
  runtimeSocketUrl,
} from "./runtime-url";
import { ensureHostCsrf, forgetHostCsrf } from "../host/proxy-session";
import {
  agentListSchema,
  agentStatusSchema,
  contextUsageSchema,
  answerApprovalResponseSchema,
  boardDocumentSchema,
  boardListSchema,
  boardSchema,
  contextLinksRequestSchema,
  contextLinksResponseSchema,
  conversationRefreshResponseSchema,
  conversationsResponseSchema,
  controlConfirmRequestSchema,
  controlConfirmResponseSchema,
  deliveriesResponseSchema,
  exportPngRequestSchema,
  exportPngResponseSchema,
  importAssetRequestSchema,
  uploadAssetRequestSchema,
  uploadAssetResponseSchema,
  createBoardRequestSchema,
  customAgentSchema,
  createTerminalRequestSchema,
  createWorkspaceRequestSchema,
  fileContentSchema,
  fileInfoSchema,
  fileVersionSchema,
  fileIndexSchema,
  fileSearchRequestSchema,
  fileSearchResultSchema,
  createFileEntryRequestSchema,
  renameFileEntryRequestSchema,
  fileEntryResultSchema,
  trashEntrySchema,
  trashListSchema,
  languageServiceStatusSchema,
  type FileEntryKind,
  type FileSearchRequest,
  watchFileRequestSchema,
  watchRegistrationSchema,
  importFilesResponseSchema,
  fileListSchema,
  gitCloneRequestSchema,
  gitCloneStartedSchema,
  gitCloneStatusSchema,
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitDiffRequestSchema,
  gitDiffSchema,
  gitHeadCommitSchema,
  gitInitResponseSchema,
  gitPathsRequestSchema,
  gitResolveResponseSchema,
  gitRevertRequestSchema,
  gitRevertResponseSchema,
  type GitRestoreSource,
  gitStageResponseSchema,
  gitStatusSchema,
  legacyKanbanArchivePageSchema,
  legacyKanbanArchiveSchema,
  legacyKanbanArchiveExportSchema,
  gitHunkDiffSchema,
  gitHunkMutationSchema,
  gitHunkResultSchema,
  type GitHunkMutation,
  type GitHunkScope,
  gitMessageProvidersSchema,
  gitMessageSourceSchema,
  gitMessageRequestSchema,
  gitMessageDraftSchema,
  type GitMessageRequest,
  gitBranchSnapshotSchema,
  gitHistoryPageSchema,
  gitWorktreesSchema,
  gitRebaseTodoPreviewSchema,
  gitTagSnapshotSchema,
  gitRemotesSchema,
  gitStashSnapshotSchema,
  gitStashDetailSchema,
  gitIntegrationSnapshotSchema,
  gitCherryPickPreviewSchema,
  gitCommitDetailSchema,
  gitCommitFileDiffSchema,
  gitRepositoryActionSchema,
  gitRepositoryListSchema,
  gitRepositoryOperationSchema,
  gitExpectedStateSchema,
  gitUnstageResponseSchema,
  healthSchema,
  hookInstallReportSchema,
  saveBoardRequestSchema,
  sessionsResponseSchema,
  sshHostSchema,
  sshTestResultSchema,
  adoptedSessionSchema,
  powerLeaseSchema,
  powerLeaseRequestSchema,
  powerPolicySchema,
  powerStateSchema,
  resourceSnapshotSchema,
  resourceSubscriptionSchema,
  browserAvailabilitySchema,
  browserCaptureRequestSchema,
  browserCaptureSchema,
  browserDownloadDecisionRequestSchema,
  browserDownloadListSchema,
  browserDownloadSchema,
  browserInputRequestSchema,
  browserInputResultSchema,
  browserNavigateRequestSchema,
  browserReadSchema,
  browserSessionListSchema,
  browserSessionSchema,
  browserSubscribeRequestSchema,
  browserSubscriptionSchema,
  browserViewportSchema,
  createBrowserSessionRequestSchema,
  type BrowserCaptureRequest,
  type BrowserInputRequest,
  type BrowserNavigateRequest,
  type BrowserSubscribeRequest,
  type BrowserViewport,
  type CreateBrowserSessionRequest,
  type PowerLeaseRequest,
  type PowerPolicy,
  suggestTitleResponseSchema,
  terminalBackendInfoSchema,
  terminalCaptureResponseSchema,
  terminalPasteRequestSchema,
  terminalSessionSchema,
  terminalTerminateRequestSchema,
  updateBoardRequestSchema,
  updateWorkspaceRequestSchema,
  usageSchema,
  usageMiniSchema,
  costSummarySchema,
  copilotAuthSchema,
  copilotPollSchema,
  handoffListSchema,
  handoffPrepareSchema,
  handoffViewSchema,
  workspaceListSchema,
  workspaceSchema,
  writeFileRequestSchema,
  writeFileResponseSchema,
  TERMINAL_BACKEND_CHOICES,
  type BoardDocument,
  type HandoffPrepare,
  type ContextLink,
  type CustomAgent,
  type CreateTerminalRequest,
  type SshHost,
  type CreateWorkspaceRequest,
  type DiffScope,
  type GitCloneRequest,
  type GitRepositoryAction,
  type GitExpectedState,
  type TerminateMode,
  type UpdateBoardRequest,
  type UpdateWorkspaceRequest,
} from "@armadra/shared";
import { z } from "zod";

import { t } from "../app/preferences-store";

/**
 * Runtime HTTP 客户端 —— docs/v3-agent-terminal-plan.md §7 / §15。
 *
 * 三条约束：
 *  1. 每个响应都过 zod：Runtime 是本地进程但版本可能比前端旧，
 *     字段缺失要在这里炸，而不是在渲染时炸。
 *  2. 连不上 Runtime 与「Runtime 返回错误」是两类失败：前者抛
 *     `RuntimeConnectionError`（壳里有专门的横幅），后者抛普通 Error。
 *  3. 这里不做任何缓存 / 重试 / 状态；调用方自己决定。
 */

const PAGE_URL =
  typeof window === "undefined" ? "http://localhost/" : window.location.href;

export const RUNTIME_URL = resolveRuntimeUrl(
  import.meta.env.VITE_RUNTIME_URL,
  PAGE_URL,
);

/** 这份页面是不是由 Go Host 托管、`/api` 走它的认证代理（H02）。 */
export const RUNTIME_VIA_HOST = isHostServed(
  import.meta.env.VITE_RUNTIME_URL,
  PAGE_URL,
);

/** 204 / 空响应体在进 schema 之前先变成 `undefined`。 */
const noContentSchema = z.unknown().transform(() => undefined);

export class RuntimeConnectionError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, cause?: unknown) {
    super(t("app.runtimeUnreachable", { endpoint }), { cause });
    this.name = "RuntimeConnectionError";
    this.endpoint = endpoint;
  }
}

/**
 * Runtime 回了非 2xx。消息用 Runtime 给的那句（调用方直接 toast），
 * `status` / `code` 留给需要分支的场景——例如保存冲突要提示重新加载，
 * 而不是笼统的"失败"。
 */
export class RuntimeRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(
      code === "git_execution_required"
        ? t("gitRepo.executionRequired")
        : message,
    );
    this.name = "RuntimeRequestError";
    this.status = status;
    this.code = code;
  }
}

/** 写文件的 CAS 失败（HTTP 409）。 */
export function isConflict(error: unknown): boolean {
  return error instanceof RuntimeRequestError && error.status === 409;
}

/** 只有会改状态的方法需要 CSRF；GET / HEAD 靠 SameSite Cookie 与精确 Origin。 */
function unsafeMethod(method: string | undefined): boolean {
  const value = (method ?? "GET").toUpperCase();
  return value !== "GET" && value !== "HEAD";
}

async function send(path: string, init: RequestInit | undefined, csrf: string) {
  return fetch(`${RUNTIME_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(csrf ? { "X-Armadra-CSRF": csrf } : {}),
      ...init?.headers,
    },
  });
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const guarded = RUNTIME_VIA_HOST && unsafeMethod(init?.method);
  let response: Response;
  try {
    response = await send(path, init, guarded ? await ensureHostCsrf() : "");
    // A rotated token is the one failure worth retrying: the request never
    // reached the Runtime, so nothing was executed twice. Any other 403 is the
    // Host refusing this device, and repeating it would not change that.
    if (
      guarded &&
      response.status === 403 &&
      !(init?.body instanceof FormData)
    ) {
      forgetHostCsrf();
      const renewed = await ensureHostCsrf();
      if (renewed) response = await send(path, init, renewed);
    }
  } catch (cause) {
    throw new RuntimeConnectionError(RUNTIME_URL, cause);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const body =
      payload && typeof payload === "object"
        ? (payload as { message?: unknown; code?: unknown })
        : null;
    throw new RuntimeRequestError(
      response.status,
      body?.message !== undefined
        ? String(body.message)
        : t("app.runtimeFailed", { status: response.status }),
      body?.code !== undefined ? String(body.code) : undefined,
    );
  }
  return schema.parse(payload);
}

const query = (value: string) => encodeURIComponent(value);

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}

/* ------------------------------------ 设置 -------------------------------- */

/**
 * `GET/PATCH /api/settings`。
 *
 * Runtime 侧把 settings.json 当作「已知键归一 + 未知键透传」的裸对象
 * （apps/runtime/src/settings.rs），所以这里也用宽松 object：
 * 只校验我们要读的 `terminal` 段，其它键原样留着，免得新旧版本互删配置。
 */
export const runtimeSettingsSchema = z.looseObject({
  terminal: z
    .object({
      backend: z.enum(TERMINAL_BACKEND_CHOICES).default("auto"),
      detachedGraceMinutes: z.number().int().positive().default(1440),
      /**
       * `terminal.dormantAfterSeconds`（T03，宿主设计 §7.2）。会话没有任何
       * 客户端附着这么久之后，Runtime 放慢它的输出投递——进程照跑，回放缓冲
       * 照留，一个字节都不丢。`0` = 关闭。
       */
      dormantAfterSeconds: z.number().int().nonnegative().default(120),
    })
    .default({
      backend: "auto",
      detachedGraceMinutes: 1440,
      dormantAfterSeconds: 120,
    }),
  /**
   * 每个工作空间一段（`workspaces.<id>`）。`agentMessaging` 默认关：
   * Runtime 的 `collab/messaging.rs` 在门链第三步读的就是这个键（§5.7）。
   */
  workspaces: z
    .record(
      z.string(),
      z.looseObject({
        agentMessaging: z.boolean().optional(),
        /** 这块工作空间里新建 Agent 节点时的默认 CLI（§24.1 工作区页）。 */
        defaultAgent: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * 自定义 Agent（§24.1 Agent 页）。`catch([])` 是刻意的：手改坏一条不该让
   * 整份设置解析失败，坏条目丢掉即可——和 `ssh.hosts` 同样的处理。
   */
  agents: z
    .looseObject({ custom: z.array(customAgentSchema).catch([]).default([]) })
    .optional(),
  /** Hook 直答（§5.5）：权限请求直接由 Runtime 回，不弹节点头部按钮。 */
  hooks: z.looseObject({ replyApprovals: z.boolean().optional() }).optional(),
  /**
   * `usage.*`（§19 + §4.2）。`enabled` 关掉后 Runtime 不再向任何 provider
   * 取用量；`providers` 是逐个开关，`refreshMinutes` 的 `0` 表示只手动刷新，
   * `cost.enabled` 控制本地转录扫描。
   */
  usage: z
    .looseObject({
      enabled: z.boolean().optional(),
      refreshMinutes: z.number().int().nonnegative().optional(),
      providers: z.record(z.string(), z.boolean()).optional(),
      codexCliFallback: z.boolean().optional(),
      cost: z.looseObject({ enabled: z.boolean().optional() }).optional(),
    })
    .optional(),
  /** `.armadra` 日志保留天数；`0` = 永久（§24.1 数据页）。 */
  logs: z
    .looseObject({ retentionDays: z.number().int().nonnegative().optional() })
    .optional(),
  /** 防休眠策略（T02，终端宿主设计 §9）；哪些来源的租约可以生效。 */
  power: z.looseObject({ policy: powerPolicySchema.optional() }).optional(),
  /** 资源面板打开时的采样间隔；Runtime 侧会夹在 500ms–60s 之间。 */
  resources: z
    .looseObject({ intervalMs: z.number().int().positive().optional() })
    .optional(),
  /**
   * 用户改过的键位（§24.1 快捷键页；终端宿主设计 §10）。
   *
   * 按平台分开存：`{ mac: { "canvas.tidy": "Mod+Shift+K" }, other: { … } }`。
   * 旧版本写的扁平 `{ "canvas.tidy": "Mod+Shift+K" }`（两个平台共用一条）
   * 仍然读得进来，前端首次加载时迁移一次；所以这里两种形状都收，
   * 由 `panels/settings/keymap.ts` 归一。
   */
  keymap: z
    .record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))
    .optional(),
  /**
   * SSH 主机表（§21）。Runtime 在 `normalize` 里丢掉校验不过的条目，
   * 所以这里读到的一定是可以直接建终端的主机；`catch` 兜住旧 Runtime
   * （还没有这一段）与手改坏的文件，不让整份设置解析失败。
   */
  ssh: z
    .looseObject({ hosts: z.array(sshHostSchema).catch([]).default([]) })
    .optional(),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

/** PATCH 是按段浅合并，因此每段都可以只给一部分键。 */
export interface RuntimeSettingsPatch {
  terminal?: Partial<RuntimeSettings["terminal"]>;
  workspaces?: Record<
    string,
    { agentMessaging?: boolean; defaultAgent?: string | null }
  >;
  /** 数组是整段替换（Runtime 的 merge 只对对象递归），删主机就是发新数组。 */
  ssh?: { hosts: SshHost[] };
  agents?: { custom: CustomAgent[] };
  hooks?: { replyApprovals?: boolean };
  usage?: {
    enabled?: boolean;
    refreshMinutes?: number;
    providers?: Record<string, boolean>;
    codexCliFallback?: boolean;
    cost?: { enabled?: boolean };
  };
  logs?: { retentionDays?: number };
  /** 防休眠策略（T02）。 */
  power?: { policy?: PowerPolicy };
  /** 资源面板采样间隔；Runtime 侧会夹回 500ms–60s。 */
  resources?: { intervalMs?: number };
  /**
   * 分平台的键位覆盖：`{ mac: { "canvas.tidy": "Mod+Shift+K" } }`。
   * `null` 删掉一条（回到上一层），迁移时也用它删掉旧的扁平键。
   */
  keymap?: Record<
    string,
    string | null | Record<string, string | null> | undefined
  >;
}

/* ------------------------------------ 数据 -------------------------------- */

/** `GET /api/data/info`（§24.1 数据页）。 */
export const dataInfoSchema = z.object({
  dataDir: z.string(),
  dbBytes: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  /** `0` = 永久保留。 */
  boardLogRetentionDays: z.number().int().nonnegative(),
});

export type DataInfo = z.infer<typeof dataInfoSchema>;

export const dataBackupSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});

/* ---------------------------------- 画布归属 ------------------------------ */

/**
 * `GET /api/ownership`（H01 §4）—— 画布域此刻由谁写。
 *
 * `epoch` 是十进制字符串而不是数字：它在协议里是 u64，放进 JS number 会被
 * 舍入，相邻两个纪元读起来会一模一样，于是「旧纪元的写入要拒绝」这条规则
 * 就失效了。这里解析成 `bigint`，从此不再经过 `Number`。
 *
 * `phase` 是旧 Runtime 没有的字段：缺省按 `settled` 读，只有它明确说
 * 正在切换时前端才进入维护（只读）状态。
 */
export const canvasOwnershipSchema = z.object({
  domain: z.literal("canvas"),
  owner: z.enum(["runtime", "host"]),
  epoch: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => BigInt(value)),
  phase: z.enum(["settled", "switching", "rollingBack"]).default("settled"),
  reasonCode: z.string(),
  updatedAt: z.string(),
});

export type CanvasOwnershipRecord = z.infer<typeof canvasOwnershipSchema>;

/* ------------------------------------ API --------------------------------- */

export const runtimeApi = {
  contextUsage: (
    workspaceId: string,
    nodeId: string,
    binding: {
      sessionId: string;
      generation: number;
      /**
       * The node's model selection, forwarded only as the denominator's
       * fallback: a transcript that names the model that actually answered
       * wins over what the launch line asked for.
       */
      modelId?: string | null;
    },
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/nodes/${query(nodeId)}/context-usage?sessionId=${query(binding.sessionId)}&generation=${binding.generation}${
        binding.modelId ? `&modelId=${query(binding.modelId)}` : ""
      }`,
      contextUsageSchema,
      { signal },
    ),
  /**
   * `/api/health`，不是裸的 `/health`：Host 托管这份前端时，`/health` 是
   * Host **自己**的存活探针（纯文本），只有带 `/api` 前缀的路径才会被代理到
   * Runtime。这条查询问的是 Runtime，所以走带前缀的那一条。
   */
  health: () => request("/api/health", healthSchema),
  /** 画布域的写归属；读永远可用，写按它路由（H01 §4）。 */
  canvasOwnership: () => request("/api/ownership", canvasOwnershipSchema),

  /* --------------------------------- 工作空间 --------------------------- */
  listWorkspaces: () => request("/api/workspaces", workspaceListSchema),
  createWorkspace: (input: CreateWorkspaceRequest) =>
    request("/api/workspaces", workspaceSchema, {
      method: "POST",
      ...json(createWorkspaceRequestSchema.parse(input)),
    }),
  updateWorkspace: (workspaceId: string, patch: UpdateWorkspaceRequest) =>
    request(`/api/workspaces/${workspaceId}`, workspaceSchema, {
      method: "PATCH",
      ...json(updateWorkspaceRequestSchema.parse(patch)),
    }),
  openWorkspace: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/open`, workspaceSchema, {
      method: "POST",
    }),
  /** 从列表移除：Runtime 删库里的这条记录，磁盘上的项目不动（§20）。 */
  deleteWorkspace: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}`, noContentSchema, {
      method: "DELETE",
    }),

  /* ----------------------------------- 工作区导入 ----------------------- */
  openDirectory: (input: CreateWorkspaceRequest) =>
    request("/api/workspaces/open-directory", workspaceSchema, {
      method: "POST",
      ...json(createWorkspaceRequestSchema.parse(input)),
    }),
  importWorkspace: (folder: {
    name: string;
    files: { file: File; path: string }[];
    directories: string[];
  }) => {
    const body = new FormData();
    body.append(
      "manifest",
      JSON.stringify({
        paths: folder.files.map((entry) => entry.path),
        directories: folder.directories,
      }),
    );
    folder.files.forEach((entry, index) =>
      body.append(String(index), entry.file, entry.file.name),
    );
    return request(
      `/api/workspaces/import?name=${query(Array.from(folder.name).slice(0, 120).join(""))}`,
      workspaceSchema,
      { method: "POST", body },
    );
  },

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
            // 白板快照（tldraw 计划 §6.1）：同一次 PUT 带走，Runtime 原样存。
            whiteboard: document.board.whiteboard,
          }),
        ),
      },
    ),

  /* ----------------------------------- 文件 ----------------------------- */
  fileInfo: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-info?path=${query(path)}`,
      fileInfoSchema,
    ),
  fileDownloadUrl: (workspaceId: string, path: string) =>
    `${RUNTIME_URL}/api/workspaces/${workspaceId}/file-download?path=${query(path)}`,
  importFiles: (
    workspaceId: string,
    entries: { file: File; path: string }[],
    directories: string[] = [],
  ) => {
    const body = new FormData();
    body.append(
      "manifest",
      JSON.stringify({
        paths: entries.map((entry) => entry.path),
        directories,
      }),
    );
    entries.forEach((entry, index) =>
      body.append(String(index), entry.file, entry.file.name),
    );
    return request(
      `/api/workspaces/${workspaceId}/imports`,
      importFilesResponseSchema,
      { method: "POST", body },
    );
  },
  importLocalFiles: (workspaceId: string, paths: readonly string[]) =>
    request(
      `/api/workspaces/${workspaceId}/imports/local`,
      importFilesResponseSchema,
      { method: "POST", ...json({ paths }) },
    ),
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
  /**
   * 原子写入；已有文件必须携带内容SHA，缺省仅创建新文件。
   */
  writeFile: (
    workspaceId: string,
    path: string,
    content: string,
    expectedSize?: number,
    expectedSha256?: string,
    /** Re-emit the BOM the read stripped, so a file that had one keeps it. */
    bom?: boolean,
  ) =>
    request(`/api/workspaces/${workspaceId}/file`, writeFileResponseSchema, {
      method: "PUT",
      ...json(
        writeFileRequestSchema.parse({
          path,
          content,
          ...(expectedSize === undefined ? {} : { expectedSize }),
          ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
          ...(bom ? { bom } : {}),
        }),
      ),
    }),
  /**
   * 快速打开（E01/M4）：按文件名模糊匹配，Runtime 侧跳过 .git/node_modules
   * 等目录并给出上限。`truncated` 为真时结果不完整，界面要说出来。
   */
  fileIndex: (workspaceId: string, text: string, limit?: number) =>
    request(
      `/api/workspaces/${workspaceId}/file-index?query=${query(text)}${
        limit === undefined ? "" : `&limit=${limit}`
      }`,
      fileIndexSchema,
    ),
  /** 项目搜索：Runtime 侧 grep，按文件分页（`offset` / `nextOffset`）。 */
  searchFiles: (workspaceId: string, input: FileSearchRequest) =>
    request(
      `/api/workspaces/${workspaceId}/file-search`,
      fileSearchResultSchema,
      { method: "POST", ...json(fileSearchRequestSchema.parse(input)) },
    ),
  /** 新建文件 / 新建文件夹；同名一律 409，不覆盖。 */
  createFileEntry: (workspaceId: string, path: string, kind: FileEntryKind) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries`,
      fileEntryResultSchema,
      {
        method: "POST",
        ...json(createFileEntryRequestSchema.parse({ path, kind })),
      },
    ),
  /** 重命名与移动是同一件事，只差目标路径。 */
  renameFileEntry: (workspaceId: string, from: string, to: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries/rename`,
      fileEntryResultSchema,
      {
        method: "POST",
        ...json(renameFileEntryRequestSchema.parse({ from, to })),
      },
    ),
  /** 删除到工作区 `.armadra/trash/`，不做永久删除。 */
  trashFileEntry: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries/trash`,
      trashEntrySchema,
      { method: "POST", ...json({ path }) },
    ),
  listTrash: (workspaceId: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries/trash`,
      trashListSchema,
    ),
  restoreTrash: (workspaceId: string, id: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-entries/restore`,
      fileEntryResultSchema,
      { method: "POST", ...json({ id }) },
    ),
  /**
   * 语言服务能力探测。目前唯一可能的回答是 `unavailable`：没有 LSP 就
   * 明说，不摆一个空补全列表（编辑器设计 §2、§4）。
   */
  languageService: (workspaceId: string) =>
    request(
      `/api/workspaces/${workspaceId}/language-service`,
      languageServiceStatusSchema,
    ),
  /**
   * 声明某个编辑器节点正打开这个文件（E01/M4）。
   * `status: "unsupported"` 表示这台机器没有可用的监听后端，改用 `fileVersion`。
   */
  watchFile: (workspaceId: string, path: string, nodeId: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-watch`,
      watchRegistrationSchema,
      {
        method: "POST",
        ...json(watchFileRequestSchema.parse({ path, nodeId })),
      },
    ),
  unwatchFile: (workspaceId: string, path: string, nodeId: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-watch?path=${query(path)}&nodeId=${query(nodeId)}`,
      noContentSchema,
      { method: "DELETE" },
    ),
  /** 按需版本检查：文件不存在也是正常回答（`exists: false`），不是 404。 */
  fileVersion: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/file-version?path=${query(path)}`,
      fileVersionSchema,
    ),

  /* ----------------------------------- 终端 ----------------------------- */
  createTerminal: (input: CreateTerminalRequest) =>
    request("/api/terminals", terminalSessionSchema, {
      method: "POST",
      ...json(createTerminalRequestSchema.parse(input)),
    }),
  getTerminal: (sessionId: string) =>
    request(`/api/terminals/${sessionId}`, terminalSessionSchema),
  /** 抓屏：`escapes` 为 true 时保留 SGR，供快照；否则是给 Agent 读的纯文本。 */
  captureTerminal: (
    sessionId: string,
    options: { lines?: number; escapes?: boolean } = {},
  ) => {
    const params: string[] = [];
    if (options.lines !== undefined) params.push(`lines=${options.lines}`);
    if (options.escapes !== undefined)
      params.push(`escapes=${options.escapes}`);
    const suffix = params.length > 0 ? `?${params.join("&")}` : "";
    return request(
      `/api/terminals/${sessionId}/capture${suffix}`,
      terminalCaptureResponseSchema,
    );
  },
  /** 括号粘贴；`enter` 为 true 时补一个回车。 */
  pasteTerminal: (sessionId: string, text: string, enter = false) =>
    request(`/api/terminals/${sessionId}/paste`, noContentSchema, {
      method: "POST",
      ...json(terminalPasteRequestSchema.parse({ text, enter })),
    }),
  /** 三级终止（§15.5）：中断信号 / 杀进程树 / 连持久会话一起销毁。 */
  terminateTerminal: (sessionId: string, mode: TerminateMode = "process") =>
    request(`/api/terminals/${sessionId}/terminate`, terminalSessionSchema, {
      method: "POST",
      ...json(terminalTerminateRequestSchema.parse({ mode })),
    }),
  /** 同一 session_key 起新 generation（旧代次的 WS 帧会被拒绝）。 */
  recycleTerminal: (sessionId: string) =>
    request(`/api/terminals/${sessionId}/recycle`, terminalSessionSchema, {
      method: "POST",
    }),
  terminalBackend: () =>
    request("/api/terminals/backend", terminalBackendInfoSchema),

  /* ----------------------------------- 会话 ----------------------------- */
  sessions: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/sessions`, sessionsResponseSchema),

  /* ----------------------------------- 资源 ----------------------------- */
  /**
   * 一次即时采样（T02，终端宿主设计 §8）。
   *
   * Runtime 会在这条请求里先垫一次 CPU 基线再采，所以首屏拿到的是真实
   * 数字而不是「第一次刷新恒为 0」。测不出来的指标是 `null`，面板显示
   * 短横，绝不显示 0。
   */
  resources: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${workspaceId}/resources`,
      resourceSnapshotSchema,
      {
        signal,
      },
    ),
  /**
   * 订阅 / 续约。**只有拿着订阅的时候 Runtime 才采样**：面板关掉后最后一份
   * 订阅过期，采样循环自己停下，不占 CPU。带上上次的 `subscriptionId` 就是
   * 续约；已经过期的 id 不算错，Runtime 会发一个新的回来。
   */
  subscribeResources: (
    workspaceId: string,
    subscriptionId?: string,
    /**
     * 这份订阅自己要的节奏，毫秒。离屏的节点徽标要慢的（30s）；不传就是
     * 设置里的那档。Runtime 把它夹在 `[resources.intervalMs, 60s]`：可以要
     * 得更少，要不到更多。
     */
    intervalMs?: number,
  ) =>
    request(
      `/api/workspaces/${workspaceId}/resources/subscription`,
      resourceSubscriptionSchema,
      {
        method: "POST",
        ...json({
          ...(subscriptionId ? { subscriptionId } : {}),
          ...(intervalMs ? { intervalMs } : {}),
        }),
      },
    ),
  unsubscribeResources: (workspaceId: string, subscriptionId: string) =>
    request(
      `/api/workspaces/${workspaceId}/resources/subscription/${query(subscriptionId)}`,
      noContentSchema,
      { method: "DELETE" },
    ),
  /**
   * 认领孤立会话：Runtime 把行重新绑回去，并告诉前端**该用哪个 nodeId**
   * 建节点——那就是会话自己的 key，所以恢复出来的节点拥有的正是原来那个
   * 会话。节点本身还是画布建、随画布保存。
   */
  adoptOrphanSession: (workspaceId: string, sessionId: string) =>
    request(
      `/api/workspaces/${workspaceId}/resources/orphans/${query(sessionId)}/adopt`,
      adoptedSessionSchema,
      { method: "POST" },
    ),
  /** 终止孤立会话；`orphanId` 是 `session:<id>` 或 `ref:<名字>`。 */
  terminateOrphanSession: (workspaceId: string, orphanId: string) =>
    request(
      `/api/workspaces/${workspaceId}/resources/orphans/${query(orphanId)}/terminate`,
      noContentSchema,
      { method: "POST" },
    ),

  /* --------------------------------- 防休眠 ------------------------------ */
  /** 当前策略、生效机制与全部租约（T02，设计 §9）。 */
  power: () => request("/api/power", powerStateSchema),
  /**
   * 申请租约。请求合法就一定回一个租约——**是否真的生效**看 `active` 与
   * `blockedBy`：被策略挡下的申请照样记录、照样显示，否则「为什么跑一半
   * 睡过去了」就没地方查。
   */
  acquirePowerLease: (input: PowerLeaseRequest) =>
    request("/api/power/leases", powerLeaseSchema, {
      method: "POST",
      ...json(powerLeaseRequestSchema.parse(input)),
    }),
  renewPowerLease: (leaseId: string, ttlSeconds?: number) =>
    request(`/api/power/leases/${query(leaseId)}/renew`, powerLeaseSchema, {
      method: "POST",
      ...json(ttlSeconds === undefined ? {} : { ttlSeconds }),
    }),
  releasePowerLease: (leaseId: string) =>
    request(`/api/power/leases/${query(leaseId)}`, powerStateSchema, {
      method: "DELETE",
    }),

  /* -------------------------------- 受控浏览器 --------------------------- */
  /**
   * 这台机器上有没有可用的 Chromium（B01，editor-browser-design.md §5）。
   *
   * `available: false` 是一个**要显示**的状态，不是错误：节点据此退回兼容
   * 预览，并把 `reasonCode` 与找过的路径原样告诉用户，而不是给一排按不动
   * 的按钮。
   */
  browserAvailability: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/availability`,
      browserAvailabilitySchema,
      { signal },
    ),
  browserSessions: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions`,
      browserSessionListSchema,
      { signal },
    ),
  /**
   * 建（或认领）这个节点的会话。会话按 `nodeId` 定位：节点重新挂载时
   * 拿回的是同一个页面，而不是重开一个（设计 §9）。
   */
  createBrowserSession: (
    workspaceId: string,
    input: CreateBrowserSessionRequest,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions`,
      browserSessionSchema,
      {
        method: "POST",
        ...json(createBrowserSessionRequestSchema.parse(input)),
      },
    ),
  browserSession: (
    workspaceId: string,
    sessionId: string,
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}`,
      browserSessionSchema,
      { signal },
    ),
  /**
   * `terminate=false` 只是不再展示（页面继续活着，Agent 还能操作）；
   * `true` 才真的结束会话。关节点默认走前者（设计 §9）。
   */
  closeBrowserSession: (
    workspaceId: string,
    sessionId: string,
    terminate: boolean,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}?terminate=${terminate ? "true" : "false"}`,
      noContentSchema,
      { method: "DELETE" },
    ),
  browserNavigate: (
    workspaceId: string,
    sessionId: string,
    input: BrowserNavigateRequest,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/navigate`,
      browserSessionSchema,
      {
        method: "POST",
        ...json(browserNavigateRequestSchema.parse(input)),
      },
    ),
  /** 页面 viewport 是 CSS 像素；画布缩放不写进来（设计 §8）。 */
  browserViewport: (
    workspaceId: string,
    sessionId: string,
    viewport: BrowserViewport,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/viewport`,
      browserSessionSchema,
      {
        method: "POST",
        ...json(browserViewportSchema.parse(viewport)),
      },
    ),
  /**
   * 一批输入。`navigationEpoch` 过期时 Runtime 回 409——那批就该丢掉、
   * 等新帧，重发只会点到另一个页面上（设计 §8）。
   */
  browserInput: (
    workspaceId: string,
    sessionId: string,
    input: BrowserInputRequest,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/input`,
      browserInputResultSchema,
      {
        method: "POST",
        ...json(browserInputRequestSchema.parse(input)),
      },
    ),
  /**
   * 订阅 / 续约画面。和资源面板同一套形状：没人订阅就不推帧，帧率与画质
   * 由 `visibility` 决定（设计 §8）。
   */
  browserSubscribe: (
    workspaceId: string,
    sessionId: string,
    input: BrowserSubscribeRequest,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/subscription`,
      browserSubscriptionSchema,
      {
        method: "POST",
        ...json(browserSubscribeRequestSchema.parse(input)),
      },
    ),
  browserUnsubscribe: (
    workspaceId: string,
    sessionId: string,
    subscriptionId: string,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/subscription/${query(subscriptionId)}`,
      noContentSchema,
      { method: "DELETE" },
    ),
  /** 读页面：文本 / 元素 / 链接 / 标题 / console / network（设计 §7）。 */
  browserRead: (
    workspaceId: string,
    sessionId: string,
    mode: "text" | "elements" | "links" | "title" | "console" | "network",
    options?: { limit?: number; maxBytes?: number },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ mode });
    if (options?.limit !== undefined)
      params.set("limit", String(options.limit));
    if (options?.maxBytes !== undefined)
      params.set("maxBytes", String(options.maxBytes));
    return request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/read?${params.toString()}`,
      browserReadSchema,
      { signal },
    );
  },
  /** 截图存进工作空间，回的是相对路径与 hash，不是图片字节。 */
  browserCapture: (
    workspaceId: string,
    sessionId: string,
    input: BrowserCaptureRequest = {},
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/capture`,
      browserCaptureSchema,
      {
        method: "POST",
        ...json(browserCaptureRequestSchema.parse(input)),
      },
    ),
  browserDownloads: (
    workspaceId: string,
    sessionId: string,
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/downloads`,
      browserDownloadListSchema,
      { signal },
    ),
  /** 页面要下载东西时的人工放行；拒绝也是一次明确的决定。 */
  browserDownloadDecision: (
    workspaceId: string,
    sessionId: string,
    downloadId: string,
    accept: boolean,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/browser/sessions/${query(sessionId)}/downloads/${query(downloadId)}`,
      browserDownloadSchema,
      {
        method: "POST",
        ...json(browserDownloadDecisionRequestSchema.parse({ accept })),
      },
    ),

  /* --------------------------------- 历史对话 ---------------------------- */
  /**
   * `GET /api/conversations`（§17）。Runtime 扫描本机各 CLI 的转录目录建的索引，
   * 跨项目、按 `updatedAt` 倒序；`q` 对标题与目录做大小写不敏感的子串匹配。
   * 选中一条后用 `assembleLaunchCommand({ resume: sessionId })` 起新终端节点。
   */
  conversations: (q?: string, limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) });
    const needle = q?.trim();
    if (needle) params.set("q", needle);
    return request(
      `/api/conversations?${params.toString()}`,
      conversationsResponseSchema,
    );
  },
  /** 立刻重扫一遍（Runtime 本来每 60s 自己扫）。返回这次扫了多少、写了多少。 */
  refreshConversations: () =>
    request("/api/conversations/refresh", conversationRefreshResponseSchema, {
      method: "POST",
    }),

  /* --------------------------------- Agent 协作 -------------------------- */
  /** 投递记录（§5.7 第 10 条）。只有元数据，正文从来不落盘。 */
  deliveries: (workspaceId: string, limit = 200) =>
    request(
      `/api/workspaces/${workspaceId}/deliveries?limit=${limit}`,
      deliveriesResponseSchema,
    ),
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

  /** 关闭确认的人工答复（§5.8）。`accepted:false` = 那边已经等超时了。 */
  confirmControl: (requestId: string, approve: boolean) =>
    request(
      `/api/control/confirm/${query(requestId)}`,
      controlConfirmResponseSchema,
      {
        method: "POST",
        ...json(controlConfirmRequestSchema.parse({ approve })),
      },
    ),

  /* ----------------------------------- Agent ---------------------------- */
  agents: () => request("/api/agents", agentListSchema),
  /** 装 / 卸 hook 配置（§5.3）。返回写到哪个配置文件、装的是哪一版客户端。 */
  installAgentHooks: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/hooks/install`,
      hookInstallReportSchema,
      { method: "POST" },
    ),
  uninstallAgentHooks: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/hooks/uninstall`,
      hookInstallReportSchema,
      { method: "POST" },
    ),
  /** 清掉某个节点的未读标记；其它窗口通过 workspace 事件流同步。 */
  markAgentRead: (nodeId: string) =>
    request(`/api/agent-status/${query(nodeId)}/read`, agentStatusSchema, {
      method: "POST",
    }),
  /**
   * 节点头部的 ✦ AI 命名（§17）。Runtime 依次尝试：转录首条用户消息 →
   * 终端最后一条命令 → Agent 名称，截到 40 字。不调模型，所以是毫秒级；
   * `source` 说明这句话是从哪儿来的，调用方据此决定要不要提示用户。
   */
  suggestTitle: (nodeId: string) =>
    request(
      `/api/agent-status/${query(nodeId)}/suggest-title`,
      suggestTitleResponseSchema,
      { method: "POST" },
    ),
  answerApproval: (pendingId: string, decision: "allow" | "deny") =>
    request(
      `/api/approvals/${pendingId}/answer`,
      answerApprovalResponseSchema,
      { method: "POST", ...json({ decision }) },
    ),

  /**
   * 白板导出（tldraw 计划 §6.3）。导出的可以是任意 tldraw 图形——墨迹、几何
   * 图形、整个 frame——它们只在浏览器的 store 里存在，所以由前端栅格化后上传，
   * Runtime 落盘到 `.armadra/exports/<uuid>.png`。`uuid` 不必对应任何节点。
   * 返回的 `relativePath` 就是 `ContextLink.content.pngPath` 要填的值。
   */
  exportPng: (workspaceId: string, exportId: string, dataUrl: string) =>
    request(
      `/api/workspaces/${workspaceId}/exports/${query(exportId)}/png`,
      exportPngResponseSchema,
      {
        method: "POST",
        ...json(exportPngRequestSchema.parse({ dataUrl })),
      },
    ),

  /**
   * 白板资产上传（tldraw 计划 §6.2），`TLAssetStore.upload` 的后端。
   *
   * 两种来源两种发法：`Blob` / `File` 直接以自身 MIME 原样 POST，已解码的
   * data URL 以 `{ dataUrl }` JSON POST。文件名是内容哈希，同一张图重复上传
   * 只落一份。返回的 `url` 是 Runtime 相对路径，用 `assetUrl` 或直接拼
   * `RUNTIME_URL` 得到可加载的地址。
   */
  uploadAsset: (workspaceId: string, source: Blob | string) =>
    typeof source === "string"
      ? request(
          `/api/workspaces/${workspaceId}/assets`,
          uploadAssetResponseSchema,
          {
            method: "POST",
            ...json(uploadAssetRequestSchema.parse({ dataUrl: source })),
          },
        )
      : request(
          `/api/workspaces/${workspaceId}/assets`,
          uploadAssetResponseSchema,
          {
            method: "POST",
            body: source,
            // 覆盖 request() 默认的 application/json：Runtime 用它判断扩展名。
            headers: { "Content-Type": source.type },
          },
        ),

  /**
   * 按路径导入资产（tldraw 计划 §8 Phase 3）。
   *
   * 桌面版的 OS 拖放只给得到真实路径（webview 收不到 `DataTransfer`，壳里也没
   * 装 fs 插件），所以由 Runtime 去读盘，落进和 `uploadAsset` 同一个内容寻址
   * 目录，响应也同形。绝对路径可以在工作区外（Finder 拖进来的多半在
   * `~/Downloads`），相对路径按工作区根解析。
   */
  importAsset: (workspaceId: string, path: string) =>
    request(
      `/api/workspaces/${workspaceId}/assets/import`,
      uploadAssetResponseSchema,
      {
        method: "POST",
        ...json(importAssetRequestSchema.parse({ path })),
      },
    ),

  /** `TLAssetStore.resolve` 用的绝对地址；`assetId` 是 `uploadAsset` 返回的 `id`。 */
  assetUrl: (workspaceId: string, assetId: string) =>
    `${RUNTIME_URL}/api/workspaces/${workspaceId}/assets/${query(assetId)}`,

  putContextLinks: (
    workspaceId: string,
    nodeId: string,
    links: ContextLink[],
  ) =>
    request(
      `/api/workspaces/${workspaceId}/context-links/${nodeId}`,
      contextLinksResponseSchema,
      {
        method: "PUT",
        ...json(contextLinksRequestSchema.parse({ links })),
      },
    ),

  /* ------------------------------------ git ----------------------------- */
  gitMessageProviders: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/message/providers`,
      gitMessageProvidersSchema,
      { signal },
    ),
  gitMessageSource: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/message/source`,
      gitMessageSourceSchema,
      { signal },
    ),
  gitMessageGenerate: (workspaceId: string, value: GitMessageRequest) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/message/generate`,
      gitMessageDraftSchema,
      { method: "POST", ...json(gitMessageRequestSchema.parse(value)) },
    ),
  gitHunks: (
    workspaceId: string,
    file: string,
    scope: GitHunkScope,
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/hunks?file=${query(file)}&scope=${scope}`,
      gitHunkDiffSchema,
      { signal },
    ),
  gitApplyHunk: (workspaceId: string, mutation: GitHunkMutation) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/hunks`,
      gitHunkResultSchema,
      {
        method: "POST",
        ...json(gitHunkMutationSchema.parse(mutation)),
      },
    ),
  gitStatus: (workspaceId: string, path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/status?path=${query(path)}`,
      gitStatusSchema,
    ),
  /** `git init`; only offered when a status read reported no repository. */
  gitInit: (workspaceId: string) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/init`,
      gitInitResponseSchema,
      { method: "POST" },
    ),

  /**
   * Every repository read and write names the checkout it means. `path` is
   * workspace-relative and defaults to the workspace root, so a single-repo
   * workspace behaves exactly as before (roadmap §4.1).
   */
  gitRepositories: (
    workspaceId: string,
    options: { refresh?: boolean; maxDepth?: number } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (options.refresh) params.set("refresh", "true");
    if (options.maxDepth !== undefined) {
      params.set("maxDepth", String(options.maxDepth));
    }
    const search = params.toString();
    return request(
      `/api/workspaces/${query(workspaceId)}/git/repositories${search ? `?${search}` : ""}`,
      gitRepositoryListSchema,
      { signal },
    );
  },
  gitRepositoryBranches: (
    workspaceId: string,
    path = ".",
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/branches?path=${query(path)}`,
      gitBranchSnapshotSchema,
      { signal },
    ),
  gitRepositoryOperations: (
    workspaceId: string,
    path = ".",
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations?path=${query(path)}`,
      z.array(gitRepositoryOperationSchema),
      { signal },
    ),
  /**
   * `limit` is capped by the service; the commit graph asks for 100 a page and
   * stops at 500 rows, so a long history stays a scroll rather than a stall.
   */
  gitRepositoryHistory: (
    workspaceId: string,
    reference = "HEAD",
    cursor?: string,
    signal?: AbortSignal,
    path = ".",
    limit = 50,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/history?path=${query(path)}&reference=${query(reference)}&limit=${limit}${cursor ? `&cursor=${query(cursor)}` : ""}`,
      gitHistoryPageSchema,
      { signal },
    ),
  gitRepositoryWorktrees: (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/worktrees?path=${query(path)}`,
      gitWorktreesSchema,
      { signal },
    ),
  /** The commits an interactive rebase onto `onto` would replay, in order. */
  gitRepositoryRebaseTodo: (
    workspaceId: string,
    onto: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/rebase-todo?path=${query(path)}&onto=${query(onto)}`,
      gitRebaseTodoPreviewSchema,
      { signal },
    ),
  gitRepositoryTags: (workspaceId: string, signal?: AbortSignal, path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/tags?path=${query(path)}`,
      gitTagSnapshotSchema,
      { signal },
    ),
  /** URLs come back with any embedded credentials already replaced. */
  gitRepositoryRemotes: (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/remotes?path=${query(path)}`,
      gitRemotesSchema,
      { signal },
    ),
  gitRepositoryStashes: (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/stashes?path=${query(path)}`,
      gitStashSnapshotSchema,
      { signal },
    ),
  gitRepositoryIntegration: (
    workspaceId: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/integration?path=${query(path)}`,
      gitIntegrationSnapshotSchema,
      { signal },
    ),
  /**
   * 一个提交改了哪些文件。`base` 传 `null` 表示对第一父提交比较（也就是
   * 「这个提交本身改了什么」），传 `"HEAD"` 就是「比较到当前」。
   */
  gitRepositoryCommitDetail: (
    workspaceId: string,
    oid: string,
    base: string | null,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/commit?path=${query(path)}&oid=${query(oid)}${base === null ? "" : `&base=${query(base)}`}`,
      gitCommitDetailSchema,
      { signal },
    ),
  gitRepositoryCommitFile: (
    workspaceId: string,
    oid: string,
    base: string | null,
    file: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/commit-file?path=${query(path)}&oid=${query(oid)}&file=${query(file)}${base === null ? "" : `&base=${query(base)}`}`,
      gitCommitFileDiffSchema,
      { signal },
    ),
  gitRepositoryCherryPickPreview: (
    workspaceId: string,
    oid: string,
    mainline: number | null,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/cherry-pick-preview?path=${query(path)}&oid=${query(oid)}${mainline === null ? "" : `&mainline=${mainline}`}`,
      gitCherryPickPreviewSchema,
      { signal },
    ),
  gitRepositoryStashDetail: (
    workspaceId: string,
    oid: string,
    signal?: AbortSignal,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/stash-detail?path=${query(path)}&oid=${query(oid)}`,
      gitStashDetailSchema,
      { signal },
    ),
  gitRepositoryOperate: (
    workspaceId: string,
    action: GitRepositoryAction,
    expected: GitExpectedState,
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations`,
      gitRepositoryOperationSchema,
      {
        method: "POST",
        ...json({
          path,
          action: gitRepositoryActionSchema.parse(action),
          expected: gitExpectedStateSchema.parse(expected),
        }),
      },
    ),
  gitRepositoryOperation: (
    workspaceId: string,
    operationId: string,
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations/${query(operationId)}`,
      gitRepositoryOperationSchema,
      { signal },
    ),
  gitRepositoryCancel: (workspaceId: string, operationId: string) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations/${query(operationId)}/cancel`,
      gitRepositoryOperationSchema,
      { method: "POST" },
    ),
  /**
   * `scope` 决定取索引的哪一侧：`worktree` = `git diff` + 未跟踪文件，
   * `staged` = `git diff --cached`（未跟踪文件不会出现）。给 `paths` 时
   * 只 diff 这些文件，`path` 目录参数被忽略。
   */
  gitDiff: (
    workspaceId: string,
    options: {
      path?: string;
      scope?: DiffScope;
      paths?: string[];
      ignoreWhitespace?: boolean;
    } = {},
  ) => {
    const parsed = gitDiffRequestSchema.parse(options);
    const params = new URLSearchParams({
      path: parsed.path ?? ".",
      scope: parsed.scope,
    });
    if (parsed.paths && parsed.paths.length > 0) {
      params.set("paths", parsed.paths.join(","));
    }
    if (parsed.ignoreWhitespace) params.set("ignoreWhitespace", "true");
    return request(
      `/api/workspaces/${workspaceId}/git/diff?${params.toString()}`,
      gitDiffSchema,
    );
  },
  gitStage: (workspaceId: string, paths: string[], path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/stage`,
      gitStageResponseSchema,
      {
        method: "POST",
        ...json({ ...gitPathsRequestSchema.parse({ paths }), path }),
      },
    ),
  /** `git restore --staged`：只动索引，工作区改动一律保留。 */
  gitUnstage: (workspaceId: string, paths: string[], path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/unstage`,
      gitUnstageResponseSchema,
      {
        method: "POST",
        ...json({ ...gitPathsRequestSchema.parse({ paths }), path }),
      },
    ),
  /**
   * Stage a conflicted path. Refused — with the offending line numbers — while
   * the file on disk still contains Git conflict markers.
   */
  gitMarkResolved: (workspaceId: string, paths: string[], path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/resolve`,
      gitResolveResponseSchema,
      {
        method: "POST",
        ...json({ ...gitPathsRequestSchema.parse({ paths }), path }),
      },
    ),
  /**
   * `index` restores the working tree from what is staged; `head` restores
   * from the commit and unstages as well. They lose different work, so the
   * caller always says which one it means.
   */
  gitRevert: (
    workspaceId: string,
    paths: string[],
    source: GitRestoreSource = "index",
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/revert`,
      gitRevertResponseSchema,
      {
        method: "POST",
        ...json({ ...gitRevertRequestSchema.parse({ paths, source }), path }),
      },
    ),
  /** The commit an amend would rewrite; null on an unborn branch. */
  gitHeadCommit: (workspaceId: string, signal?: AbortSignal, path = ".") =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/head-commit?path=${query(path)}`,
      gitHeadCommitSchema,
      { signal },
    ),
  gitCommit: (
    workspaceId: string,
    message: string,
    paths?: string[],
    amend?: { expectedHead: string; allowPublished: boolean },
    path = ".",
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/commit`,
      gitCommitResponseSchema,
      {
        method: "POST",
        ...json({
          ...gitCommitRequestSchema.parse({
            message,
            ...(paths && paths.length > 0 ? { paths } : {}),
            ...(amend ? { amend } : {}),
          }),
          // One request, one repository: there is deliberately no
          // cross-repository commit (roadmap §4.1).
          path,
        }),
      },
    ),

  /* --------------------------------- 克隆仓库 --------------------------- */
  /**
   * 克隆还没有工作空间，所以不走工作空间事件流：这里拿到 `jobId`，
   * 对话框自己按 500ms 轮询 `gitCloneStatus`（§20）。
   */
  cloneRepository: (input: GitCloneRequest) =>
    request("/api/git/clone", gitCloneStartedSchema, {
      method: "POST",
      ...json(gitCloneRequestSchema.parse(input)),
    }),
  /** 完成时带上 Runtime 已经建好的工作空间，直接打开它。 */
  gitCloneStatus: (jobId: string) =>
    request(`/api/git/clone/${query(jobId)}`, gitCloneStatusSchema),
  cancelClone: (jobId: string) =>
    request(`/api/git/clone/${query(jobId)}`, noContentSchema, {
      method: "DELETE",
    }),

  /* ----------------------------------- 用量 ----------------------------- */
  /**
   * 缓存快照（§19）。Runtime 自己每 5 分钟取一次，这里怎么轮询都不会
   * 触发对外请求。
   */
  usage: () => request("/api/usage", usageSchema),
  /** 手动刷新；Runtime 侧 30s 内只真取一次，超频时直接回缓存。 */
  refreshUsage: () =>
    request("/api/usage/refresh", usageSchema, { method: "POST" }),

  /** `GET /api/usage/mini`（§4.2）：托盘迷你条的两条进度。 */
  usageMini: () => request("/api/usage/mini", usageMiniSchema),

  /* --------------------------------- 本地成本 --------------------------- */
  /** 缓存的成本汇总；不触碰文件系统。 */
  usageCost: () => request("/api/usage/cost", costSummarySchema),
  /** 立刻重扫，Runtime 侧 30s 内只真扫一次。 */
  refreshUsageCost: () =>
    request("/api/usage/cost/refresh", costSummarySchema, { method: "POST" }),

  /* -------------------------------- Copilot ----------------------------- */
  /** 是否已登录、token 存在哪、有没有进行中的 device flow。 */
  copilotAuth: () => request("/api/usage/copilot", copilotAuthSchema),
  /** 开始（或续用）device flow，拿到用户码与验证地址。 */
  copilotLogin: () =>
    request("/api/usage/copilot/login", copilotAuthSchema, { method: "POST" }),
  /** 轮询一次；`progress` 不是 `pending` 就停止轮询。 */
  copilotPoll: () =>
    request("/api/usage/copilot/poll", copilotPollSchema, { method: "POST" }),
  copilotLogout: () =>
    request("/api/usage/copilot/logout", copilotAuthSchema, { method: "POST" }),

  /* ----------------------------------- 设置 ----------------------------- */
  settings: () => request("/api/settings", runtimeSettingsSchema),
  /**
   * 连通性探测（§21）：Runtime 跑一次
   * `ssh -o BatchMode=yes -o ConnectTimeout=5 <目标> true`，
   * 回 `{ok, output}`；`output` 只有末几行且已脱敏。
   */
  testSshHost: (hostId: string) =>
    request(`/api/ssh/hosts/${query(hostId)}/test`, sshTestResultSchema, {
      method: "POST",
    }),
  updateSettings: (patch: RuntimeSettingsPatch) =>
    request("/api/settings", runtimeSettingsSchema, {
      method: "PATCH",
      ...json(patch),
    }),

  /* ----------------------------------- 数据 ----------------------------- */
  /** 数据目录、数据库大小、对话索引条数、日志保留天数（§24.1 数据页）。 */
  dataInfo: () => request("/api/data/info", dataInfoSchema),
  /** 把 `canvas.db` 原样复制到同目录的 `…backup-manual-<时间戳>`。 */
  backupData: () =>
    request("/api/data/backup", dataBackupSchema, { method: "POST" }),
  legacyKanbanArchives: (cursor?: string, signal?: AbortSignal) =>
    request(
      `/api/data/legacy-kanban-archives?limit=50${cursor !== undefined ? `&cursor=${query(cursor)}` : ""}`,
      legacyKanbanArchivePageSchema,
      { signal },
    ),
  legacyKanbanArchive: (canvasId: string, signal?: AbortSignal) =>
    request(
      `/api/data/legacy-kanban-archives/${query(canvasId)}`,
      legacyKanbanArchiveSchema,
      { signal },
    ),
  exportLegacyKanbanArchive: (canvasId: string) =>
    request(
      `/api/data/legacy-kanban-archives/${query(canvasId)}/export`,
      legacyKanbanArchiveExportSchema,
    ),
};

/* ------------------------------- WebSocket URL ---------------------------- */

/**
 * WebSocket 的基址不一定等于 HTTP 的基址：打包桌面壳里 HTTP 走 `armadra://`
 * 自定义协议，而 ws 只能走壳开的回环转发端口（roadmap §4.4）。端口每次启动随机，
 * 所以由 {@link initRuntimeSockets} 在建立任何 socket 之前问一次壳。
 */
let socketBase = RUNTIME_URL;

/** 应用启动时调用一次；失败时保持 HTTP 基址，浏览器模式下二者本来就相同。 */
export async function initRuntimeSockets(): Promise<string> {
  socketBase = await resolveSocketBase(RUNTIME_URL);
  return socketBase;
}

function socketUrl(pathname: string): string {
  return runtimeSocketUrl(socketBase, pathname);
}

/**
 * `writerId` 让 Runtime 在 `hello` 里带回这个客户端已经落地的输入序号，
 * 重连时只重发没落地的那几条（见 `terminal/input-log.ts`）。
 */
export function terminalWebSocketUrl(
  sessionId: string,
  writerId?: string,
): string {
  const base = socketUrl(`/api/terminals/${sessionId}/ws`);
  return writerId ? `${base}?writer=${query(writerId)}` : base;
}

/** 工作空间事件流：agent.status / agent.approval / terminal.exit / board.changed。 */
export function workspaceEventsUrl(workspaceId: string): string {
  return socketUrl(`/api/workspaces/${workspaceId}/events`);
}
