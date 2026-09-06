import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flow = {
  screenToFlowPosition: (point: { x: number; y: number }) => ({
    x: point.x * 2,
    y: point.y * 2,
  }),
};

const handle = { current: flow as unknown, size: { width: 800, height: 600 } };

vi.mock("../flow/flow-context", () => ({
  getFlow: () => handle.current,
  containerSize: () => handle.size,
  screenToPage: (point: { x: number; y: number }) =>
    handle.current
      ? (handle.current as typeof flow).screenToFlowPosition(point)
      : point,
}));

const {
  forgetPointer,
  lastPointerScreen,
  pastePoint,
  rememberPointer,
  trackPointer,
  viewportCentre,
} = await import("./pointer");

/**
 * 粘贴落点（React Flow 计划 §2.8）。
 *
 * 粘贴事件没有坐标，所以落点只能靠记住鼠标最后停在哪；偏好关着或者
 * 用户从来没动过鼠标（键盘操作、触屏）时退回视口中心。
 */

beforeEach(() => {
  forgetPointer();
  handle.current = flow;
  handle.size = { width: 800, height: 600 };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pastePoint", () => {
  it("偏好开着且知道指针位置时落在指针上", () => {
    rememberPointer({ x: 30, y: 40 });
    expect(pastePoint(true)).toEqual({ x: 60, y: 80 });
  });

  it("偏好关着时一律落在视口中心", () => {
    rememberPointer({ x: 30, y: 40 });
    expect(pastePoint(false)).toEqual({ x: 800, y: 600 });
  });

  it("从来没动过鼠标时也落在视口中心", () => {
    expect(lastPointerScreen()).toBeNull();
    expect(pastePoint(true)).toEqual({ x: 800, y: 600 });
  });

  it("画布没挂载时回原点，不抛异常", () => {
    handle.current = null;
    expect(viewportCentre()).toEqual({ x: 0, y: 0 });
    expect(pastePoint(true)).toEqual({ x: 0, y: 0 });
  });

  it("容器还没量到尺寸时也回原点", () => {
    handle.size = { width: 0, height: 0 };
    expect(viewportCentre()).toEqual({ x: 0, y: 0 });
  });
});

describe("trackPointer", () => {
  it("装上之后记录每一次移动，摘掉之后忘掉位置", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const stop = trackPointer(container);
    container.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 12, clientY: 34 }),
    );
    expect(lastPointerScreen()).toEqual({ x: 12, y: 34 });
    stop();
    container.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 99, clientY: 99 }),
    );
    expect(lastPointerScreen()).toBeNull();
  });
});
