import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { usePreferencesStore } from "../app/preferences-store";
import { Splash, REDUCED_HOLD_MS, SKIP_AFTER_MS } from "./Splash";
import { mountSplash } from "./mount";
import { clearSplashShown } from "./session";
import { SPLASH_DURATION_MS } from "./timeline";

/**
 * 覆盖层的行为：按什么挑主题、什么时候能跳过、减少动态时怎么办，
 * 以及「同一个页面会话只放一次」那道闸。帧的数学在 `timeline.test.ts`。
 */

const DARK_QUERY = "(prefers-color-scheme: dark)";
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

const media = { dark: false, reduce: false };
const listeners = new Map<string, Set<() => void>>();

function installMatchMedia() {
  listeners.clear();
  window.matchMedia = ((query: string) => {
    const subscribers = listeners.get(query) ?? new Set<() => void>();
    listeners.set(query, subscribers);
    return {
      get matches() {
        if (query === DARK_QUERY) return media.dark;
        if (query === REDUCE_QUERY) return media.reduce;
        return false;
      },
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_type: string, handler: () => void) =>
        subscribers.add(handler),
      removeEventListener: (_type: string, handler: () => void) =>
        subscribers.delete(handler),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/** 换系统设置并通知监听者，模拟用户在系统里切了外观。 */
function changeSystem(patch: Partial<typeof media>) {
  Object.assign(media, patch);
  act(() => {
    for (const [query, subscribers] of listeners) {
      if (query === DARK_QUERY && patch.dark !== undefined) {
        for (const handler of subscribers) handler();
      }
      if (query === REDUCE_QUERY && patch.reduce !== undefined) {
        for (const handler of subscribers) handler();
      }
    }
  });
}

function overlay(): HTMLElement | null {
  return document.querySelector(".splash");
}

beforeEach(() => {
  media.dark = false;
  media.reduce = false;
  installMatchMedia();
  clearSplashShown();
  usePreferencesStore.setState({
    theme: "system",
    systemTheme: "light",
    splashAnimation: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.getElementById("splash-root")?.remove();
});

describe("Splash theme", () => {
  it("follows the system scheme while the preference is `system`", () => {
    media.dark = true;
    render(<Splash onDismiss={() => undefined} />);
    expect(overlay()?.dataset.splashTheme).toBe("dark");
  });

  it("obeys an explicit light choice on a dark system", () => {
    media.dark = true;
    usePreferencesStore.setState({ theme: "light" });
    render(<Splash onDismiss={() => undefined} />);
    expect(overlay()?.dataset.splashTheme).toBe("light");
  });

  it("obeys an explicit dark choice on a light system", () => {
    usePreferencesStore.setState({ theme: "dark" });
    render(<Splash onDismiss={() => undefined} />);
    expect(overlay()?.dataset.splashTheme).toBe("dark");
  });

  it("switches mid-playback when the system scheme changes", () => {
    render(<Splash onDismiss={() => undefined} />);
    expect(overlay()?.dataset.splashTheme).toBe("light");
    changeSystem({ dark: true });
    expect(overlay()?.dataset.splashTheme).toBe("dark");
  });

  it("ignores a system change once the user picked a side", () => {
    usePreferencesStore.setState({ theme: "light" });
    render(<Splash onDismiss={() => undefined} />);
    changeSystem({ dark: true });
    expect(overlay()?.dataset.splashTheme).toBe("light");
  });
});

describe("Splash playback", () => {
  it("starts on the first frame with the brand mark still hidden", () => {
    render(<Splash onDismiss={() => undefined} />);
    expect(
      document.getElementById("splash-logo")?.getAttribute("opacity"),
    ).toBe("0");
  });

  it("shows only the final frame under reduced motion, then leaves", () => {
    vi.useFakeTimers();
    media.reduce = true;
    const onDismiss = vi.fn();
    render(<Splash onDismiss={onDismiss} />);
    // 终态：品牌标识已经完全显形，犰狳退场。
    expect(
      document.getElementById("splash-logo")?.getAttribute("opacity"),
    ).toBe("1");
    expect(
      document.getElementById("splash-walker")?.getAttribute("opacity"),
    ).toBe("0");
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(REDUCED_HOLD_MS));
    expect(overlay()?.dataset.splashState).toBe("leaving");
    // 淡出的定时器要等 React 处理完那次 setState 才排上队，所以分两次推进。
    act(() => void vi.advanceTimersByTime(400));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("drops to the final frame when reduced motion turns on mid-play", () => {
    render(<Splash onDismiss={() => undefined} />);
    expect(
      document.getElementById("splash-logo")?.getAttribute("opacity"),
    ).toBe("0");
    changeSystem({ reduce: true });
    expect(
      document.getElementById("splash-logo")?.getAttribute("opacity"),
    ).toBe("1");
  });
});

describe("Splash skip", () => {
  it("ignores a click or key press during the first second", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Splash onDismiss={onDismiss} />);
    act(() => void vi.advanceTimersByTime(SKIP_AFTER_MS - 50));
    act(() => {
      overlay()?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(overlay()?.dataset.splashState).toBe("playing");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("leaves on a key press once the first second is over", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Splash onDismiss={onDismiss} />);
    act(() => void vi.advanceTimersByTime(SKIP_AFTER_MS + 10));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(overlay()?.dataset.splashState).toBe("leaving");
    act(() => void vi.advanceTimersByTime(400));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves on a click once the first second is over", () => {
    vi.useFakeTimers();
    render(<Splash onDismiss={() => undefined} />);
    act(() => void vi.advanceTimersByTime(SKIP_AFTER_MS + 10));
    act(() => {
      overlay()?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(overlay()?.dataset.splashState).toBe("leaving");
  });

  it("runs for four seconds when nobody skips", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Splash onDismiss={onDismiss} />);
    // rAF 也被假计时器接管，所以推进时间就等于推进帧。
    act(() => void vi.advanceTimersByTime(SPLASH_DURATION_MS - 500));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(overlay()?.dataset.splashState).toBe("playing");
    act(() => void vi.advanceTimersByTime(600));
    expect(overlay()?.dataset.splashState).toBe("leaving");
    act(() => void vi.advanceTimersByTime(400));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("mountSplash", () => {
  it("mounts once per page session", () => {
    act(() => mountSplash());
    expect(overlay()).not.toBeNull();
    document.getElementById("splash-root")?.remove();

    // 第二次加载同一个页面会话（热重载 / 刷新）不再放。
    act(() => mountSplash());
    expect(overlay()).toBeNull();
  });

  it("mounts again after the page session is cleared", () => {
    act(() => mountSplash());
    document.getElementById("splash-root")?.remove();
    clearSplashShown();
    act(() => mountSplash());
    expect(overlay()).not.toBeNull();
  });

  it("stays out of the way when the preference is off", () => {
    usePreferencesStore.setState({ splashAnimation: false });
    act(() => mountSplash());
    expect(overlay()).toBeNull();
    expect(document.getElementById("splash-root")).toBeNull();
  });
});
