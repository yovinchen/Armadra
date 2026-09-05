import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createWorkspaceFileDrag,
  WORKSPACE_FILES_MIME,
  WORKSPACE_FILE_DROP_EVENT,
} from "../../files/workspace-drag";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(async (..._args: unknown[]) => {}),
  os: vi.fn(async (..._args: unknown[]) => {}),
  browser: vi.fn(async (..._args: unknown[]) => {}),
  error: vi.fn(),
  locked: false,
  nativeDrop: null as
    | null
    | ((paths: string[], point: { x: number; y: number }) => void),
}));
vi.mock("../../api/client", () => ({ RUNTIME_URL: "http://runtime" }));
vi.mock("../../platform", () => ({
  onFileDrop: (callback: typeof mocks.nativeDrop) => {
    mocks.nativeDrop = callback;
    return () => {
      mocks.nativeDrop = null;
    };
  },
}));
vi.mock("../../store/canvas-store", () => ({
  useCanvasStore: { getState: () => ({ document: { board: { id: "b1" } } }) },
}));
vi.mock("../editor-context", () => ({
  getEditor: () => ({}),
  screenToPage: (point: unknown) => point,
}));
vi.mock("../canvas-lock", () => ({ isCanvasLocked: () => mocks.locked }));
vi.mock("./external-content", () => ({
  addWorkspaceEntriesToCanvas: (...args: unknown[]) => mocks.preview(...args),
  addNodesForPaths: (...args: unknown[]) => mocks.os(...args),
  addBrowserFiles: (...args: unknown[]) => mocks.browser(...args),
  captureImportTarget: () => ({ workspaceId: "w1", boardId: "b1", editor: {} }),
}));
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mocks.error(...args) },
}));

import { useOsDrop } from "./os-drop";

function Fixture({ terminalDrop = vi.fn() }) {
  const handlers = useOsDrop();
  return (
    <div
      className="canvas-stage"
      onDropCapture={handlers.onDrop}
      onDragOverCapture={handlers.onDragOver}
    >
      <div data-testid="canvas" />
      <div
        data-testid="terminal"
        data-slot="terminal-body"
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          terminalDrop();
        }}
      />
    </div>
  );
}
function payload(workspaceId = "w1") {
  return createWorkspaceFileDrag("http://runtime", workspaceId, [
    { path: "a.txt", name: "a.txt", kind: "file", size: 1, readonly: false },
  ]);
}
function drop(target: HTMLElement, drag = payload()) {
  const event = new MouseEvent("drop", {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 30,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: [WORKSPACE_FILES_MIME],
      getData: () => JSON.stringify(drag),
    },
  });
  fireEvent(target, event);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.locked = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("exclusive workspace file destinations", () => {
  it("handles the typed payload in capture before the canvas can consume text", () => {
    render(<Fixture />);
    drop(screen.getByTestId("canvas"));
    expect(mocks.preview).toHaveBeenCalledOnce();
    expect(mocks.preview).toHaveBeenCalledWith(
      payload().entries,
      { x: 20, y: 30 },
      expect.objectContaining({ workspaceId: "w1" }),
    );
    expect(mocks.os).not.toHaveBeenCalled();
    expect(mocks.browser).not.toHaveBeenCalled();
  });

  it("lets terminal HTML drop consume the event without creating a preview", () => {
    const terminalDrop = vi.fn();
    render(<Fixture terminalDrop={terminalDrop} />);
    drop(screen.getByTestId("terminal"));
    expect(terminalDrop).toHaveBeenCalledOnce();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("routes pointer fallback onto the canvas but never pastes and previews together", () => {
    render(<Fixture />);
    fireEvent(
      screen.getByTestId("canvas"),
      new CustomEvent(WORKSPACE_FILE_DROP_EVENT, {
        bubbles: true,
        detail: { drag: payload(), point: { x: 20, y: 30 } },
      }),
    );
    expect(mocks.preview).toHaveBeenCalledOnce();
    fireEvent(
      screen.getByTestId("terminal"),
      new CustomEvent(WORKSPACE_FILE_DROP_EVENT, {
        bubbles: true,
        detail: { drag: payload(), point: { x: 20, y: 30 } },
      }),
    );
    expect(mocks.preview).toHaveBeenCalledOnce();
  });

  it("rejects wrong scope and a locked canvas", () => {
    render(<Fixture />);
    drop(screen.getByTestId("canvas"), payload("other"));
    mocks.locked = true;
    drop(screen.getByTestId("canvas"));
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(2);
  });

  it("keeps native OS canvas importing but rejects external terminal paths", () => {
    render(<Fixture />);
    let target: Element | null = screen.getByTestId("terminal");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });
    mocks.nativeDrop!(["/tmp/a.txt"], { x: 20, y: 30 });
    expect(mocks.os).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
    target = screen.getByTestId("canvas");
    mocks.nativeDrop!(["/tmp/a.txt"], { x: 20, y: 30 });
    expect(mocks.os).toHaveBeenCalledWith(["/tmp/a.txt"], { x: 20, y: 30 });
  });
});
