import type { BrowserBandwidthClass } from "@armadra/shared";

/** 页面 viewport 的边界；节点可以拖得更小，页面不跟着缩到没法用。 */
export const VIEWPORT_MIN = 200;
export const VIEWPORT_MAX = 4000;
/** 拖动过程中每一帧都改 viewport 会让页面不停 reflow，所以攒一下再发。 */
export const VIEWPORT_DEBOUNCE_MS = 200;

/** 输入合批窗口：一次拖动里的 move 事件合成一条请求。 */
export const INPUT_FLUSH_MS = 8;
/** 与 `browserInputRequestSchema` 的上限一致。 */
export const MAX_INPUT_BATCH = 64;

/** 订阅续约：提前量与失败重试间隔。 */
const RENEW_MARGIN_MS = 5_000;
const RENEW_MIN_MS = 1_000;
const RENEW_MAX_MS = 60_000;
export const RENEW_RETRY_MS = 15_000;

/** 只有历史是本地状态：v3 的 browser 数据只存当前 URL。 */
export const MAX_HISTORY = 50;

/** 有本地化文案的不可用原因；其余一律走 `unknown` 那条，不显示裸 code。 */
const KNOWN_REASONS = ["chrome_not_found", "launch_failed", "cdp_closed"];

export function unavailableKey(reasonCode: string): string {
  return KNOWN_REASONS.includes(reasonCode)
    ? `browser.unavailable.${reasonCode}`
    : "browser.unavailable.unknown";
}

export function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `https://${value}`;
}

/** 节点尺寸 → 页面 viewport：取整并夹在可用范围内。 */
export function clampViewport(value: number): number {
  if (!Number.isFinite(value)) return VIEWPORT_MIN;
  return Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Math.round(value)));
}

/** 续约时机：过期前 5 秒，夹在 1s–60s；时间戳读不出来就按 30s 重试。 */
export function renewDelay(expiresAt: string, now = Date.now()): number {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return 30_000;
  return Math.min(
    RENEW_MAX_MS,
    Math.max(RENEW_MIN_MS, at - now - RENEW_MARGIN_MS),
  );
}

/**
 * 显示框坐标 → CSS viewport 坐标（设计 §8）。
 *
 * canvas 的位图尺寸就是页面 viewport，CSS 尺寸是画布上被缩放后的样子，
 * 所以除以两者的比即可；画布缩放永远不写进页面 viewport。
 */
export function surfacePoint(
  rect: { left: number; top: number; width: number; height: number },
  bitmap: { width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const scaleX = rect.width > 0 ? bitmap.width / rect.width : 1;
  const scaleY = rect.height > 0 ? bitmap.height / rect.height : 1;
  return {
    x: Math.round((clientX - rect.left) * scaleX),
    y: Math.round((clientY - rect.top) * scaleY),
  };
}

/**
 * 这一端到 Runtime 的链路属于哪一档（设计 §2.9）。
 *
 * 客户端只说自己付得起什么，预算由 Runtime 决定并在订阅回执里如实报告——
 * 所以这里猜错也只是拿到一份更保守或更宽的预算，不会两边对不上。
 *
 * - 用户在系统里开了「省流量」就是 `metered`，这是显式意愿，优先级最高；
 * - 页面不在本机回环上（经 Host 代理到手机就是这种）算 `wan`；
 * - 其余是同机或局域网，`lan`。
 */
export function bandwidthClass(
  location: { hostname: string } = globalThis.location ?? { hostname: "" },
  connection: { saveData?: boolean } | undefined = (
    globalThis.navigator as { connection?: { saveData?: boolean } } | undefined
  )?.connection,
): BrowserBandwidthClass {
  if (connection?.saveData === true) return "metered";
  const { hostname } = location;
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "tauri.localhost" ||
    hostname === "";
  return loopback ? "lan" : "wan";
}

/** CDP 的修饰键位（Alt / Ctrl / Meta / Shift）。 */
const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

export function modifierMask(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? MOD_ALT : 0) |
    (event.ctrlKey ? MOD_CTRL : 0) |
    (event.metaKey ? MOD_META : 0) |
    (event.shiftKey ? MOD_SHIFT : 0)
  );
}
