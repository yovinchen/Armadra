import { afterEach, describe, expect, it, vi } from "vitest";
import type { Viewport } from "@armadra/shared";

import { resetCanvasLock, setCanvasLocked } from "../canvas-lock";
import {
  setFlow,
  setFlowContainer,
  type FlowHandle,
} from "../flow/flow-context";
import { MAX_ZOOM, MIN_ZOOM } from "../zoom";
import {
  isZoomWheel,
  viewportAfterWheelZoom,
  zoomCanvasByWheel,
} from "./wheel-zoom";

/**
 * 节点体上的 ⌘/Ctrl + 滚轮缩放（React Flow 计划 §6.3 A01）。
 *
 * 关键在于**与键盘焦点无关**：判定只看事件自己的修饰键，不看 React Flow 的
 * `useKeyPress` 状态——终端拿到焦点时那个状态就是不可靠的。
 */

const AT_ZOOM_1: Viewport = { x: 0, y: 0, zoom: 1 };

function fakeFlow(viewport: Viewport) {
  let current = viewport;
  return {
    handle: {
      getViewport: () => current,
      setViewport: vi.fn((next: Viewport) => {
        current = next;
        return Promise.resolve(true);
      }),
    } as unknown as FlowHandle,
    current: () => current,
  };
}

function mountCanvas(viewport: Viewport, left = 0, top = 0) {
  const flow = fakeFlow(viewport);
  const container = document.createElement("div");
  container.getBoundingClientRect = () =>
    ({ left, top, width: 800, height: 600 }) as DOMRect;
  setFlow(flow.handle);
  setFlowContainer(container);
  return flow;
}

afterEach(() => {
  setFlow(null);
  setFlowContainer(null);
  resetCanvasLock();
});

describe("isZoomWheel", () => {
  it("只有 ⌘ / Ctrl 修饰的滚轮才是缩放手势", () => {
    expect(isZoomWheel({ metaKey: true })).toBe(true);
    expect(isZoomWheel({ ctrlKey: true })).toBe(true);
    expect(isZoomWheel({})).toBe(false);
    expect(isZoomWheel({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});

describe("viewportAfterWheelZoom", () => {
  it("上滚放大、下滚缩小", () => {
    const bigger = viewportAfterWheelZoom(
      AT_ZOOM_1,
      { deltaY: -40, clientX: 0, clientY: 0 },
      { left: 0, top: 0 },
    );
    const smaller = viewportAfterWheelZoom(
      AT_ZOOM_1,
      { deltaY: 40, clientX: 0, clientY: 0 },
      { left: 0, top: 0 },
    );
    expect(bigger.zoom).toBeGreaterThan(1);
    expect(smaller.zoom).toBeLessThan(1);
  });

  it("光标下的那一点不动（容器坐标要减掉容器的左上角）", () => {
    const before = { x: -100, y: -50, zoom: 1 };
    const point = { x: 300, y: 200 };
    const after = viewportAfterWheelZoom(
      before,
      { deltaY: -40, clientX: point.x + 30, clientY: point.y + 20 },
      { left: 30, top: 20 },
    );
    const flowBefore = {
      x: (point.x - before.x) / before.zoom,
      y: (point.y - before.y) / before.zoom,
    };
    const flowAfter = {
      x: (point.x - after.x) / after.zoom,
      y: (point.y - after.y) / after.zoom,
    };
    expect(flowAfter.x).toBeCloseTo(flowBefore.x, 6);
    expect(flowAfter.y).toBeCloseTo(flowBefore.y, 6);
  });

  it("夹在 [0.1, 3] 之内", () => {
    let viewport = { x: 0, y: 0, zoom: MAX_ZOOM };
    for (let index = 0; index < 20; index += 1) {
      viewport = viewportAfterWheelZoom(
        viewport,
        { deltaY: -100, clientX: 0, clientY: 0 },
        { left: 0, top: 0 },
      );
    }
    expect(viewport.zoom).toBe(MAX_ZOOM);

    viewport = { x: 0, y: 0, zoom: MIN_ZOOM };
    for (let index = 0; index < 20; index += 1) {
      viewport = viewportAfterWheelZoom(
        viewport,
        { deltaY: 100, clientX: 0, clientY: 0 },
        { left: 0, top: 0 },
      );
    }
    expect(viewport.zoom).toBe(MIN_ZOOM);
  });
});

describe("zoomCanvasByWheel", () => {
  it("写回视口，倍率与纯函数算的一致", () => {
    const flow = mountCanvas(AT_ZOOM_1);
    expect(zoomCanvasByWheel({ deltaY: -40, clientX: 100, clientY: 100 })).toBe(
      true,
    );
    expect(flow.current()).toEqual(
      viewportAfterWheelZoom(
        AT_ZOOM_1,
        { deltaY: -40, clientX: 100, clientY: 100 },
        { left: 0, top: 0 },
      ),
    );
  });

  it("锁定视图时什么都不做——锁的就是相机", () => {
    const flow = mountCanvas(AT_ZOOM_1);
    setCanvasLocked(true);
    expect(zoomCanvasByWheel({ deltaY: -40, clientX: 100, clientY: 100 })).toBe(
      false,
    );
    expect(flow.current()).toEqual(AT_ZOOM_1);
  });

  it("画布没挂载时什么都不做（启动页、单测）", () => {
    expect(zoomCanvasByWheel({ deltaY: -40, clientX: 100, clientY: 100 })).toBe(
      false,
    );
  });
});
