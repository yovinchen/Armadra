import { describe, expect, it } from "vitest";
import { parseChoice, selectBackend } from "./select";

/**
 * The selection tree of contract §15.1, all of it, on a machine that has none
 * of the three backends.
 *
 * That is the point of testing it here: the Windows branch is otherwise
 * unreachable from this repository's CI, and it is the branch with the rule
 * everybody gets backwards — `auto` on Windows is the session host, never
 * tmux.
 */

const usable = { usable: true, version: "3.4" } as const;
const missing = {
  usable: false,
  reason: "tmux was not found on PATH",
} as const;
const old = {
  usable: false,
  version: "3.0",
  reason: "tmux 3.0 is older than 3.2",
} as const;

describe("the backend selection tree", () => {
  it("prefers tmux on unix when it is usable", () => {
    expect(
      selectBackend({
        configured: "auto",
        detection: usable,
        platform: "darwin",
      }),
    ).toEqual({ effective: "tmux", configured: "auto" });
  });

  it("falls back to direct on unix, carrying the reason tmux gave", () => {
    const selection = selectBackend({
      configured: "auto",
      detection: missing,
      platform: "linux",
    });
    expect(selection.effective).toBe("direct");
    expect(selection.reason).toBe("tmux was not found on PATH");
  });

  it("treats a tmux that is too old exactly as a tmux that is absent", () => {
    expect(
      selectBackend({ configured: "auto", detection: old, platform: "darwin" })
        .effective,
    ).toBe("direct");
  });

  /**
   * tmux on Windows is an MSYS compatibility layer between Win32 CLIs and a
   * Unix pty. A machine with it installed must still get the native backend
   * unless somebody asked for the other one by name.
   */
  it("never means tmux when `auto` is read on Windows", () => {
    expect(
      selectBackend({
        configured: "auto",
        detection: usable,
        platform: "win32",
      }),
    ).toEqual({ effective: "sessionHost", configured: "auto" });
  });

  it("still honours an explicit tmux on Windows", () => {
    expect(
      selectBackend({
        configured: "tmux",
        detection: usable,
        platform: "win32",
      }).effective,
    ).toBe("tmux");
  });

  it("falls back from an explicit tmux to the platform's own answer", () => {
    expect(
      selectBackend({
        configured: "tmux",
        detection: missing,
        platform: "win32",
      }).effective,
    ).toBe("sessionHost");
    expect(
      selectBackend({
        configured: "tmux",
        detection: missing,
        platform: "darwin",
      }).effective,
    ).toBe("direct");
  });

  /**
   * `direct` is the one answer that is never overridden: a person who asked
   * for sessions that die with the app gets exactly that, and is told why the
   * effective backend is not the default.
   */
  it("honours `direct` on every platform and says so", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const selection = selectBackend({
        configured: "direct",
        detection: usable,
        platform,
      });
      expect(selection.effective).toBe("direct");
      expect(selection.reason).toBe("terminal.backend 设为 direct");
    }
  });

  it("refuses to promise a session host on a platform that has none", () => {
    const selection = selectBackend({
      configured: "sessionHost",
      detection: usable,
      platform: "darwin",
    });
    expect(selection.effective).toBe("tmux");
    expect(selection.reason).toBe("这个平台没有会话宿主");
  });

  it("reads an unknown preference as `auto` rather than refusing to start", () => {
    expect(parseChoice("screen")).toBe("auto");
    expect(parseChoice("sessionHost")).toBe("sessionHost");
  });
});
