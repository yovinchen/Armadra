import { afterEach, describe, expect, it } from "vitest";
import { clearSplashShown, markSplashShown, shouldShowSplash } from "./session";

afterEach(() => clearSplashShown());

describe("splash session guard", () => {
  it("plays on the first load of a page session and never again", () => {
    expect(shouldShowSplash(true)).toBe(true);
    markSplashShown();
    // ⌘W / 托盘只是藏窗口，WebView 与它的 sessionStorage 都还在。
    expect(shouldShowSplash(true)).toBe(false);
  });

  it("plays again once the page session is gone", () => {
    markSplashShown();
    // ⌘Q 之后重新打开是新进程新 WebView，标记随之消失。
    clearSplashShown();
    expect(shouldShowSplash(true)).toBe(true);
  });

  it("never plays when the preference is off", () => {
    expect(shouldShowSplash(false)).toBe(false);
    markSplashShown();
    expect(shouldShowSplash(false)).toBe(false);
  });

  it("stores the mark under a stable key", () => {
    markSplashShown();
    expect(sessionStorage.getItem("armadra.splash.shown")).toBe("1");
  });
});
