import type { BrowserInputEvent } from "@armadra/shared";

const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

export function mouseButton(button: number): BrowserInputEvent["button"] {
  return MOUSE_BUTTONS[button] ?? "none";
}

/** 补齐一条输入事件的默认值，调用方只写它关心的字段。 */
export function inputEvent(
  partial: Partial<BrowserInputEvent> & Pick<BrowserInputEvent, "kind">,
): BrowserInputEvent {
  return {
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY: 0,
    button: "none",
    clickCount: 0,
    modifiers: 0,
    key: "",
    code: "",
    text: "",
    ...partial,
  };
}
