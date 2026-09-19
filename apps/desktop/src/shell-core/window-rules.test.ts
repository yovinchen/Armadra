import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_RENDERER_URL,
  closeAction,
  pageSourceTarget,
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

describe("where the page comes from", () => {
  it("uses apps/web's dev server while developing", () => {
    expect(pageSourceTarget("http://127.0.0.1:5173", false, "/out")).toEqual({
      kind: "devServer",
      url: "http://127.0.0.1:5173",
    });
    // electron-vite did not start one, but somebody else did: apps/web's own
    // pinned port (`ARMADRA_DESKTOP_EXTERNAL_RENDERER=1`).
    expect(pageSourceTarget(undefined, false, "/out", true)).toEqual({
      kind: "devServer",
      url: DEFAULT_DEV_RENDERER_URL,
    });
    expect(pageSourceTarget("", false, "/out", true)).toEqual({
      kind: "devServer",
      url: DEFAULT_DEV_RENDERER_URL,
    });
  });

  it("serves a build output nobody is hosting, packaged or not", () => {
    // `electron-vite preview` runs the real static path without a bundle,
    // which is the only way that path gets exercised before packaging.
    expect(pageSourceTarget(undefined, false, "/out")).toEqual({
      kind: "static",
      root: "/out",
    });
  });

  it("serves apps/web's build output itself once packaged, never a dev server", () => {
    expect(pageSourceTarget("http://127.0.0.1:1420", true, "/out")).toEqual({
      kind: "static",
      root: "/out",
    });
  });

  it("never yields a file: page, whose origin nothing can be granted to", () => {
    // The whole reason the packaged shell runs a server at all (§2.1): a
    // `file:` page has an opaque origin, so the Runtime could not allow it and
    // the Host could not name it in --allow-origin.
    for (const target of [
      pageSourceTarget(undefined, true, "/out"),
      pageSourceTarget(undefined, false, "/out"),
    ]) {
      expect(JSON.stringify(target)).not.toContain("file:");
    }
  });
});
