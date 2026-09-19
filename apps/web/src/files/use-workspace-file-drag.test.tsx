import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useWorkspaceFileDrag } from "./use-workspace-file-drag";
import {
  WORKSPACE_FILES_MIME,
  WORKSPACE_FILE_DROP_EVENT,
} from "./workspace-drag";
import { useCanvasStore } from "../store/canvas-store";

vi.mock("../api/client", () => ({
  RUNTIME_URL: "http://runtime",
  runtimeApi: {},
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const entry = {
  name: "notes.txt",
  path: "src/notes.txt",
  kind: "file" as const,
  size: 4,
  readonly: false,
};
const activate = vi.fn();
function Fixture({ fallback = true, workspace = "w1" }) {
  const props = useWorkspaceFileDrag(workspace, fallback);
  return (
    <>
      <button {...props(entry)} onClick={activate}>
        file
      </button>
      <div data-testid="destination" />
    </>
  );
}
function pointer(target: EventTarget, type: string, x: number, y = 10) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
    isPrimary: { value: true },
  });
  fireEvent(target as HTMLElement, event);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  activate.mockReset();
});

describe("Windows internal pointer drag", () => {
  it("uses a threshold, sends one typed drop and suppresses the trailing click", () => {
    render(<Fixture />);
    const source = screen.getByRole("button", { name: "file" });
    const destination = screen.getByTestId("destination");
    const dropped = vi.fn();
    destination.addEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => destination),
    });
    expect(source.draggable).toBe(false);
    pointer(source, "pointerdown", 10);
    pointer(window, "pointermove", 13);
    expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
    pointer(window, "pointermove", 30);
    expect(
      document.querySelector("[data-file-drag-preview]")?.textContent,
    ).toBe("notes.txt");
    pointer(window, "pointerup", 40);
    expect(dropped).toHaveBeenCalledOnce();
    expect((dropped.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      point: { x: 40, y: 10 },
      drag: {
        runtimeUrl: "http://runtime",
        workspaceId: "w1",
        entries: [{ path: "src/notes.txt" }],
      },
    });
    expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
    fireEvent.click(source);
    expect(activate).not.toHaveBeenCalled();
    pointer(window, "pointerup", 45);
    expect(dropped).toHaveBeenCalledOnce();
  });

  it.each(["Escape", "blur", "pointercancel", "unmount", "workspace"])(
    "cleans up on %s without a drop",
    (cancel) => {
      const view = render(<Fixture />);
      const destination = screen.getByTestId("destination");
      const dropped = vi.fn();
      destination.addEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => destination),
      });
      pointer(screen.getByRole("button"), "pointerdown", 10);
      pointer(window, "pointermove", 30);
      if (cancel === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (cancel === "blur") fireEvent(window, new Event("blur"));
      else if (cancel === "pointercancel") pointer(window, "pointercancel", 30);
      else if (cancel === "unmount") view.unmount();
      else view.rerender(<Fixture workspace="w2" />);
      pointer(window, "pointerup", 40);
      expect(dropped).not.toHaveBeenCalled();
      expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
    },
  );

  it("cancels when the board changes in the same workspace before pointerup", () => {
    const view = render(<Fixture />);
    const source = screen.getByRole("button");
    const destination = screen.getByTestId("destination");
    const dropped = vi.fn();
    destination.addEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => destination),
    });
    pointer(source, "pointerdown", 10);
    pointer(window, "pointermove", 30);
    const previous = useCanvasStore.getState().document;
    // Let effect cleanup finish before pointerup: its cancel path must retain
    // trailing-click suppression even though the pointer listener is gone.
    act(() => {
      useCanvasStore.setState({
        document: {
          ...previous,
          board: { ...previous?.board, id: "changed-board" },
        } as never,
      });
    });
    pointer(window, "pointerup", 40);
    expect(dropped).not.toHaveBeenCalled();
    expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
    fireEvent.click(source);
    expect(activate).not.toHaveBeenCalled();
    view.unmount();
    useCanvasStore.setState({ document: previous });
  });

  it("captures the pointer and cancels when capture is lost", () => {
    render(<Fixture />);
    const source = screen.getByRole("button");
    const set = vi.fn();
    const release = vi.fn();
    source.setPointerCapture = set;
    source.hasPointerCapture = () => true;
    source.releasePointerCapture = release;
    pointer(source, "pointerdown", 10);
    pointer(window, "pointermove", 30);
    expect(set).toHaveBeenCalledWith(1);
    fireEvent(source, new Event("lostpointercapture"));
    expect(release).toHaveBeenCalledWith(1);
    expect(document.querySelector("[data-file-drag-preview]")).toBeNull();
  });

  it("keeps ordinary clicks and native HTML5 drag on other platforms", () => {
    const view = render(<Fixture />);
    const source = screen.getByRole("button");
    pointer(source, "pointerdown", 10);
    pointer(window, "pointerup", 12);
    fireEvent.click(source);
    expect(activate).toHaveBeenCalledOnce();
    view.rerender(<Fixture fallback={false} />);
    expect(source.draggable).toBe(true);
    const transfer = { effectAllowed: "none", setData: vi.fn() };
    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith(
      WORKSPACE_FILES_MIME,
      expect.stringContaining('"src/notes.txt"'),
    );
    expect(transfer.effectAllowed).toBe("copy");
  });
});
