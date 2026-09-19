import { beforeEach, describe, expect, it, vi } from "vitest";

import { terminalAppearance } from "@/terminal/surface/appearance";
import {
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
  TERMINAL_KEYS,
  storedTerminalPreferences,
} from "./terminal";

/**
 * 终端默认密度（契约 §3.4，2026-09-19：13/1.2 → 12/1.15）。
 *
 * 关键不只是「默认是 12」，还有「调过的人不被改」：默认值只在
 * localStorage 里一个字都没有时才生效。
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

describe("storedTerminalPreferences", () => {
  it("默认字号 12、行高 1.15", () => {
    const preferences = storedTerminalPreferences();
    expect(preferences.fontSize).toBe(12);
    expect(preferences.lineHeight).toBe(1.15);
    expect(TERMINAL_DEFAULT_FONT_SIZE).toBe(12);
    expect(TERMINAL_DEFAULT_LINE_HEIGHT).toBe(1.15);
  });

  it("已经存过的字号不被新默认值覆盖", () => {
    localStorage.setItem(TERMINAL_KEYS.fontSize, "15");
    localStorage.setItem(TERMINAL_KEYS.lineHeight, "1.4");
    const preferences = storedTerminalPreferences();
    expect(preferences.fontSize).toBe(15);
    expect(preferences.lineHeight).toBe(1.4);
  });

  it("偏好原样落到 xterm 的 options 上", () => {
    const options = terminalAppearance(
      storedTerminalPreferences(),
      document.createElement("div"),
    );
    expect(options.fontSize).toBe(12);
    expect(options.lineHeight).toBe(1.15);
  });
});
