import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const editor = vi.hoisted(() => ({ setCurrentTool: vi.fn() }));

vi.mock("@/canvas/editor-context", () => ({
  getEditor: () => editor,
}));

import { ConnectionHandles } from "./ConnectionHandles";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConnectionHandles", () => {
  it("renders one handle per side", () => {
    const { container } = render(<ConnectionHandles />);
    const handles = container.querySelectorAll(
      '[data-slot="connection-handle"]',
    );
    expect(handles).toHaveLength(2);
    expect([...handles].map((el) => el.getAttribute("data-side"))).toEqual([
      "left",
      "right",
    ]);
    expect((handles[0] as HTMLElement).style.background).toBe("");
  });

  /**
   * 起笔的全部动作就是切工具：同一次 pointerdown 会继续冒泡到 `.tl-canvas`，
   * 箭头工具在那里接管拖动（§4.3）。所以这里**不**能 stopPropagation。
   */
  it("switches to the arrow tool on pointer down and back on pointer up", () => {
    render(<ConnectionHandles />);
    const handle = screen.getByLabelText("发出上下文");

    const escaped = vi.fn();
    document.addEventListener("pointerdown", escaped);
    try {
      fireEvent.pointerDown(handle, { button: 0 });
      expect(editor.setCurrentTool).toHaveBeenCalledWith("arrow");
      expect(escaped).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("pointerdown", escaped);
    }

    fireEvent.pointerUp(window);
    expect(editor.setCurrentTool).toHaveBeenLastCalledWith("select");
  });

  it("ignores non-primary buttons", () => {
    render(<ConnectionHandles />);
    fireEvent.pointerDown(screen.getByLabelText("接收上下文"), { button: 2 });
    expect(editor.setCurrentTool).not.toHaveBeenCalled();
  });
});
