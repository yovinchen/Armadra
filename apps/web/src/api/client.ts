import { resolveRuntimeUrl, runtimeSocketUrl } from "./runtime-url";
import {
  agentListSchema,
  agentStatusSchema,
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
  importFilesResponseSchema,
  fileListSchema,
  gitCloneRequestSchema,
  gitCloneStartedSchema,
  gitCloneStatusSchema,
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitDiffRequestSchema,
  gitDiffSchema,
  gitPathsRequestSchema,
  gitRevertResponseSchema,
  gitStageResponseSchema,
  gitStatusSchema,
  gitBranchSnapshotSchema,
  gitHistoryPageSchema,
  gitWorktreesSchema,
  gitRepositoryActionSchema,
  gitRepositoryOperationSchema,
  gitExpectedStateSchema,
  gitUnstageResponseSchema,
  healthSchema,
  hookInstallReportSchema,
  saveBoardRequestSchema,
  sessionsResponseSchema,
  sshHostSchema,
  sshTestResultSchema,
  suggestTitleResponseSchema,
  terminalBackendInfoSchema,
  terminalCaptureResponseSchema,
  terminalPasteRequestSchema,
  terminalSessionSchema,
  terminalTerminateRequestSchema,
  updateBoardRequestSchema,
  updateWorkspaceRequestSchema,
  usageSchema,
  workspaceListSchema,
  workspaceSchema,
  writeFileRequestSchema,
  writeFileResponseSchema,
  type BoardDocument,
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

export const RUNTIME_URL = resolveRuntimeUrl(
  import.meta.env.VITE_RUNTIME_URL,
  typeof window === "undefined" ? "http://localhost/" : window.location.href,
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
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
    this.code = code;
  }
}

/** 写文件的 CAS 失败（HTTP 409）。 */
export function isConflict(error: unknown): boolean {
  return error instanceof RuntimeRequestError && error.status === 409;
}

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
        ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    });
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
      backend: z.enum(["auto", "tmux", "direct"]).default("auto"),
      detachedGraceMinutes: z.number().int().positive().default(1440),
    })
    .default({ backend: "auto", detachedGraceMinutes: 1440 }),
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
  /** `usage.enabled`（§19）：关掉后 Runtime 不再向 Claude / Codex 取用量。 */
  usage: z.looseObject({ enabled: z.boolean().optional() }).optional(),
  /** `.armadra` 日志保留天数；`0` = 永久（§24.1 数据页）。 */
  logs: z
    .looseObject({ retentionDays: z.number().int().nonnegative().optional() })
    .optional(),
  /**
   * 用户改过的键位：`commandId → "Mod+Shift+K"`（§24.1 快捷键页）。
   * 一条命令一个写法，两个平台共用——录制时抓的就是这台机器上的物理组合。
   */
  keymap: z.record(z.string(), z.string()).optional(),
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
  usage?: { enabled?: boolean };
  logs?: { retentionDays?: number };
  /** `null` 删掉一条自定义键位，回到默认。 */
  keymap?: Record<string, string | null>;
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

/* ------------------------------------ API --------------------------------- */

export const runtimeApi = {
  health: () => request("/health", healthSchema),

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
    request("/api/workspaces/open-directory", workspaceSchema, { method: "POST", ...json(createWorkspaceRequestSchema.parse(input)) }),
  importWorkspace: (folder: { name: string; files: { file: File; path: string }[]; directories: string[] }) => {
    const body = new FormData();
    body.append("manifest", JSON.stringify({ paths: folder.files.map((entry) => entry.path), directories: folder.directories }));
    folder.files.forEach((entry, index) => body.append(String(index), entry.file, entry.file.name));
    return request(`/api/workspaces/import?name=${query(Array.from(folder.name).slice(0, 120).join(""))}`, workspaceSchema, { method: "POST", body });
  },

  /* ----------------------------------- 看板 ----------------------------- */
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

  /* --------------------------------- 看板文档 --------------------------- */
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
            // 看板数据（§17）：和节点、连线一样跟着这次 PUT 落库。
            kanban: document.board.kanban,
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
   * 原子写入（tmp + rename）。给 `expectedSize`（上次读到的字节数）就是
   * 乐观锁：文件在这期间被 Agent 改过时 Runtime 返 409，调用方提示重载而
   * 不是把别人的修改盖掉。
   */
  writeFile: (
    workspaceId: string,
    path: string,
    content: string,
    expectedSize?: number,
  ) =>
    request(`/api/workspaces/${workspaceId}/file`, writeFileResponseSchema, {
      method: "PUT",
      ...json(
        writeFileRequestSchema.parse({
          path,
          content,
          ...(expectedSize === undefined ? {} : { expectedSize }),
        }),
      ),
    }),

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
  gitStatus: (workspaceId: string) =>
    request(`/api/workspaces/${workspaceId}/git/status`, gitStatusSchema),

  gitRepositoryBranches: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/branches?path=.`,
      gitBranchSnapshotSchema,
      { signal },
    ),
  gitRepositoryHistory: (
    workspaceId: string,
    reference = "HEAD",
    cursor?: string,
    signal?: AbortSignal,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/history?path=.&reference=${query(reference)}&limit=50${cursor ? `&cursor=${query(cursor)}` : ""}`,
      gitHistoryPageSchema,
      { signal },
    ),
  gitRepositoryWorktrees: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/worktrees?path=.`,
      gitWorktreesSchema,
      { signal },
    ),
  gitRepositoryOperate: (
    workspaceId: string,
    action: GitRepositoryAction,
    expected: GitExpectedState,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/git/repository/operations`,
      gitRepositoryOperationSchema,
      {
        method: "POST",
        ...json({
          path: ".",
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
    options: { path?: string; scope?: DiffScope; paths?: string[] } = {},
  ) => {
    const parsed = gitDiffRequestSchema.parse(options);
    const params = new URLSearchParams({
      path: parsed.path ?? ".",
      scope: parsed.scope,
    });
    if (parsed.paths && parsed.paths.length > 0) {
      params.set("paths", parsed.paths.join(","));
    }
    return request(
      `/api/workspaces/${workspaceId}/git/diff?${params.toString()}`,
      gitDiffSchema,
    );
  },
  gitStage: (workspaceId: string, paths: string[]) =>
    request(
      `/api/workspaces/${workspaceId}/git/stage`,
      gitStageResponseSchema,
      { method: "POST", ...json(gitPathsRequestSchema.parse({ paths })) },
    ),
  /** `git restore --staged`：只动索引，工作区改动一律保留。 */
  gitUnstage: (workspaceId: string, paths: string[]) =>
    request(
      `/api/workspaces/${workspaceId}/git/unstage`,
      gitUnstageResponseSchema,
      { method: "POST", ...json(gitPathsRequestSchema.parse({ paths })) },
    ),
  gitRevert: (workspaceId: string, paths: string[]) =>
    request(
      `/api/workspaces/${workspaceId}/git/revert`,
      gitRevertResponseSchema,
      { method: "POST", ...json(gitPathsRequestSchema.parse({ paths })) },
    ),
  gitCommit: (workspaceId: string, message: string, paths?: string[]) =>
    request(
      `/api/workspaces/${workspaceId}/git/commit`,
      gitCommitResponseSchema,
      {
        method: "POST",
        ...json(
          gitCommitRequestSchema.parse({
            message,
            ...(paths && paths.length > 0 ? { paths } : {}),
          }),
        ),
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
};

/* ------------------------------- WebSocket URL ---------------------------- */

function socketUrl(pathname: string): string {
  return runtimeSocketUrl(RUNTIME_URL, pathname);
}

export function terminalWebSocketUrl(sessionId: string): string {
  return socketUrl(`/api/terminals/${sessionId}/ws`);
}

/** 工作空间事件流：agent.status / agent.approval / terminal.exit / board.changed。 */
export function workspaceEventsUrl(workspaceId: string): string {
  return socketUrl(`/api/workspaces/${workspaceId}/events`);
}
