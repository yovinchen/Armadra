import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const editor = vi.hoisted(() => ({ setCurrentTool: vi.fn() }));

const editorContext = vi.hoisted(() => ({
  current: null as { setCurrentTool: (tool: string) => void } | null,
}));
vi.mock("@/canvas/editor-context", () => ({
  getEditor: () => editorContext.current,
}));

import * as links from "./LinkArrow";

import { ConnectionHandles } from "./ConnectionHandles";

beforeEach(() => {
  editorContext.current = editor;
  links.endHandleLink();
});

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

  it("passes the owning shape and clears the pending start on Escape", () => {
    const begin = vi.spyOn(links, "beginHandleLink");
    render(
      <div data-shape-id="shape:019ff7d1-0d12-7421-833d-2c5e8d64ed01">
        <ConnectionHandles />
      </div>,
    );
    fireEvent.pointerDown(screen.getByLabelText("发出上下文"), { button: 0 });
    expect(begin).toHaveBeenCalledWith(
      "right",
      "shape:019ff7d1-0d12-7421-833d-2c5e8d64ed01",
      editor,
    );
    expect(links.isHandleLinkPending()).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(links.isHandleLinkPending()).toBe(false);
    fireEvent.pointerCancel(window);
    begin.mockRestore();
  });

  it("never resets a new editor or clears its newer gesture on an old pointerup", () => {
    render(<ConnectionHandles />);
    fireEvent.pointerDown(screen.getByLabelText("发出上下文"), {
      button: 0,
      pointerId: 1,
    });
    const nextEditor = { setCurrentTool: vi.fn() };
    editorContext.current = nextEditor;
    const nextGesture = links.beginHandleLink("left");
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(nextEditor.setCurrentTool).not.toHaveBeenCalled();
    expect(editor.setCurrentTool).toHaveBeenCalledTimes(1);
    expect(links.isHandleLinkPending()).toBe(true);
    links.endHandleLink(nextGesture);
  });

  it("unmount removes listeners and only clears the gesture it still owns", () => {
    const view = render(<ConnectionHandles />);
    fireEvent.pointerDown(screen.getByLabelText("发出上下文"), {
      button: 0,
      pointerId: 1,
    });
    const newer = links.beginHandleLink("left");
    view.unmount();
    editor.setCurrentTool.mockClear();
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerCancel(window, { pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(editor.setCurrentTool).not.toHaveBeenCalled();
    expect(links.isHandleLinkPending()).toBe(true);
    links.endHandleLink(newer);
    const own = render(<ConnectionHandles />);
    fireEvent.pointerDown(screen.getByLabelText("发出上下文"), { button: 0 });
    own.unmount();
    expect(links.isHandleLinkPending()).toBe(false);
  });

  it("Escape retires listeners so a later release cannot clear a new gesture", () => {
    render(<ConnectionHandles />);
    fireEvent.pointerDown(screen.getByLabelText("发出上下文"), {
      button: 0,
      pointerId: 1,
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(links.isHandleLinkPending()).toBe(false);
    editor.setCurrentTool.mockClear();
    const newer = links.beginHandleLink("left");
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(editor.setCurrentTool).not.toHaveBeenCalled();
    expect(links.isHandleLinkPending()).toBe(true);
    links.endHandleLink(newer);
  });

  it("only the active gesture's pointer can finish a link", () => {
    render(<ConnectionHandles />);
    fireEvent.pointerDown(screen.getByLabelText("发出上下文"), {
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerDown(screen.getByLabelText("接收上下文"), {
      button: 0,
      pointerId: 2,
    });
    editor.setCurrentTool.mockClear();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(links.isHandleLinkPending()).toBe(true);
    expect(editor.setCurrentTool).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(links.isHandleLinkPending()).toBe(false);
    expect(editor.setCurrentTool).toHaveBeenCalledWith("select");
  });

  it("does not turn a second touch into a new link gesture", () => {
    render(<ConnectionHandles />);
    const event = new PointerEvent("pointerdown", {
      button: 0,
      bubbles: true,
      pointerType: "touch",
    });
    Object.defineProperty(event, "isPrimary", { value: false });
    fireEvent(screen.getByLabelText("发出上下文"), event);
    expect(editor.setCurrentTool).not.toHaveBeenCalled();
  });

  it("ignores non-primary buttons", () => {
    render(<ConnectionHandles />);
    fireEvent.pointerDown(screen.getByLabelText("接收上下文"), { button: 2 });
    expect(editor.setCurrentTool).not.toHaveBeenCalled();
  });
});
