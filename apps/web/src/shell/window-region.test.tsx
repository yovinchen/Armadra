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

/** 壳的判定只看 `window.armadra` 在不在。 */
function inShell(): void {
  (window as { armadra?: unknown }).armadra = {};
  desktop.mockReturnValue(true);
}

describe("dragRegionProps", () => {
  it("壳里挂 -webkit-app-region", () => {
    inShell();
    expect(dragRegionProps()).toEqual({ "data-app-region": "drag" });
  });

  it("浏览器里什么也不挂", () => {
    expect(dragRegionProps()).toEqual({});
  });

  it("桥不在时什么也不挂，哪怕 isDesktop() 说是桌面", () => {
    // 判定的依据是桥本身，不是别的模块的看法：没有桥就没有壳能接住这块拖拽区。
    desktop.mockReturnValue(true);
    expect(dragRegionProps()).toEqual({});
    expect(noDragProps()).toEqual({});
  });

  it("noDragProps 在浏览器里是空的", () => {
    expect(noDragProps()).toEqual({});
  });

  it("noDragProps 在壳里必须有东西：app-region 会往下继承", () => {
    inShell();
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

  it("壳里是一条铺满顶端、带拖拽属性的空元素", () => {
    inShell();
    render(<WindowDragLayer />);
    const layer = screen.getByTestId("window-drag-layer");
    expect(layer.getAttribute("data-app-region")).toBe("drag");
    // app-region 会往下继承，所以里面不能有任何子节点。
    expect(layer.childNodes.length).toBe(0);
    expect(layer.className).toContain("h-[var(--tabbar-h)]");
    expect(layer.className).toContain("top-0");
  });
});
