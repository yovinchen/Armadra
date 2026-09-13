import {
  agentListSchema,
  agentModelListSchema,
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
  skillReportSchema,
  suggestTitleResponseSchema,
  agentTranscriptSchema,
  uploadAssetRequestSchema,
  uploadAssetResponseSchema,
  type ContextLink,
} from "@armadra/shared";
import {
  agentIntegrationSchema,
  integrationRepairSchema,
} from "../panels/settings/pages/integration/types";
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
  /**
   * 节点头部「模型」菜单的候选（F7）。按发布日期倒序，每条注明来自 CLI 自己、
   * models.dev 目录，还是离线兜底表。Runtime 侧缓存 10 分钟，所以开菜单时
   * 反复请求不会反复起进程。
   */
  agentModels: (agentId: string) =>
    request(`/api/agents/${query(agentId)}/models`, agentModelListSchema),
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
  /**
   * 协作技能（`skills/armadra/SKILL.md`），与状态 Hook 分开装卸。
   * `paths` 是磁盘上真正变过的文件：内容没变时是空数组，文件的 mtime 不动。
   */
  installAgentSkills: (agentId: string) =>
    request(`/api/agents/${query(agentId)}/skills/install`, skillReportSchema, {
      method: "POST",
    }),
  uninstallAgentSkills: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/skills/uninstall`,
      skillReportSchema,
      { method: "POST" },
    ),
  /**
   * 接入状态（[Agent 接入归一](../../../../docs/design/agent-integration-mcp.md) §6）。
   *
   * 一次读出「注入方式、Hook、技能、旧残留」四件事：设置页要在**一行**里
   * 回答它们，分四个请求问只会让四段状态在不同的时刻到达，那一行会跳。
   *
   * schema 现在声明在设置页自己的 `integration/types.ts`，等 Runtime 那批
   * 改动把类型加进 `@armadra/shared` 之后换成从那里引入。
   */
  agentIntegration: (agentId: string, signal?: AbortSignal) =>
    request(
      `/api/agents/${query(agentId)}/integration`,
      agentIntegrationSchema,
      signal ? { signal } : {},
    ),
  /** 装 / 卸接入物：Hook 与技能是**一个**安装单元，不分两个按钮。 */
  installAgentIntegration: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/integration/install`,
      agentIntegrationSchema,
      { method: "POST" },
    ),
  uninstallAgentIntegration: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/integration/uninstall`,
      agentIntegrationSchema,
      { method: "POST" },
    ),
  /**
   * 清掉旧产品名时期的残留（设计 §5）：`aicc-hook` / `nodeterm` 的 hook 条目、
   * `aicc-canvas` 这些技能目录、Codex `hooks.json` 里被现行 schema 拒绝的
   * `version`。先备份原文件，只动认得出来的条目。
   */
  repairAgentIntegration: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/integration/repair`,
      integrationRepairSchema,
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
  /**
   * 一个节点自己的对话尾部（每条消息一行散文）。
   *
   * 是读，所以两种归属下都答：转录本来就是这台机器上的文件，Worker 通道的
   * `ReadTranscript` 读的是同一份。没有可读转录的 CLI 回 501 并说明原因，
   * 不回空正文——空正文和「这一轮还没说话」分不开。
   */
  agentTranscript: (nodeId: string, maxBytes?: number) =>
    request(
      `/api/agent-status/${query(nodeId)}/transcript${
        maxBytes ? `?maxBytes=${maxBytes}` : ""
      }`,
      agentTranscriptSchema,
    ),
  answerApproval: (pendingId: string, decision: "allow" | "deny") =>
    request(
      `/api/approvals/${pendingId}/answer`,
      answerApprovalResponseSchema,
      { method: "POST", ...json({ decision }) },
    ),

  /**
   * 白板导出（旧画布契约 §6.3）。导出的可以是任意 白板对象——墨迹、几何
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
   * 白板资产上传（旧画布契约 §6.2），白板图片上传的后端。
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
   * 按路径导入资产（旧画布契约 §8 Phase 3）。
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
