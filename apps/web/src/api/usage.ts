import {
  copilotAuthSchema,
  copilotPollSchema,
  costSummarySchema,
  modelCatalogSchema,
  usageMiniSchema,
  usageSchema,
} from "@armadra/shared";
import { request } from "./request";

export const usageApi = {
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

  /* -------------------------------- 模型目录 ---------------------------- */
  /**
   * 价格与上下文上限的出处（F10）。只读内存里那份，不会触发对外请求。
   */
  modelCatalog: () => request("/api/models/catalog", modelCatalogSchema),
  /**
   * 立刻去 models.dev 取一次。联网只发生在 Runtime 侧；取不到时仍回 200，
   * 带上 `refreshError`，其余字段描述的还是当前在用的那份目录。
   */
  refreshModelCatalog: () =>
    request("/api/models/catalog/refresh", modelCatalogSchema, {
      method: "POST",
    }),

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
};
