import {
  agentListSchema,
  agentModelListSchema,
  agentStatusSchema,
  answerApprovalResponseSchema,
  contextLinksRequestSchema,
  contextLinksResponseSchema,
  contextReadsResponseSchema,
  controlConfirmRequestSchema,
  controlConfirmResponseSchema,
  deliveriesResponseSchema,
  deliveryCancelResponseSchema,
  deliveryQueueResponseSchema,
  dependenciesResponseSchema,
  dependencyCancelResponseSchema,
  legacyDependencyRequestSchema,
  legacyDependencyResponseSchema,
  exportPngRequestSchema,
  exportPngResponseSchema,
  importAssetRequestSchema,
  integrationRepairReportSchema,
  integrationStateSchema,
  suggestTitleResponseSchema,
  agentTranscriptSchema,
  uploadAssetRequestSchema,
  uploadAssetResponseSchema,
  type ContextLink,
} from "@armadra/shared";
import { RUNTIME_URL, json, query, request } from "./request";

export const agentsApi = {
  /* --------------------------------- Agent 协作 -------------------------- */
  /** 投递记录（§5.7 第 10 条）。只有元数据，正文从来不落盘。 */
  deliveries: (workspaceId: string, limit = 200) =>
    request(
      `/api/workspaces/${workspaceId}/deliveries?limit=${limit}`,
      deliveriesResponseSchema,
    ),
  /**
   * 排在一个终端节点前面的那些（设计 `agent-delivery.md` §4.6、§10）。
   *
   * 与上面那条是同一条路径的两个切片：记录说「发生过什么」，这一条说「还压着
   * 什么」。节点头的「排队 N」数的就是它，所以计数不由页面自己按事件加减——
   * core 才是那张表的唯一来源。
   */
  deliveryQueue: (workspaceId: string, nodeId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/deliveries?node=${query(nodeId)}`,
      deliveryQueueResponseSchema,
      { signal },
    ),
  /**
   * 谁读过这个节点的转录（设计 §10）。
   *
   * 读是一件发生过的事，读的人知道，被读的人今天不知道；节点头的「被读取 N
   * 次」数的就是它。只有元数据：谁、什么动词、多少字节、什么时候。
   */
  contextReads: (nodeId: string, signal?: AbortSignal) =>
    request(
      `/api/nodes/${query(nodeId)}/context-reads`,
      contextReadsResponseSchema,
      { signal },
    ),
  /** 人拒收一条还排着的。已经在投的那条收不回来，答 `cancelled:false`。 */
  cancelDelivery: (workspaceId: string, deliveryId: string) =>
    request(
      `/api/workspaces/${query(workspaceId)}/deliveries/${query(deliveryId)}`,
      deliveryCancelResponseSchema,
      { method: "DELETE" },
    ),
  /**
   * 还没了结的依赖等待，按下游分组（Agent 自动化设计 §6）。等待关系由 core
   * 持有，节点头的「等待 X」与 rope 边都从这里读。
   */
  dependencies: (workspaceId: string, signal?: AbortSignal) =>
    request(
      `/api/workspaces/${query(workspaceId)}/dependencies`,
      dependenciesResponseSchema,
      { signal },
    ),
  /** 不等这条边了；其余的边都已满足时，core 当场启动下游。 */
  cancelDependency: (workspaceId: string, dependencyId: string) =>
    request(
      `/api/workspaces/${query(workspaceId)}/dependencies/${query(dependencyId)}`,
      dependencyCancelResponseSchema,
      { method: "DELETE" },
    ),
  /** 旧节点数据里带依赖的 `pendingLaunch` 迁进依赖表。重复调用不重复建。 */
  importLegacyDependencies: (
    workspaceId: string,
    nodeId: string,
    after: readonly string[],
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/dependencies`,
      legacyDependencyResponseSchema,
      {
        method: "POST",
        ...json(legacyDependencyRequestSchema.parse({ nodeId, after })),
      },
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
  /**
   * 集成状态（设计 agent-integration §5）：Hook 与技能是**一个**安装单元，
   * 一次读出注入方式、两半各自的路径与修订、以及旧产品名留下的残留。
   */
  agentIntegration: (agentId: string, signal?: AbortSignal) =>
    request(
      `/api/agents/${query(agentId)}/integration`,
      integrationStateSchema,
      signal ? { signal } : {},
    ),
  /** 一次装好 Hook 与技能。幂等：内容没变的技能文件连 mtime 都不动。 */
  installAgentIntegration: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/integration/install`,
      integrationStateSchema,
      { method: "POST" },
    ),
  uninstallAgentIntegration: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/integration/uninstall`,
      integrationStateSchema,
      { method: "POST" },
    ),
  /**
   * 清掉旧产品名留下的条目（设计 §4）。只动认得出是我们写的那些，
   * 重写前先备份成 `<file>.armadra-backup-<时间戳>`，其余原样写回。
   */
  repairAgentIntegration: (agentId: string) =>
    request(
      `/api/agents/${query(agentId)}/integration/repair`,
      integrationRepairReportSchema,
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
