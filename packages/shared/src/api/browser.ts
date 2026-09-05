import { z } from "zod";

/**
 * 受控内嵌浏览器（B01，editor-browser-design.md §5–§9）。
 *
 * 每个浏览器节点对应一个由 Runtime 管理的 headless Chrome 会话，画面以
 * JPEG 帧走工作空间事件流推下来，输入按 CSS viewport 坐标回传。节点关掉
 * 只是不再订阅画面，会话本身由 §9 的生命周期决定，不随节点消失。
 */
export const BROWSER_SESSION_STATES = [
  "starting",
  "ready",
  "disconnected",
  "terminated",
  "unsupported",
] as const;
export const browserSessionStateSchema = z.enum(BROWSER_SESSION_STATES);

/**
 * 页面 viewport 用 CSS 像素（§8）。画布缩放只影响显示框大小，不写进这里，
 * 否则每次缩放都会触发一次真实的 reflow。
 */
export const browserViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().default(1),
});

/**
 * `navigationEpoch` 是「这一页」的编号：导航一次就 +1，旧 epoch 的输入
 * 会被 Runtime 拒（409），客户端丢弃该批并等新帧，绝不重放（§8）。
 */
export const browserSessionSchema = z.object({
  sessionId: z.string(),
  generation: z.number().int().nonnegative(),
  workspaceId: z.string(),
  nodeId: z.string(),
  url: z.string(),
  title: z.string(),
  viewport: browserViewportSchema,
  state: browserSessionStateSchema,
  reasonCode: z.string(),
  navigationEpoch: z.number().int().nonnegative(),
  headful: z.boolean(),
  keepAlive: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * 这台机器上到底有没有可用的 Chromium（§5）。`available: false` 时界面
 * 只显示原因与找过的路径，不给任何按不动的按钮。
 */
export const browserAvailabilitySchema = z.object({
  available: z.boolean(),
  executable: z.string(),
  source: z.enum(["settings", "environment", "detected", "none"]),
  reasonCode: z.string(),
  searched: z.array(z.string()).default([]),
});

export const browserSessionListSchema = z.object({
  sessions: z.array(browserSessionSchema),
  availability: browserAvailabilitySchema,
});

export const createBrowserSessionRequestSchema = z.object({
  nodeId: z.string(),
  url: z.string().optional(),
  viewport: browserViewportSchema.optional(),
  headful: z.boolean().optional(),
});

export const BROWSER_NAVIGATION_ACTIONS = [
  "goto",
  "back",
  "forward",
  "reload",
  "stop",
] as const;
export const browserNavigateRequestSchema = z.object({
  action: z.enum(BROWSER_NAVIGATION_ACTIONS),
  url: z.string().optional(),
});

export const BROWSER_INPUT_KINDS = [
  "mouseMoved",
  "mousePressed",
  "mouseReleased",
  "wheel",
  "keyDown",
  "keyUp",
  "text",
  "touchStart",
  "touchMove",
  "touchEnd",
] as const;

/**
 * 一条输入事件。字段全给了默认值：一次点击只需要 `kind` / `x` / `y` /
 * `button`，中文输入只需要 `kind: "text"` 与 `text`——补零补空串比让调用
 * 方拼一个完整对象更不容易出错。
 */
export const browserInputEventSchema = z.object({
  kind: z.enum(BROWSER_INPUT_KINDS),
  x: z.number().default(0),
  y: z.number().default(0),
  deltaX: z.number().default(0),
  deltaY: z.number().default(0),
  button: z.enum(["none", "left", "middle", "right"]).default("none"),
  clickCount: z.number().int().nonnegative().default(0),
  modifiers: z.number().int().nonnegative().default(0),
  key: z.string().default(""),
  code: z.string().default(""),
  text: z.string().default(""),
});

export const browserInputRequestSchema = z.object({
  navigationEpoch: z.number().int().nonnegative(),
  frameSeq: z.number().int().nonnegative().optional(),
  events: z.array(browserInputEventSchema).min(1).max(64),
});

export const browserInputResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  navigationEpoch: z.number().int().nonnegative(),
});

/** 没人看的会话停止推帧（§8）；`hidden` 是标签页切走，不是节点折叠。 */
export const BROWSER_VISIBILITIES = ["focused", "visible", "hidden"] as const;
export const browserSubscribeRequestSchema = z.object({
  subscriptionId: z.string().optional(),
  visibility: z.enum(BROWSER_VISIBILITIES),
});
export const browserSubscriptionSchema = z.object({
  subscriptionId: z.string(),
  expiresAt: z.string(),
  quality: z.number().int(),
  maxFps: z.number().int(),
});

/** 稳定元素引用绑定 session/frame/epoch；导航后失效（§7）。 */
export const browserElementSchema = z.object({
  elementRef: z.string(),
  role: z.string(),
  name: z.string(),
  value: z.string(),
  selector: z.string(),
  visible: z.boolean(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const browserConsoleEntrySchema = z.object({
  at: z.string(),
  level: z.string(),
  text: z.string(),
  url: z.string(),
  line: z.number().int().nonnegative(),
});

export const browserNetworkEntrySchema = z.object({
  at: z.string(),
  method: z.string(),
  url: z.string(),
  status: z.number().int().nonnegative(),
  mimeType: z.string(),
  encodedBytes: z.number().int().nonnegative(),
  failureCode: z.string(),
  fromCache: z.boolean(),
});

/** `GET …/read?mode=…` 的统一回包；`truncated` 说明内容被上限截断。 */
export const browserReadSchema = z.object({
  sessionId: z.string(),
  navigationEpoch: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string(),
  text: z.string().default(""),
  elements: z.array(browserElementSchema).default([]),
  console: z.array(browserConsoleEntrySchema).default([]),
  network: z.array(browserNetworkEntrySchema).default([]),
  truncated: z.boolean().default(false),
});

export const browserCaptureRequestSchema = z.object({
  fullPage: z.boolean().optional(),
  format: z.enum(["png", "jpeg"]).optional(),
});

/** 截图落在工作空间里，回的是工作空间相对路径与 hash，不是图片本身。 */
export const browserCaptureSchema = z.object({
  path: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  sha256: z.string(),
  bytes: z.number().int(),
  navigationEpoch: z.number().int().nonnegative(),
});

export const BROWSER_DOWNLOAD_STATES = [
  "pending",
  "inProgress",
  "completed",
  "cancelled",
  "failed",
] as const;

export const browserDownloadSchema = z.object({
  downloadId: z.string(),
  sessionId: z.string(),
  url: z.string(),
  suggestedFilename: z.string(),
  state: z.enum(BROWSER_DOWNLOAD_STATES),
  path: z.string(),
  totalBytes: z.number().int().nonnegative(),
  receivedBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
  reasonCode: z.string(),
});

export const browserDownloadListSchema = z.object({
  downloads: z.array(browserDownloadSchema),
});

export const browserDownloadDecisionRequestSchema = z.object({
  accept: z.boolean(),
});

export type BrowserSessionState = z.infer<typeof browserSessionStateSchema>;
export type BrowserViewport = z.infer<typeof browserViewportSchema>;
export type BrowserSession = z.infer<typeof browserSessionSchema>;
export type BrowserAvailability = z.infer<typeof browserAvailabilitySchema>;
export type BrowserSessionList = z.infer<typeof browserSessionListSchema>;
export type CreateBrowserSessionRequest = z.infer<
  typeof createBrowserSessionRequestSchema
>;
export type BrowserNavigationAction =
  (typeof BROWSER_NAVIGATION_ACTIONS)[number];
export type BrowserNavigateRequest = z.infer<
  typeof browserNavigateRequestSchema
>;
export type BrowserInputKind = (typeof BROWSER_INPUT_KINDS)[number];
export type BrowserInputEvent = z.infer<typeof browserInputEventSchema>;
export type BrowserInputRequest = z.infer<typeof browserInputRequestSchema>;
export type BrowserInputResult = z.infer<typeof browserInputResultSchema>;
export type BrowserVisibility = (typeof BROWSER_VISIBILITIES)[number];
export type BrowserSubscribeRequest = z.infer<
  typeof browserSubscribeRequestSchema
>;
export type BrowserSubscription = z.infer<typeof browserSubscriptionSchema>;
export type BrowserElement = z.infer<typeof browserElementSchema>;
export type BrowserConsoleEntry = z.infer<typeof browserConsoleEntrySchema>;
export type BrowserNetworkEntry = z.infer<typeof browserNetworkEntrySchema>;
export type BrowserRead = z.infer<typeof browserReadSchema>;
export type BrowserCaptureRequest = z.infer<typeof browserCaptureRequestSchema>;
export type BrowserCapture = z.infer<typeof browserCaptureSchema>;
export type BrowserDownloadState = (typeof BROWSER_DOWNLOAD_STATES)[number];
export type BrowserDownload = z.infer<typeof browserDownloadSchema>;
export type BrowserDownloadList = z.infer<typeof browserDownloadListSchema>;
export type BrowserDownloadDecisionRequest = z.infer<
  typeof browserDownloadDecisionRequestSchema
>;
