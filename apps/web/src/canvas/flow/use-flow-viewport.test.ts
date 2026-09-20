import { afterEach, describe, expect, it, vi } from "vitest";

import { setFlow, setFlowContainer, type FlowHandle } from "./flow-context";
import {
  REVEAL_RETRY_DELAYS,
  REVEAL_ZOOM_THRESHOLD,
  revealNewNode,
} from "./use-flow-viewport";

/**
 * 新建节点之后的相机（契约 §3.4，2026-09-19）。
 *
 * 节点默认尺寸按 100% 设计，所以在总览缩放下新建必须把相机抬回 100%，
 * 否则用户拿到的是一张读不了的缩略图；但已经在 50% 以上时不许抢相机。
 */

const NODE = {
  id: "n1",
  position: { x: 1000, y: 400 },
  measured: { width: 1280, height: 800 },
  width: 1280,
  height: 800,
  data: {},
};

type SetCenter = (
  x: number,
  y: number,
  options: { zoom: number; duration: number },
) => Promise<boolean>;

/** 只需要 `getBoundingClientRect`：`containerSize()` 只读这一个。 */
function fakeContainer(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as HTMLElement;
}

function mountFlow(zoom: number, node: typeof NODE | null = NODE) {
  const setCenter = vi.fn<SetCenter>(() => Promise.resolve(true));
  const handle = {
    getViewport: () => ({ x: 0, y: 0, zoom }),
    getNode: (id: string) => (node && node.id === id ? node : undefined),
    setCenter,
  } as unknown as FlowHandle;
  setFlow(handle);
  return setCenter;
}

afterEach(() => {
  setFlow(null);
  setFlowContainer(null);
  vi.useRealTimers();
});

describe("revealNewNode", () => {
  it("在 27% 缩放下把相机抬到 100% 并对准节点中心", () => {
    const setCenter = mountFlow(0.27);

    revealNewNode("n1");

    expect(setCenter).toHaveBeenCalledTimes(1);
    const [x, y, options] = setCenter.mock.calls[0]!;
    expect([x, y]).toEqual([1000 + 1280 / 2, 400 + 800 / 2]);
    expect(options.zoom).toBe(1);
  });

  it("缩放已经够大、节点又在眼前时不碰相机", () => {
    const setCenter = mountFlow(REVEAL_ZOOM_THRESHOLD);
    setFlowContainer(fakeContainer(4000, 3000));
    revealNewNode("n1");
    expect(setCenter).not.toHaveBeenCalled();
  });

  /**
   * Agent 用控制动词建的节点摆在发起它的那个节点右边，常常整块在屏幕外，
   * 而缩放本来就是 100%——「只在缩放太小时抬相机」那一条在这里不够用，
   * 所以看不全就按当前缩放居中。
   */
  it("缩放够大但节点在屏幕外时按当前缩放居中", () => {
    const setCenter = mountFlow(1);
    setFlowContainer(fakeContainer(800, 600));
    revealNewNode("n1");
    expect(setCenter).toHaveBeenCalledTimes(1);
    const [x, y, options] = setCenter.mock.calls[0]!;
    expect([x, y]).toEqual([1000 + 1280 / 2, 400 + 800 / 2]);
    expect(options.zoom).toBe(1);
  });

  it("React Flow 还没量过这个节点时相机不动", () => {
    vi.useFakeTimers();
    const setCenter = mountFlow(0.27, null);

    revealNewNode("n1");
    vi.advanceTimersByTime(REVEAL_RETRY_DELAYS.at(-1)! + 1);

    expect(setCenter).not.toHaveBeenCalled();
  });

  it("投影晚一拍落地时由重试补上，且只居中一次", () => {
    vi.useFakeTimers();
    let node: typeof NODE | null = null;
    const setCenter = vi.fn<SetCenter>(() => Promise.resolve(true));
    setFlow({
      getViewport: () => ({ x: 0, y: 0, zoom: 0.27 }),
      getNode: (id: string) => (node && node.id === id ? node : undefined),
      setCenter,
    } as unknown as FlowHandle);

    revealNewNode("n1");
    expect(setCenter).not.toHaveBeenCalled();

    node = NODE;
    vi.advanceTimersByTime(REVEAL_RETRY_DELAYS.at(-1)! + 1);
    expect(setCenter).toHaveBeenCalledTimes(1);
  });

  it("画布没挂载时什么都不做", () => {
    setFlow(null);
    expect(() => revealNewNode("n1")).not.toThrow();
  });
});
