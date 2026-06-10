import { describe, expect, it, vi } from "vitest";
import { isolateTerminalInput } from "./ime";

describe("terminal IME isolation", () => {
  it("keeps composition events out of canvas shortcuts without cancelling input", () => {
    const parent = document.createElement("div");
    const textarea = document.createElement("textarea");
    parent.append(textarea);
    const canvasShortcut = vi.fn();
    parent.addEventListener("keydown", canvasShortcut);
    const dispose = isolateTerminalInput(textarea, "zh-CN");
    const event = new KeyboardEvent("keydown", {
      key: "Process",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    expect(canvasShortcut).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(textarea.lang).toBe("zh-CN");
    dispose();
  });
});
