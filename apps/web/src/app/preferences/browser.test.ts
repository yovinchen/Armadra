import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_BACKGROUND_MAX_RANGE,
  BROWSER_DEFAULT_BACKGROUND_MAX,
  BROWSER_DEFAULT_DISCARD_MINUTES,
  BROWSER_DISCARD_MINUTES_RANGE,
  BROWSER_KEYS,
  storedBrowserPreferences,
} from "./browser";

/**
 * 浏览器节点的内存偏好（复查 §5.2）。
 *
 * 默认值不是唯一要钉的事：越界的值必须被收进范围里，否则一个手改过
 * localStorage 的机器会拿到 0 分钟（每一个 tick 都回收）或者 0 个后台页面。
 */

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});

describe("storedBrowserPreferences", () => {
  it("默认开，5 分钟，8 个后台页面", () => {
    expect(storedBrowserPreferences()).toEqual({
      discard: true,
      discardMinutes: BROWSER_DEFAULT_DISCARD_MINUTES,
      backgroundMax: BROWSER_DEFAULT_BACKGROUND_MAX,
    });
    expect(BROWSER_DEFAULT_DISCARD_MINUTES).toBe(5);
    expect(BROWSER_DEFAULT_BACKGROUND_MAX).toBe(8);
  });

  it("存过的值原样读回来", () => {
    localStorage.setItem(BROWSER_KEYS.discard, "false");
    localStorage.setItem(BROWSER_KEYS.discardMinutes, "12");
    localStorage.setItem(BROWSER_KEYS.backgroundMax, "3");
    expect(storedBrowserPreferences()).toEqual({
      discard: false,
      discardMinutes: 12,
      backgroundMax: 3,
    });
  });

  it("越界与非数字都收进范围", () => {
    localStorage.setItem(BROWSER_KEYS.discardMinutes, "0");
    localStorage.setItem(BROWSER_KEYS.backgroundMax, "999");
    expect(storedBrowserPreferences().discardMinutes).toBe(
      BROWSER_DISCARD_MINUTES_RANGE[0],
    );
    expect(storedBrowserPreferences().backgroundMax).toBe(
      BROWSER_BACKGROUND_MAX_RANGE[1],
    );

    localStorage.setItem(BROWSER_KEYS.discardMinutes, "很久");
    expect(storedBrowserPreferences().discardMinutes).toBe(
      BROWSER_DEFAULT_DISCARD_MINUTES,
    );
  });
});
