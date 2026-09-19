import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const desktop = vi.fn(() => false);

vi.mock("../platform", () => ({
  isDesktop: () => desktop(),
}));

import { installDomPolyfills } from "../app/test-harness";
import { WindowDragLayer } from "./WindowDragLayer";
import {
  dragRegionProps,
  noDragProps,
  trafficLightInset,
} from "./window-region";

installDomPolyfills();
afterEach(() => {
  cleanup();
  delete (window as { armadra?: unknown }).armadra;
});
beforeEach(() => desktop.mockReturnValue(false));

/** Electron 壳的判定只看 `window.armadra` 在不在。 */
function inElectron(): void {
  (window as { armadra?: unknown }).armadra = {};
  desktop.mockReturnValue(true);
}

describe("dragRegionProps", () => {
  it("Tauri 里挂 data-tauri-drag-region", () => {
    desktop.mockReturnValue(true);
    expect(dragRegionProps()).toEqual({ "data-tauri-drag-region": true });
  });

  it("Electron 里改用 -webkit-app-region，不挂 Tauri 的属性", () => {
    inElectron();
    const props = dragRegionProps();
    expect(props["data-app-region"]).toBe("drag");
    // WKWebView 不认 app-region，Tauri 注入的脚本也不认 style——两边不能混。
    expect(props["data-tauri-drag-region"]).toBeUndefined();
  });

  it("浏览器里什么也不挂", () => {
    expect(dragRegionProps()).toEqual({});
  });

  it("noDragProps 在 Tauri 与浏览器里是空的：那边是逐元素 opt-in", () => {
    desktop.mockReturnValue(true);
    expect(noDragProps()).toEqual({});
    desktop.mockReturnValue(false);
    expect(noDragProps()).toEqual({});
  });

  it("noDragProps 在 Electron 里必须有东西：app-region 会往下继承", () => {
    inElectron();
    // 不写回 no-drag 的话，拖拽区里的按钮按下去就是拖窗口。
    expect(noDragProps()).toEqual({ "data-app-region": "no-drag" });
  });

  it("红绿灯占位只在桌面壳里有", () => {
    expect(trafficLightInset()).toBe(0);
  });
});

describe("WindowDragLayer", () => {
  it("浏览器里不渲染", () => {
    render(<WindowDragLayer />);
    expect(screen.queryByTestId("window-drag-layer")).toBeNull();
  });

  it("Tauri 里是一条铺满顶端、带拖拽属性的空元素", () => {
    desktop.mockReturnValue(true);
    render(<WindowDragLayer />);
    const layer = screen.getByTestId("window-drag-layer");
    expect(layer.getAttribute("data-tauri-drag-region")).toBe("true");
    // 属性只对元素自己生效，所以里面不能有任何子节点
    expect(layer.childNodes.length).toBe(0);
    expect(layer.className).toContain("h-[var(--tabbar-h)]");
    expect(layer.className).toContain("top-0");
  });

  it("Electron 里是同一条，只是换成了 app-region", () => {
    inElectron();
    render(<WindowDragLayer />);
    const layer = screen.getByTestId("window-drag-layer");
    expect(layer.getAttribute("data-app-region")).toBe("drag");
    expect(layer.getAttribute("data-tauri-drag-region")).toBeNull();
    // app-region 会继承，这里同样一个子节点都不能有。
    expect(layer.childNodes.length).toBe(0);
  });
});
