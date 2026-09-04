import { afterEach, describe, expect, it, vi } from "vitest";
import { isCanvasDropPoint } from "./os-drop";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("native file drop destinations", () => {
  it("accepts only the canvas and excludes sidebar, dialogs and terminal inputs", () => {
    document.body.innerHTML = `<aside id="sidebar"></aside><div class="canvas-stage"><div id="canvas"></div><div role="dialog" id="dialog"></div><div class="xterm" id="terminal"></div></div>`;
    let target: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
    for (const id of ["sidebar", "dialog", "terminal"]) {
      target = document.getElementById(id);
      expect(isCanvasDropPoint({ x: 10, y: 10 })).toBe(false);
    }
    target = document.getElementById("canvas");
    expect(isCanvasDropPoint({ x: 10, y: 10 })).toBe(true);
  });
});
