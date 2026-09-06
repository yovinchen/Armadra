import { afterEach, describe, expect, it } from "vitest";

import { registerEscapeToSelect } from "./escape-to-select";
import { getTool, resetToolStore, setTool } from "./interaction/tool-store";

/**
 * `Esc` 回到选择工具（React Flow 计划 F14）。
 *
 * 这条键不进 `keybindings.ts`（`Esc` 也是所有对话框的关闭键），所以它的
 * 三条免打扰规则是唯一的防线，逐条钉住。
 */

let dispose: (() => void) | null = null;
let container: HTMLElement | null = null;

function mount(): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  dispose = registerEscapeToSelect({ container });
  return container;
}

function escape(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

afterEach(() => {
  dispose?.();
  dispose = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  resetToolStore();
});

describe("registerEscapeToSelect", () => {
  it("没有焦点时也算给画布的：换回选择工具", () => {
    mount();
    setTool("draw");
    escape();
    expect(getTool()).toBe("select");
  });

  it("焦点在画布里同样生效", () => {
    const host = mount();
    const button = document.createElement("button");
    host.append(button);
    button.focus();
    setTool("geo");
    escape();
    expect(getTool()).toBe("select");
  });

  it("焦点在画布外（对话框把焦点关进去了）时什么都不做", () => {
    mount();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    setTool("draw");
    escape();
    expect(getTool()).toBe("draw");
  });

  it("节点体里正在打字时不抢：那一下 Esc 归输入框", () => {
    const host = mount();
    const input = document.createElement("input");
    host.append(input);
    input.focus();
    setTool("text");
    escape();
    expect(getTool()).toBe("text");
  });

  it("Radix 菜单开着时先关菜单，不换工具", () => {
    mount();
    const popper = document.createElement("div");
    popper.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.append(popper);
    setTool("draw");
    escape();
    expect(getTool()).toBe("draw");
  });

  it("注销之后不再响应", () => {
    mount();
    dispose?.();
    dispose = null;
    setTool("draw");
    escape();
    expect(getTool()).toBe("draw");
  });
});
