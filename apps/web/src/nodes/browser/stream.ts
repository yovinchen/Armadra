/**
 * 远程浏览器节点的画面流：几何与输入映射。
 *
 * 这里只有纯函数，组件在 `StreamSurface.tsx`。分开是因为值得测的恰好是这些
 * ——一帧怎么放进节点的框里、一次点击落在页面的哪个像素、断线第几次该等多久
 * ——而它们都不需要 canvas、socket 或 DOM。
 *
 * 坐标有两套，永远不要混：**框坐标**是节点在画布上的 CSS 像素，**页面坐标**
 * 是远端页面自己的视口像素。帧按「contain」缩放，所以框里可能有留白；一个没
 * 减掉留白的映射会让靠边的点击落到别的地方，而且越缩越偏。
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** 服务端对视口的夹取，这一侧照抄一份：两边算出同一个数，省掉一次往返。 */
export const MIN_VIEWPORT = 200;
export const MAX_VIEWPORT_WIDTH = 2_560;
export const MAX_VIEWPORT_HEIGHT = 1_600;

export function viewportFor(box: Size): Size {
  return {
    width: clamp(box.width, MIN_VIEWPORT, MAX_VIEWPORT_WIDTH),
    height: clamp(box.height, MIN_VIEWPORT, MAX_VIEWPORT_HEIGHT),
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.round(Math.min(high, Math.max(low, value)));
}

/** 帧在框里的位置：等比缩放、居中，多出来的是留白。 */
export interface Fit {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly drawWidth: number;
  readonly drawHeight: number;
}

export function fitFrame(frame: Size, box: Size): Fit {
  if (
    frame.width <= 0 ||
    frame.height <= 0 ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    return { scale: 1, offsetX: 0, offsetY: 0, drawWidth: 0, drawHeight: 0 };
  }
  // 只缩不放：把 1280 宽的页面拉到 1600 只会糊，不会更清楚。
  const scale = Math.min(box.width / frame.width, box.height / frame.height, 1);
  const drawWidth = frame.width * scale;
  const drawHeight = frame.height * scale;
  return {
    scale,
    offsetX: (box.width - drawWidth) / 2,
    offsetY: (box.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  };
}

export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
}

export interface BoxRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 一次指针事件落在页面的哪个像素。
 *
 * 帧的尺寸是服务端渲染时的视口，所以除掉缩放之后就是页面坐标，不再乘 DPR：
 * 服务端按 `deviceScaleFactor: 1` 渲染，中间没有第二个缩放。落在留白上的点
 * 会被夹回页面边缘——服务端也会夹一次，两边同一个规则。
 */
export function toPageCoordinates(
  event: PointerLike,
  rect: BoxRect,
  frame: Size,
): { x: number; y: number } {
  const fit = fitFrame(frame, { width: rect.width, height: rect.height });
  if (fit.scale <= 0 || fit.drawWidth <= 0) return { x: 0, y: 0 };
  const x = (event.clientX - rect.left - fit.offsetX) / fit.scale;
  const y = (event.clientY - rect.top - fit.offsetY) / fit.scale;
  return {
    x: clamp(x, 0, Math.max(frame.width - 1, 0)),
    y: clamp(y, 0, Math.max(frame.height - 1, 0)),
  };
}

/** CDP 的 modifiers 位：Alt 1、Ctrl 2、Meta 4、Shift 8。 */
export function modifierBits(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/* ------------------------------ 服务端的消息 ------------------------------ */

export interface FrameHeader {
  readonly type: "frame";
  readonly seq: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly bytes: number;
}

export interface StreamError {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

export interface StreamHello {
  readonly type: "hello";
  readonly nodeId: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export type ServerMessage = FrameHeader | StreamError | StreamHello;

/** 认不出来的消息一律丢掉，不猜。 */
export function parseServerMessage(raw: string): ServerMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type === "frame") {
    if (
      typeof message.width !== "number" ||
      typeof message.height !== "number"
    ) {
      return undefined;
    }
    return {
      type: "frame",
      seq: typeof message.seq === "number" ? message.seq : 0,
      width: message.width,
      height: message.height,
      viewportWidth:
        typeof message.viewportWidth === "number"
          ? message.viewportWidth
          : message.width,
      viewportHeight:
        typeof message.viewportHeight === "number"
          ? message.viewportHeight
          : message.height,
      bytes: typeof message.bytes === "number" ? message.bytes : 0,
    };
  }
  if (message.type === "error") {
    return {
      type: "error",
      code: typeof message.code === "string" ? message.code : "browser_failed",
      message: typeof message.message === "string" ? message.message : "",
    };
  }
  if (message.type === "hello") {
    return {
      type: "hello",
      nodeId: typeof message.nodeId === "string" ? message.nodeId : "",
      viewportWidth:
        typeof message.viewportWidth === "number" ? message.viewportWidth : 0,
      viewportHeight:
        typeof message.viewportHeight === "number" ? message.viewportHeight : 0,
    };
  }
  return undefined;
}

/**
 * 重连的等待时间：250 ms 起步翻倍，封顶 10 秒，和 core 侧那条通道同一组数。
 *
 * 不做无限快速重连：服务端明确回「已经有人在看」的时候，一秒十次重试只是把
 * 那个人的画面挤掉的另一种写法。
 */
export function reconnectDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt), 10_000);
}
