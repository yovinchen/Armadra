import {
  conversationRefreshResponseSchema,
  conversationsResponseSchema,
} from "@armadra/shared";
import { request } from "./request";

export const conversationsApi = {
  /* --------------------------------- 历史对话 ---------------------------- */
  /**
   * `GET /api/conversations`（§17）。Runtime 扫描本机各 CLI 的转录目录建的索引，
   * 跨项目、按 `updatedAt` 倒序；`q` 对标题与目录做大小写不敏感的子串匹配。
   * 选中一条后用 `buildResumeLaunch(provider, sessionId)` 起新终端节点。
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
};
