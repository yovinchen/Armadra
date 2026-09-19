/**
 * The watching half of a remote browser node: what a person sees, and what
 * their hands do to the page.
 *
 * **The allowlist is not the gate here, and that is deliberate.**
 * `core/browser/cdp/allowlist.ts` bounds what an AGENT may do to somebody's
 * logged-in page: no arbitrary key chords, no `text` on a key event, no
 * storage, no cookies. A person looking at their own browser node is not an
 * agent — refusing them the letter "q" because an agent may not send one would
 * be refusing them their own browser. What gates this side instead is the
 * lease: input arriving here takes the lease for the human and revokes the
 * agent's (`LEASE_HELD_BY_HUMAN`), exactly as touching a `<webview>` guest does
 * in the desktop shell. The method set below is still narrow — four `Input.*`
 * commands and `Emulation.setDeviceMetricsOverride`, nothing that reads the
 * page — because a stream socket is reachable by anything that can reach the
 * core, and "the person is allowed to type" is not "the socket is allowed to
 * ask for cookies".
 *
 * Everything in this file except {@link Screencast} is pure, so the mapping,
 * the clamping and the bounds are tested without a browser.
 */

/** Bounds on a viewport a viewer may ask for. A page rendered at 8000px wide
 * is a page nobody is looking at and a frame nobody can decode in time. */
export const MIN_VIEWPORT = 200;
export const MAX_VIEWPORT_WIDTH = 2_560;
export const MAX_VIEWPORT_HEIGHT = 1_600;

/** Longest single paste. Same bound the agent's `type` has, for the same
 * reason: a megabyte of text is not typing. */
export const MAX_VIEWER_TEXT = 4_096;

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export function clampViewport(width: unknown, height: unknown): Viewport {
  return {
    width: clamp(width, MIN_VIEWPORT, MAX_VIEWPORT_WIDTH, 1_280),
    height: clamp(height, MIN_VIEWPORT, MAX_VIEWPORT_HEIGHT, 800),
  };
}

function clamp(
  value: unknown,
  low: number,
  high: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(high, Math.max(low, value)));
}

/* ------------------------------- messages --------------------------------- */

export type ViewerMessage =
  | {
      readonly type: "viewport";
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: "left" | "middle" | "right";
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      readonly keyCode: number;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string };

const BUTTONS = ["left", "middle", "right"] as const;

/**
 * Reads one message off the socket.
 *
 * `undefined` for anything this does not recognise, and the caller drops it
 * without answering: a stream socket carries a person's mouse, and a parser
 * that explains what it would have accepted is a parser being read by
 * something that is not a person.
 */
export function parseViewerMessage(raw: unknown): ViewerMessage | undefined {
  if (typeof raw !== "string" || raw.length > 8_192) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "viewport": {
      const viewport = clampViewport(message.width, message.height);
      return { type: "viewport", ...viewport };
    }
    case "mouse": {
      const action = message.action;
      if (action !== "move" && action !== "down" && action !== "up")
        return undefined;
      if (!isNumber(message.x) || !isNumber(message.y)) return undefined;
      const button = BUTTONS.includes(message.button as never)
        ? (message.button as "left" | "middle" | "right")
        : "left";
      return {
        type: "mouse",
        action,
        x: message.x,
        y: message.y,
        button,
        clickCount: clamp(message.clickCount, 1, 3, 1),
        modifiers: clamp(message.modifiers, 0, 15, 0),
      };
    }
    case "wheel": {
      if (!isNumber(message.x) || !isNumber(message.y)) return undefined;
      return {
        type: "wheel",
        x: message.x,
        y: message.y,
        deltaX: bounded(message.deltaX, 4_000),
        deltaY: bounded(message.deltaY, 4_000),
      };
    }
    case "key": {
      const action = message.action;
      if (action !== "down" && action !== "up") return undefined;
      const key = typeof message.key === "string" ? message.key : "";
      if (key.length === 0 || key.length > 32) return undefined;
      return {
        type: "key",
        action,
        key,
        code: typeof message.code === "string" ? message.code.slice(0, 32) : "",
        keyCode: clamp(message.keyCode, 0, 255, 0),
        modifiers: clamp(message.modifiers, 0, 15, 0),
      };
    }
    case "text": {
      const text = typeof message.text === "string" ? message.text : "";
      if (text.length === 0 || text.length > MAX_VIEWER_TEXT) return undefined;
      return { type: "text", text };
    }
    default:
      return undefined;
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function bounded(value: unknown, limit: number): number {
  if (!isNumber(value)) return 0;
  return Math.max(-limit, Math.min(limit, Math.round(value)));
}

/** One CDP command a viewer message turned into. */
export interface ViewerCommand {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * Turns one viewer message into CDP commands, with every coordinate clamped
 * into the viewport THIS process set.
 *
 * A click outside the page is a click at whatever the compositor has there,
 * which is not the page the viewer is looking at — the same rule the agent
 * side enforces in the allowlist, applied here because this path does not go
 * through it.
 */
export function viewerCommands(
  message: ViewerMessage,
  viewport: Viewport,
): readonly ViewerCommand[] {
  switch (message.type) {
    case "viewport":
      return [
        {
          method: "Emulation.setDeviceMetricsOverride",
          params: {
            width: message.width,
            height: message.height,
            deviceScaleFactor: 1,
            mobile: false,
          },
        },
      ];
    case "mouse": {
      const type =
        message.action === "move"
          ? "mouseMoved"
          : message.action === "down"
            ? "mousePressed"
            : "mouseReleased";
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type,
            x: inside(message.x, viewport.width),
            y: inside(message.y, viewport.height),
            button: message.action === "move" ? "none" : message.button,
            clickCount: message.action === "move" ? 0 : message.clickCount,
            modifiers: message.modifiers,
          },
        },
      ];
    }
    case "wheel":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: inside(message.x, viewport.width),
            y: inside(message.y, viewport.height),
            deltaX: message.deltaX,
            deltaY: message.deltaY,
          },
        },
      ];
    case "key":
      return [
        {
          method: "Input.dispatchKeyEvent",
          params: {
            type: message.action === "down" ? "keyDown" : "keyUp",
            key: message.key,
            code: message.code,
            windowsVirtualKeyCode: message.keyCode,
            nativeVirtualKeyCode: message.keyCode,
            modifiers: message.modifiers,
            // A single printable character is the text of the event; anything
            // longer is a named key (`ArrowLeft`) and carries none.
            ...([...message.key].length === 1 && message.action === "down"
              ? { text: message.key }
              : {}),
          },
        },
      ];
    case "text":
      return [{ method: "Input.insertText", params: { text: message.text } }];
  }
}

function inside(value: number, extent: number): number {
  return Math.round(Math.min(Math.max(value, 0), Math.max(extent - 1, 0)));
}

/* ------------------------------ frame metadata ---------------------------- */

/** What travels ahead of each JPEG, so the canvas knows what it is drawing. */
export interface FrameHeader {
  readonly type: "frame";
  readonly seq: number;
  readonly width: number;
  readonly height: number;
  /** The page viewport the frame was rendered at, which is what the viewer's
   * coordinates must be expressed in. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly bytes: number;
}

export function frameHeader(
  seq: number,
  metadata: unknown,
  viewport: Viewport,
  bytes: number,
): FrameHeader {
  const shape = (metadata ?? {}) as {
    deviceWidth?: number;
    deviceHeight?: number;
  };
  return {
    type: "frame",
    seq,
    width: Math.round(shape.deviceWidth ?? viewport.width),
    height: Math.round(shape.deviceHeight ?? viewport.height),
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    bytes,
  };
}

/**
 * Screencast quality. JPEG rather than PNG because this is a video of a page.
 *
 * `everyNthFrame: 1`, and that is not an oversight: skipping frames was tried
 * and it breaks the ordinary case. Chromium emits a screencast frame when the
 * page paints, so a page that finished loading before anybody looked at it
 * paints exactly ONCE — and `everyNthFrame: 2` drops that one frame, leaving a
 * viewer staring at nothing for a page that is perfectly fine. The rate is
 * bounded by the ack instead: the next frame is only sent after the previous
 * one is acknowledged, so a slow viewer slows the stream rather than queueing
 * it.
 */
export const SCREENCAST_OPTIONS = Object.freeze({
  format: "jpeg" as const,
  quality: 60,
  everyNthFrame: 1,
});
