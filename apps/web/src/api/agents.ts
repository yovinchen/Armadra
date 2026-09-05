import {
  agentListSchema,
  agentStatusSchema,
  answerApprovalResponseSchema,
  contextLinksRequestSchema,
  contextLinksResponseSchema,
  contextUsageSchema,
  controlConfirmRequestSchema,
  controlConfirmResponseSchema,
  deliveriesResponseSchema,
  exportPngRequestSchema,
  exportPngResponseSchema,
  hookInstallReportSchema,
  importAssetRequestSchema,
  suggestTitleResponseSchema,
  uploadAssetRequestSchema,
  uploadAssetResponseSchema,
  type ContextLink,
} from "@armadra/shared";
import { RUNTIME_URL, json, query, request } from "./request";

export const agentsApi = {
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
};
