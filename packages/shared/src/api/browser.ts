import { z } from "zod";

import { DRIVE_LEASE_STATES, driveLeaseSchema } from "./drive.js";

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

/* -------------------------- 受管浏览器二进制（§2.1） -------------------------- */

/**
 * 受管二进制永不自动下载：清单随构建内置，用户点一次才装。`supported: false`
 * 表示这个构建的清单没有本机 OS/arch 的条目，界面说明情况而不是给一个按不动
 * 的按钮。
 */
export const BROWSER_MANAGED_STATES = [
  "absent",
  "downloading",
  "verifying",
  "installed",
  "failed",
] as const;
export const browserManagedStateSchema = z.object({
  state: z.enum(BROWSER_MANAGED_STATES),
  version: z.string(),
  receivedBytes: z.number().int().nonnegative().default(0),
  totalBytes: z.number().int().nonnegative().default(0),
  /** `manifest_missing_target` / `sha256_mismatch` / `signature_invalid` / `network` / `download_disabled`。 */
  reasonCode: z.string().default(""),
  executable: z.string().default(""),
  supported: z.boolean().default(false),
});

/* ---------------------------- 标签与 frame（§2.2） --------------------------- */

/** 缺省是活动标签的主 frame，所以引入标签之前的调用方一个字都不用改。 */
export const browserTargetSchema = z.object({
  tabId: z.string().optional(),
  frameId: z.string().optional(),
});

/** 每 session ≤ 16 个标签，超出的新开被拒并记 `tab_limit`。 */
export const BROWSER_TAB_LIMIT = 16;

/* ------------------------------ 对话框（§2.4） ------------------------------ */

export const BROWSER_DIALOG_KINDS = [
  "alert",
  "confirm",
  "prompt",
  "beforeunload",
] as const;
export const browserDialogSchema = z.object({
  dialogId: z.string(),
  tabId: z.string(),
  kind: z.enum(BROWSER_DIALOG_KINDS),
  message: z.string(),
  defaultPrompt: z.string().default(""),
  url: z.string().default(""),
  openedAt: z.string(),
});

export const browserDialogRequestSchema = z.object({
  tabId: z.string().optional(),
  dialogId: z.string().optional(),
  accept: z.boolean(),
  promptText: z.string().optional(),
  leaseGeneration: z.number().int().nonnegative().optional(),
});

/** `accept` 是页面给挑选器的提示，不是这一侧执行的过滤条件。 */
export const browserFileChooserSchema = z.object({
  chooserId: z.string(),
  tabId: z.string(),
  frameId: z.string().default(""),
  multiple: z.boolean().default(false),
  accept: z.string().default(""),
  openedAt: z.string(),
});

export const browserTabSchema = z.object({
  tabId: z.string(),
  url: z.string().default(""),
  title: z.string().default(""),
  active: z.boolean().default(false),
  /** 页面自己 `window.open` 出来的标签带开启者，界面据此显示成弹窗。 */
  openerTabId: z.string().default(""),
  navigationEpoch: z.number().int().nonnegative().default(0),
  loading: z.boolean().default(false),
  pendingDialog: browserDialogSchema.optional(),
  /**
   * 标签图标，`data:` URL，由受控浏览器自己取好再送上来。
   *
   * 不给 URL 让界面自己去拉：那会让每个画标签条的客户端用**自己**的浏览器
   * 和 cookie 去访问那个站点，而正在访问它的是受控会话。取不到或超过上限
   * 时是空串，界面退回首字母（§2.8）。
   */
  favicon: z.string().default(""),
});

export const browserTabListSchema = z.object({
  tabs: z.array(browserTabSchema).default([]),
  activeTabId: z.string().default(""),
  limit: z.number().int().positive().default(BROWSER_TAB_LIMIT),
});

export const BROWSER_TAB_ACTIONS = ["list", "switch", "new"] as const;
export const browserTabRequestSchema = z.object({
  action: z.enum(BROWSER_TAB_ACTIONS),
  tabId: z.string().optional(),
  url: z.string().optional(),
  leaseGeneration: z.number().int().nonnegative().optional(),
});

export const browserCloseTabRequestSchema = z.object({
  tabId: z.string(),
  leaseGeneration: z.number().int().nonnegative().optional(),
});

/* ------------------------------ 控制租约（§2.6） ----------------------------- */

/**
 * 租约的形状在 `drive.ts`：终端节点用的是同一份（设计 `agent-delivery.md`
 * §6.2）。这里只把它按浏览器这一域原来的名字转出去，所以已有的导入路径与
 * 类型名一个字都不用改，而定义只有一份。
 */
export const BROWSER_LEASE_STATES = DRIVE_LEASE_STATES;
export const browserLeaseSchema = driveLeaseSchema;

export const BROWSER_LEASE_ACTIONS = ["status", "takeover", "release"] as const;
export const browserLeaseRequestSchema = z.object({
  action: z.enum(BROWSER_LEASE_ACTIONS),
  leaseGeneration: z.number().int().nonnegative().optional(),
  /** 谁在接管或交还：这一端的不透明标识，不授予任何权限。 */
  deviceId: z.string().optional(),
  displayName: z.string().optional(),
});

/* ------------------------------- 新动词（§2.7） ------------------------------ */

export const browserSelectRequestSchema = z.object({
  navigationEpoch: z.number().int().nonnegative().optional(),
  selector: z.string().optional(),
  elementRef: z.string().optional(),
  values: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  target: browserTargetSchema.optional(),
  leaseGeneration: z.number().int().nonnegative().optional(),
});

export const browserPressRequestSchema = z.object({
  navigationEpoch: z.number().int().nonnegative().optional(),
  key: z.string(),
  modifiers: z.number().int().nonnegative().default(0),
  repeat: z.number().int().nonnegative().default(0),
  target: browserTargetSchema.optional(),
  leaseGeneration: z.number().int().nonnegative().optional(),
});

export const BROWSER_SCROLL_DIRECTIONS = [
  "up",
  "down",
  "left",
  "right",
] as const;
export const browserScrollRequestSchema = z.object({
  navigationEpoch: z.number().int().nonnegative().optional(),
  direction: z.enum(BROWSER_SCROLL_DIRECTIONS).optional(),
  amount: z.number().optional(),
  elementRef: z.string().optional(),
  target: browserTargetSchema.optional(),
  leaseGeneration: z.number().int().nonnegative().optional(),
});

/** `paths` 只接受工作空间相对路径；绝对路径与逃逸出根目录的路径都被拒。 */
export const browserUploadRequestSchema = z.object({
  chooserId: z.string().optional(),
  selector: z.string().optional(),
  elementRef: z.string().optional(),
  paths: z.array(z.string()).min(1),
  target: browserTargetSchema.optional(),
  leaseGeneration: z.number().int().nonnegative().optional(),
});

/** `POST …/upload` 的回包：路径原样回来，不会泄漏执行主机的绝对路径。 */
export const browserUploadedSchema = z.object({
  paths: z.array(z.string()).default([]),
  tabId: z.string().default(""),
  /** 真的答复了页面开的选择器，而不是直接往 `input[type=file]` 里填。 */
  answeredChooser: z.boolean().default(false),
});

/* ------------------------------- 活动（§2.8） ------------------------------- */

/** 只保留最近若干条在 session 内存里；持久记录仍是 `board-log.jsonl`。 */
export const browserActivitySchema = z.object({
  sessionId: z.string(),
  actor: z.enum(["human", "agent"]),
  actorId: z.string().default(""),
  verb: z.string(),
  target: z.string().default(""),
  outcome: z.enum(["ok", "refused", "unknown"]),
  reasonCode: z.string().default(""),
  at: z.string(),
});

export const browserActivityListSchema = z.object({
  activity: z.array(browserActivitySchema),
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
  activeTabId: z.string().default(""),
  tabCount: z.number().int().nonnegative().default(0),
  lease: browserLeaseSchema.optional(),
  pendingDialog: browserDialogSchema.optional(),
  pendingFileChooser: browserFileChooserSchema.optional(),
  /** 存库的世代号：Runtime 重启后租约回到 free，但世代继续往上走。 */
  leaseGeneration: z.number().int().nonnegative().default(0),
});

/**
 * 这台机器上到底有没有可用的 Chromium（§5）。`available: false` 时界面
 * 只显示原因与找过的路径，不给任何按不动的按钮。
 */
export const browserAvailabilitySchema = z.object({
  available: z.boolean(),
  executable: z.string(),
  source: z.enum(["settings", "environment", "managed", "detected", "none"]),
  reasonCode: z.string(),
  searched: z.array(z.string()).default([]),
  managed: browserManagedStateSchema.optional(),
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
  target: browserTargetSchema.optional(),
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
  /** 活动标签主 frame 内的引用两者都为空，跨 frame 的引用两者都带。 */
  tabId: z.string().default(""),
  frameId: z.string().default(""),
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
  target: browserTargetSchema.optional(),
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
  tabId: z.string().default(""),
  /** 完成后才算得出来，所以未完成的下载这里是空串。 */
  sha256: z.string().default(""),
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

export type BrowserManagedInstallState =
  (typeof BROWSER_MANAGED_STATES)[number];
export type BrowserManagedState = z.infer<typeof browserManagedStateSchema>;
export type BrowserTarget = z.infer<typeof browserTargetSchema>;
export type BrowserDialogKind = (typeof BROWSER_DIALOG_KINDS)[number];
export type BrowserDialog = z.infer<typeof browserDialogSchema>;
export type BrowserDialogRequest = z.infer<typeof browserDialogRequestSchema>;
export type BrowserFileChooser = z.infer<typeof browserFileChooserSchema>;
export type BrowserTab = z.infer<typeof browserTabSchema>;
export type BrowserTabList = z.infer<typeof browserTabListSchema>;
export type BrowserTabAction = (typeof BROWSER_TAB_ACTIONS)[number];
export type BrowserTabRequest = z.infer<typeof browserTabRequestSchema>;
export type BrowserCloseTabRequest = z.infer<
  typeof browserCloseTabRequestSchema
>;
export type BrowserLeaseState = (typeof BROWSER_LEASE_STATES)[number];
export type BrowserLease = z.infer<typeof browserLeaseSchema>;
export type BrowserLeaseAction = (typeof BROWSER_LEASE_ACTIONS)[number];
export type BrowserLeaseRequest = z.infer<typeof browserLeaseRequestSchema>;
export type BrowserSelectRequest = z.infer<typeof browserSelectRequestSchema>;
export type BrowserPressRequest = z.infer<typeof browserPressRequestSchema>;
export type BrowserScrollDirection = (typeof BROWSER_SCROLL_DIRECTIONS)[number];
export type BrowserScrollRequest = z.infer<typeof browserScrollRequestSchema>;
export type BrowserUploadRequest = z.infer<typeof browserUploadRequestSchema>;
export type BrowserUploaded = z.infer<typeof browserUploadedSchema>;
export type BrowserActivity = z.infer<typeof browserActivitySchema>;
export type BrowserActivityList = z.infer<typeof browserActivityListSchema>;
