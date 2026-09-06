import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createWorkspaceFileDrag,
  WORKSPACE_FILES_MIME,
  WORKSPACE_FILE_DROP_EVENT,
} from "../../files/workspace-drag";

/**
 * 拖放的独占路由（React Flow 计划 F27）。
 *
 * React Flow 不接管 drop，所以 `os-drop.ts` 是唯一入口。这份测试盯的是
 * 「谁吃掉这一次拖放」：工作区文件树的载荷在捕获相位就被认走，终端自己
 * 消费的那一次画布绝不能再处理一遍，锁定与跨工作区一律拒绝。
 *
 * 粘贴那一半在这里一并覆盖：输入框与终端里的粘贴必须原样交给它们。
 */

const mocks = vi.hoisted(() => ({
  preview: vi.fn(async (..._args: unknown[]) => {}),
  os: vi.fn(async (..._args: unknown[]) => {}),
  browser: vi.fn(async (..._args: unknown[]) => {}),
  paste: vi.fn(async (..._args: unknown[]) => {}),
  error: vi.fn(),
  localClipboard: null as string | null,
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
  useCanvasStore: {
    getState: () => ({
      document: { board: { id: "b1" } },
      workspace: { id: "w1" },
    }),
  },
}));
vi.mock("../flow/flow-context", () => ({
  screenToPage: (point: unknown) => point,
}));
vi.mock("../interaction/pointer", () => ({
  pastePoint: () => ({ x: 7, y: 9 }),
}));
vi.mock("../whiteboard/tools/use-clipboard", () => ({
  paste: (...args: unknown[]) => mocks.paste(...args),
  localClipboardText: () => mocks.localClipboard,
}));
vi.mock("../../app/preferences-store", () => ({
  t: (key: string) => key,
  usePreferencesStore: {
    getState: () => ({ whiteboard: { pasteAtCursor: true } }),
  },
}));
vi.mock("../canvas-lock", () => ({ isCanvasLocked: () => mocks.locked }));
vi.mock("./external-content", () => ({
  addWorkspaceEntriesToCanvas: (...args: unknown[]) => mocks.preview(...args),
  addNodesForPaths: (...args: unknown[]) => mocks.os(...args),
  addBrowserFiles: (...args: unknown[]) => mocks.browser(...args),
  captureImportTarget: () => ({ workspaceId: "w1", boardId: "b1" }),
  routeFile: (file: { type: string }) =>
    file.type.startsWith("image/") ? "image" : "file",
}));
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mocks.error(...args) },
}));

const { useOsDrop, usePasteToCanvas } = await import("./os-drop");

function Fixture({ terminalDrop = vi.fn() }) {
  const handlers = useOsDrop();
  usePasteToCanvas();
  return (
    <div
      className="canvas-stage"
      onDropCapture={handlers.onDrop}
      onDragOverCapture={handlers.onDragOver}
    >
      <div data-testid="canvas" />
      <textarea data-testid="input" />
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

function pasteEvent(
  target: HTMLElement,
  data: { text?: string; files?: File[] } = {},
) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: data.files ?? [],
      items: [],
      getData: () => data.text ?? "",
    },
  });
  fireEvent(target, event);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locked = false;
  mocks.localClipboard = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("exclusive workspace file destinations", () => {
  it("在捕获相位先认走工作区载荷，画布不会再当成普通文本处理", () => {
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

  it("终端自己消费的那一次拖放，画布不再处理", () => {
    const terminalDrop = vi.fn();
    render(<Fixture terminalDrop={terminalDrop} />);
    drop(screen.getByTestId("terminal"));
    expect(terminalDrop).toHaveBeenCalledOnce();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("Windows 的指针兜底事件只在画布上生效", () => {
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

  it("跨工作区与锁定的画布一律拒绝", () => {
    render(<Fixture />);
    drop(screen.getByTestId("canvas"), payload("other"));
    mocks.locked = true;
    drop(screen.getByTestId("canvas"));
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(2);
  });

  it("桌面版 OS 拖放照旧导入画布，但拒绝落在终端上的外部路径", () => {
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

describe("粘贴", () => {
  it("画布上的粘贴按落点交给白板层", () => {
    render(<Fixture />);
    pasteEvent(screen.getByTestId("canvas"), { text: "hello" });
    expect(mocks.paste).toHaveBeenCalledWith(
      { workspaceId: "w1", at: { x: 7, y: 9 } },
      expect.objectContaining({ text: "hello" }),
    );
  });

  it("图片文件也走同一条路", () => {
    render(<Fixture />);
    pasteEvent(screen.getByTestId("canvas"), {
      files: [new File(["x"], "a.png", { type: "image/png" })],
    });
    expect(mocks.paste).toHaveBeenCalledOnce();
    expect(
      (mocks.paste.mock.calls[0]![1] as { files: File[] }).files,
    ).toHaveLength(1);
  });

  // Finder 复制来的文件是任意类型：分流归 `external-content`，这里一个不筛。
  it("非图片文件也照收，交给同一张分流表", () => {
    render(<Fixture />);
    pasteEvent(screen.getByTestId("canvas"), {
      files: [new File(["x"], "notes.pdf", { type: "application/pdf" })],
    });
    expect(
      (mocks.paste.mock.calls[0]![1] as { files: File[] }).files.map(
        (file) => file.name,
      ),
    ).toEqual(["notes.pdf"]);
  });

  it("载荷是空的时候退回应用内的那一份", () => {
    mocks.localClipboard = '{"armadra":"canvas@1"}';
    render(<Fixture />);
    pasteEvent(screen.getByTestId("canvas"), { text: "" });
    expect(mocks.paste).toHaveBeenCalledWith(
      { workspaceId: "w1", at: { x: 7, y: 9 } },
      expect.objectContaining({ text: '{"armadra":"canvas@1"}' }),
    );
  });

  it("输入框与终端里的粘贴原样交给它们", () => {
    render(<Fixture />);
    pasteEvent(screen.getByTestId("input"), { text: "hello" });
    pasteEvent(screen.getByTestId("terminal"), { text: "hello" });
    expect(mocks.paste).not.toHaveBeenCalled();
  });

  it("锁定的画布不接粘贴", () => {
    mocks.locked = true;
    render(<Fixture />);
    pasteEvent(screen.getByTestId("canvas"), { text: "hello" });
    expect(mocks.paste).not.toHaveBeenCalled();
  });

  it("空剪贴板什么也不做", () => {
    render(<Fixture />);
    pasteEvent(screen.getByTestId("canvas"), { text: "   " });
    expect(mocks.paste).not.toHaveBeenCalled();
  });
});
