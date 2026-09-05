import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

const compact = vi.hoisted(() => ({ value: true }));
vi.mock("../platform/layout", () => ({
  useCompactLayout: () => compact.value,
  isCompactLayout: () => compact.value,
}));

const sendKeys = vi.hoisted(() => vi.fn());
const paste = vi.hoisted(() => vi.fn());
vi.mock("../nodes/terminal-registry", () => ({
  terminalHandle: () => ({ sendKeys, paste }),
  registerTerminalHandle: () => () => undefined,
}));

// The node bodies drag in xterm, CodeMirror and the canvas; the focus page only
// promises to mount whichever body the registry names, so a marker is enough.
vi.mock("../nodes/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nodes/registry")>();
  const Stub = ({ id }: { id: string }) => (
    <div data-testid="node-body">{id}</div>
  );
  return {
    ...actual,
    NODE_BODY: Object.fromEntries(
      Object.keys(actual.NODE_BODY).map((type) => [type, Stub]),
    ),
  };
});

import { MobileBottomNav } from "./MobileBottomNav";
import { MobileFocusPage } from "./MobileFocusPage";
import { canFocusOnPhone } from "./mobile-focus";
import { controlCode, MOBILE_KEYS } from "./mobile-keys";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore } from "../app/preferences-store";

function node(id: string, type: CanvasNode["type"], title: string): CanvasNode {
  return {
    id,
    type,
    title,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    color: "#888888",
    data:
      type === "terminal"
        ? { kind: "terminal", cwd: "/tmp" }
        : type === "editor"
          ? { kind: "editor", path: "a.ts" }
          : { kind: "browser" },
  } as CanvasNode;
}

const workspace = {
  id: "w-1",
  name: "fixture",
  rootPath: "/tmp/fixture",
  color: "#888888",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  compact.value = true;
  sendKeys.mockReset();
  paste.mockReset();
  usePreferencesStore.setState({ locale: "zh-CN" });
  useCanvasStore.setState({
    workspace: workspace as never,
    focusNodeId: null,
    document: {
      nodes: [
        node("n-terminal", "terminal", "构建"),
        node("n-editor", "editor", "README"),
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    } as never,
  });
});
afterEach(cleanup);

describe("the phone bottom navigation", () => {
  it("is absent on a wide window", () => {
    compact.value = false;
    render(<MobileBottomNav />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("opens one destination at a time and back to the canvas", () => {
    render(<MobileBottomNav />);
    fireEvent.click(screen.getByRole("button", { name: "Git" }));
    expect(useCanvasStore.getState().panels.scm).toBe("drawer");
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    const panels = useCanvasStore.getState().panels;
    expect(panels.explorer).toBe("drawer");
    expect(panels.scm).toBe("closed");
    fireEvent.click(screen.getByRole("button", { name: "画布" }));
    expect(useCanvasStore.getState().panels.explorer).toBe("closed");
  });

  it("keeps settings reachable before a workspace is open, and nothing else", () => {
    useCanvasStore.setState({ workspace: null });
    render(<MobileBottomNav />);
    // Pairing happens in settings, so hiding it would leave a new phone with
    // no way in at all.
    expect(
      screen.getByRole("button", { name: "设置" }).hasAttribute("disabled"),
    ).toBe(false);
    for (const name of ["画布", "文件", "Git", "自动化"])
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
  });

  it("steps aside while a node is open full screen", () => {
    useCanvasStore.setState({ focusNodeId: "n-terminal" });
    render(<MobileBottomNav />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("the phone focus page", () => {
  it("shows nothing until a focusable node is focused", () => {
    const { rerender } = render(<MobileFocusPage />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useCanvasStore.setState({ focusNodeId: "n-terminal" }));
    rerender(<MobileFocusPage />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("node-body").textContent).toBe("n-terminal");
  });

  it("is a desktop no-op even when a node is focused", () => {
    compact.value = false;
    useCanvasStore.setState({ focusNodeId: "n-terminal" });
    render(<MobileFocusPage />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("goes back to the canvas and switches between focusable nodes", () => {
    useCanvasStore.setState({ focusNodeId: "n-terminal" });
    render(<MobileFocusPage />);
    // The switcher lists every focusable node, not every node.
    expect(
      screen.getByRole("combobox", { name: "切换节点" }).textContent,
    ).toContain("构建");
    fireEvent.click(screen.getByRole("button", { name: /返回画布/ }));
    expect(useCanvasStore.getState().focusNodeId).toBeNull();
  });

  it("writes the keys a touch keyboard does not have", () => {
    useCanvasStore.setState({ focusNodeId: "n-terminal" });
    render(<MobileFocusPage />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(sendKeys).toHaveBeenCalledWith(MOBILE_KEYS[0]!.data);
    fireEvent.click(screen.getByRole("button", { name: "↑" }));
    expect(sendKeys).toHaveBeenLastCalledWith(
      MOBILE_KEYS.find((key) => key.labelKey === "mobile.key.up")!.data,
    );
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    expect(paste).toHaveBeenCalled();
  });

  it("opens the control codes behind Ctrl and closes them after one", () => {
    useCanvasStore.setState({ focusNodeId: "n-terminal" });
    render(<MobileFocusPage />);
    expect(screen.queryByRole("button", { name: "^C" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    fireEvent.click(screen.getByRole("button", { name: "^C" }));
    expect(sendKeys).toHaveBeenCalledWith(controlCode("C"));
    expect(screen.queryByRole("button", { name: "^C" })).toBeNull();
  });

  it("offers no terminal keys for a node that is not a terminal", () => {
    useCanvasStore.setState({ focusNodeId: "n-editor" });
    render(<MobileFocusPage />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("what a phone opens full screen", () => {
  it("covers the nodes worth a whole screen and nothing else", () => {
    for (const type of ["terminal", "editor", "browser"] as const)
      expect(canFocusOnPhone(type)).toBe(true);
    for (const type of [
      "sticky",
      "group",
      "diff",
      "files",
      "automation",
      "agentActivity",
    ] as const)
      expect(canFocusOnPhone(type)).toBe(false);
  });
});

describe("the control code table", () => {
  it("maps letters onto their control characters", () => {
    expect(controlCode("a")).toBe("");
    expect(controlCode("C")).toBe("");
    expect(controlCode("Z")).toBe("");
    expect(() => controlCode("1")).toThrow();
  });
});
