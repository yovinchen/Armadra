import {
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
} from "@armadra/shared";
import { json, noContentSchema, query, request } from "./request";

export const browserApi = {
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
};
