import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCanvasDropPoint,
  isTerminalDropTarget,
  isTextEntry,
} from "./os-drop";

/**
 * 拖放与粘贴的守卫（React Flow 计划 F27）。
 *
 * 三个纯判定，三种「不该由画布接管」的目标：侧栏与对话框不是画布，
 * 终端要原样收下拖放与粘贴，输入框里的 ⌘V 是浏览器的事。
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("native file drop destinations", () => {
  it("只认画布，排除侧栏、对话框与终端", () => {
    document.body.innerHTML = `<aside id="sidebar"></aside><div class="canvas-stage"><div id="canvas"></div><div role="dialog" id="dialog"></div><div class="xterm" id="terminal"></div></div>`;
    let target: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });
    for (const id of ["sidebar", "dialog", "terminal"]) {
      target = document.getElementById(id);
      expect(isCanvasDropPoint({ x: 10, y: 10 }), id).toBe(false);
    }
    target = document.getElementById("canvas");
    expect(isCanvasDropPoint({ x: 10, y: 10 })).toBe(true);
  });
});

describe("isTerminalDropTarget", () => {
  it("终端体与 xterm 内部都算终端", () => {
    document.body.innerHTML = `<div data-slot="terminal-body"><span id="inside"></span></div><div class="xterm"><span id="xterm-inside"></span></div><div id="elsewhere"></div>`;
    expect(isTerminalDropTarget(document.getElementById("inside"))).toBe(true);
    expect(isTerminalDropTarget(document.getElementById("xterm-inside"))).toBe(
      true,
    );
    expect(isTerminalDropTarget(document.getElementById("elsewhere"))).toBe(
      false,
    );
    expect(isTerminalDropTarget(null)).toBe(false);
  });
});

describe("isTextEntry", () => {
  it("输入框、textarea、可编辑区与 nodrag 里的粘贴归它们自己", () => {
    document.body.innerHTML = `<input id="input" /><textarea id="textarea"></textarea><select id="select"></select><div id="editable" contenteditable="true"></div><div class="nodrag"><span id="nodrag-inside"></span></div><div id="plain"></div>`;
    for (const id of [
      "input",
      "textarea",
      "select",
      "editable",
      "nodrag-inside",
    ]) {
      expect(isTextEntry(document.getElementById(id)), id).toBe(true);
    }
    expect(isTextEntry(document.getElementById("plain"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
