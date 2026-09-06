import {
  BrowserBandwidthClass as BandwidthClassEnum,
  BrowserInputKind as InputKindEnum,
  BrowserStreamClientSchema,
  BrowserStreamFrameSchema,
  BrowserVisibility as VisibilityEnum,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";
import {
  browserSubscriptionSchema,
  type BrowserBandwidthClass,
  type BrowserInputEvent,
  type BrowserInputKind,
  type BrowserSubscription,
  type BrowserVisibility,
} from "@armadra/shared";

import { browserStreamUrl } from "@/api/sockets";

/**
 * 一个会话一条专用画面流（设计 §2.9）。
 *
 * 帧走这条连接而不是工作空间事件通道，有两个原因：帧是二进制的，base64 放在
 * 所有客户端共读的通道上等于每个客户端都多付三分之一带宽和一次解码；以及它
 * 需要逐订阅者确认，而广播通道表达不了「谁画到第几帧」。Host 的 `proxyStream`
 * 原样转发这条连接，不看里面的字节。
 *
 * 连接本身就是订阅：连上即订阅，断开即退订，不存在「订阅还在但连接没了」。
 */

export interface StreamFrame {
  frameSeq: number;
  navigationEpoch: number;
  width: number;
  height: number;
  /** 已经是可直接画到 canvas 上的位图。 */
  bitmap: ImageBitmap | HTMLImageElement;
}

export interface StreamHandlers {
  onFrame(frame: StreamFrame): void;
  onSubscription?(subscription: BrowserSubscription): void;
  /** Runtime 拒绝了一批输入：`{ code, message }`，与 HTTP 路由同一形状。 */
  onRefusal?(code: string, message: string): void;
  onConnected?(connected: boolean): void;
}

export interface StreamOptions {
  workspaceId: string;
  sessionId: string;
  deviceId: string;
  visibility: BrowserVisibility;
  bandwidthClass: BrowserBandwidthClass;
  /** 0 表示这一端自己没有宽度上限。 */
  maxWidth?: number;
}

export interface StreamHandle {
  /** 可见性或带宽变了：重述预算，Runtime 回一份新的回执。 */
  update(options: Pick<StreamOptions, "visibility" | "bandwidthClass">): void;
  /** 发一批输入。返回 false 表示连接还没建立，调用方走 HTTP 回退。 */
  send(
    events: BrowserInputEvent[],
    navigationEpoch: number,
    frameSeq: number,
    leaseGeneration?: number,
  ): boolean;
  close(): void;
}

const VISIBILITY: Record<BrowserVisibility, VisibilityEnum> = {
  focused: VisibilityEnum.FOCUSED,
  visible: VisibilityEnum.VISIBLE,
  hidden: VisibilityEnum.HIDDEN,
};

const BANDWIDTH: Record<BrowserBandwidthClass, BandwidthClassEnum> = {
  lan: BandwidthClassEnum.LAN,
  wan: BandwidthClassEnum.WAN,
  metered: BandwidthClassEnum.METERED,
};

const INPUT_KIND: Record<BrowserInputKind, InputKindEnum> = {
  mouseMoved: InputKindEnum.MOUSE_MOVED,
  mousePressed: InputKindEnum.MOUSE_PRESSED,
  mouseReleased: InputKindEnum.MOUSE_RELEASED,
  wheel: InputKindEnum.WHEEL,
  keyDown: InputKindEnum.KEY_DOWN,
  keyUp: InputKindEnum.KEY_UP,
  text: InputKindEnum.TEXT,
  touchStart: InputKindEnum.TOUCH_START,
  touchMove: InputKindEnum.TOUCH_MOVE,
  touchEnd: InputKindEnum.TOUCH_END,
};

/** 指数退避 0.5s → 1s → 2s → 4s → 5s（封顶）。 */
export function nextStreamDelay(previous: number | null): number {
  if (previous === null || previous <= 0) return 500;
  return Math.min(previous * 2, 5_000);
}

function subscribe(options: StreamOptions) {
  return {
    visibility: VISIBILITY[options.visibility],
    bandwidthClass: BANDWIDTH[options.bandwidthClass],
    maxWidth: options.maxWidth ?? 0,
    deviceId: options.deviceId,
  };
}

/**
 * 把一帧的 JPEG 字节变成能画的东西。
 *
 * `createImageBitmap` 在 worker 线程上解码，比 `new Image()` 少一次主线程
 * 停顿；没有它（jsdom、老 WebView）就退回 `Image` + object URL。
 */
async function decode(
  bytes: Uint8Array,
): Promise<ImageBitmap | HTMLImageElement | null> {
  // 复制出一段独立的 ArrayBuffer：protobuf 解出来的 Uint8Array 可能是
  // 整条消息缓冲区上的一个视图，直接交给 Blob 会连带整帧之外的字节。
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: "image/jpeg",
  });
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      return null;
    }
  }
  const url = URL.createObjectURL(blob);
  return await new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

export function openBrowserStream(
  options: StreamOptions,
  handlers: StreamHandlers,
): StreamHandle {
  let current = { ...options };
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay: number | null = null;
  let stopped = false;

  const post = (
    message: Parameters<typeof create<typeof BrowserStreamClientSchema>>[1],
  ) => {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(
      toBinary(
        BrowserStreamClientSchema,
        create(BrowserStreamClientSchema, message),
      ),
    );
    return true;
  };

  const open = () => {
    if (stopped) return;
    const Socket = globalThis.WebSocket;
    if (!Socket) return;
    let next: WebSocket;
    try {
      next = new Socket(
        browserStreamUrl(current.workspaceId, current.sessionId),
      );
    } catch {
      schedule();
      return;
    }
    next.binaryType = "arraybuffer";
    socket = next;

    next.onopen = () => {
      if (socket !== next || stopped) return;
      delay = null;
      handlers.onConnected?.(true);
      post({ message: { case: "hello", value: subscribe(current) } });
    };
    next.onmessage = (event: MessageEvent) => {
      if (socket !== next || stopped) return;
      if (typeof event.data === "string") {
        answer(event.data);
        return;
      }
      const frame = fromBinary(
        BrowserStreamFrameSchema,
        new Uint8Array(event.data as ArrayBuffer),
      );
      void decode(frame.data).then((bitmap) => {
        if (!bitmap || socket !== next || stopped) return;
        handlers.onFrame({
          frameSeq: Number(frame.frameSeq),
          navigationEpoch: Number(frame.navigationEpoch),
          width: frame.viewportWidth,
          height: frame.viewportHeight,
          bitmap,
        });
        // 画完才确认：确认的是「已经画出来的那一帧」，否则背压量的是网络
        // 缓冲区而不是这一端真的跟上了没有。
        post({ message: { case: "ack", value: frame.frameSeq } });
      });
    };
    next.onclose = () => {
      if (socket !== next || stopped) return;
      socket = null;
      handlers.onConnected?.(false);
      schedule();
    };
    // `onerror` 之后浏览器一定会再发 `onclose`，重连只挂在 close 上。
    next.onerror = () => {};
  };

  const answer = (text: string) => {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const error = (payload as { error?: unknown } | null)?.error;
    if (typeof payload === "object" && payload !== null && "code" in payload) {
      const { code, message } = payload as { code: string; message?: string };
      handlers.onRefusal?.(code, message ?? "");
      return;
    }
    if (error) return;
    const parsed = browserSubscriptionSchema.safeParse(payload);
    if (parsed.success) handlers.onSubscription?.(parsed.data);
  };

  const schedule = () => {
    if (stopped || timer) return;
    delay = nextStreamDelay(delay);
    timer = setTimeout(() => {
      timer = undefined;
      open();
    }, delay);
  };

  open();

  return {
    update(next) {
      current = { ...current, ...next };
      post({ message: { case: "visibility", value: subscribe(current) } });
    },
    send(events, navigationEpoch, frameSeq, leaseGeneration) {
      return post({
        message: {
          case: "input",
          value: {
            sessionId: current.sessionId,
            navigationEpoch: BigInt(navigationEpoch),
            frameSeq: BigInt(frameSeq),
            leaseGeneration: BigInt(leaseGeneration ?? 0),
            deviceId: current.deviceId,
            events: events.map((event) => ({
              kind: INPUT_KIND[event.kind],
              x: event.x,
              y: event.y,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              button: event.button,
              clickCount: event.clickCount,
              modifiers: event.modifiers,
              key: event.key,
              code: event.code,
              text: event.text,
            })),
          },
        },
      });
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const held = socket;
      socket = null;
      held?.close();
    },
  };
}
