import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_RENDERER_URL,
  closeAction,
  rendererTarget,
  shouldHideOnClose,
} from "./window-rules";

describe("closing the window", () => {
  it("hides on macOS and really closes everywhere else", () => {
    expect(shouldHideOnClose("darwin", false)).toBe(true);
    expect(shouldHideOnClose("win32", false)).toBe(false);
    expect(shouldHideOnClose("linux", false)).toBe(false);
  });

  it("stops meaning hide once the quit sequence has started", () => {
    expect(shouldHideOnClose("darwin", true)).toBe(false);
    expect(closeAction("darwin", true, false)).toBe("default");
    expect(closeAction("darwin", true, true)).toBe("default");
  });

  it("leaves fullscreen before hiding, so no empty Space is stranded", () => {
    expect(closeAction("darwin", false, false)).toBe("hide");
    expect(closeAction("darwin", false, true)).toBe(
      "leave-fullscreen-then-hide",
    );
    // Other platforms never intercept, fullscreen or not.
    expect(closeAction("linux", false, true)).toBe("default");
  });
});

describe("where the renderer comes from", () => {
  it("uses apps/web's dev server while developing", () => {
    expect(
      rendererTarget("http://127.0.0.1:5173", false, "/out/index.html"),
    ).toEqual({
      kind: "url",
      url: "http://127.0.0.1:5173",
    });
    // electron-vite did not start one: apps/web's own pinned port.
    expect(rendererTarget(undefined, false, "/out/index.html")).toEqual({
      kind: "url",
      url: DEFAULT_DEV_RENDERER_URL,
    });
    expect(rendererTarget("", false, "/out/index.html")).toEqual({
      kind: "url",
      url: DEFAULT_DEV_RENDERER_URL,
    });
  });

  it("uses apps/web's build output once packaged, never a dev server", () => {
    expect(
      rendererTarget("http://127.0.0.1:1420", true, "/out/index.html"),
    ).toEqual({
      kind: "file",
      path: "/out/index.html",
    });
  });
});
