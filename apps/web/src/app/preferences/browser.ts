import { storedBoolean, storedNumber } from "./storage";

const BROWSER_DISCARD_KEY = "armadra.browser.discard";
const BROWSER_DISCARD_MINUTES_KEY = "armadra.browser.discardMinutes";
const BROWSER_BACKGROUND_MAX_KEY = "armadra.browser.backgroundMax";

/**
 * 浏览器节点的内存偏好（electron-migration.md §4.1「guest 生命周期」行）。
 *
 * 一个 guest 就是一个 Chromium 渲染进程，所以这三项定的都是同一件事：这台
 * 机器愿意为看不见的页面留多少内存。它们不进 Runtime 设置——8 个后台 guest
 * 在 64 GB 的台式机上无关痛痒，在 8 GB 的笔记本上是另一回事，答案属于机器
 * 而不是账号。
 */
export interface BrowserPreferences {
  /** 隐藏回收的总开关。默认开：不开的话后台标签会一直占着进程。 */
  discard: boolean;
  /** 隐藏多久算「不会马上回来」。 */
  discardMinutes: number;
  /** 后台（ghost）guest 的上限。超过就逐出最久退休的那个。 */
  backgroundMax: number;
}

/** 分钟数的上下界。1 分钟已经很急，60 分钟之后留着也没什么意义。 */
export const BROWSER_DISCARD_MINUTES_RANGE = [1, 60] as const;
/** 后台上限：至少留两个才谈得上「切走再切回来」，16 个已经是十几个进程。 */
export const BROWSER_BACKGROUND_MAX_RANGE = [2, 16] as const;

export const BROWSER_DEFAULT_DISCARD_MINUTES = 5;
export const BROWSER_DEFAULT_BACKGROUND_MAX = 8;

export const BROWSER_KEYS: Record<keyof BrowserPreferences, string> = {
  discard: BROWSER_DISCARD_KEY,
  discardMinutes: BROWSER_DISCARD_MINUTES_KEY,
  backgroundMax: BROWSER_BACKGROUND_MAX_KEY,
};

export function storedBrowserPreferences(): BrowserPreferences {
  return {
    discard: storedBoolean(BROWSER_DISCARD_KEY, true),
    discardMinutes: storedNumber(
      BROWSER_DISCARD_MINUTES_KEY,
      BROWSER_DEFAULT_DISCARD_MINUTES,
      BROWSER_DISCARD_MINUTES_RANGE[0],
      BROWSER_DISCARD_MINUTES_RANGE[1],
    ),
    backgroundMax: storedNumber(
      BROWSER_BACKGROUND_MAX_KEY,
      BROWSER_DEFAULT_BACKGROUND_MAX,
      BROWSER_BACKGROUND_MAX_RANGE[0],
      BROWSER_BACKGROUND_MAX_RANGE[1],
    ),
  };
}
