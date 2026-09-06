import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const tauri = vi.fn(() => false);

vi.mock("../platform", () => ({
  isTauri: () => tauri(),
}));

import { installDomPolyfills } from "../app/test-harness";
import { WindowDragLayer } from "./WindowDragLayer";
import {
  dragRegionProps,
  noDragProps,
  trafficLightInset,
} from "./window-region";

installDomPolyfills();
afterEach(cleanup);
beforeEach(() => tauri.mockReturnValue(false));

describe("dragRegionProps", () => {
  it("Tauri 里挂 data-tauri-drag-region", () => {
    tauri.mockReturnValue(true);
    expect(dragRegionProps()).toEqual({ "data-tauri-drag-region": true });
  });

  it("浏览器里什么也不挂", () => {
    expect(dragRegionProps()).toEqual({});
  });

  it("noDragProps 永远是空的：Tauri 是逐元素 opt-in 的", () => {
    tauri.mockReturnValue(true);
    expect(noDragProps()).toEqual({});
    tauri.mockReturnValue(false);
    expect(noDragProps()).toEqual({});
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
    tauri.mockReturnValue(true);
    render(<WindowDragLayer />);
    const layer = screen.getByTestId("window-drag-layer");
    expect(layer.getAttribute("data-tauri-drag-region")).toBe("true");
    // 属性只对元素自己生效，所以里面不能有任何子节点
    expect(layer.childNodes.length).toBe(0);
    expect(layer.className).toContain("h-[var(--tabbar-h)]");
    expect(layer.className).toContain("top-0");
  });
});
