import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  control,
  hasBrowserBridge,
  isDriven,
  registerGuest,
  reportView,
  useDrive,
  type DriveCommand,
} from "./drive";

/**
 * 页面这一侧的驱动通道（W3.4）。
 *
 * 这里钉的是**页面自己能决定的那几件事**：按 nodeId 过滤、Stop 真的走出去、
 * 注册和注销成对。真正的驱动在主进程，CDP 白名单和冻结脚本表的用例在
 * `apps/desktop/src/shell-core/browser/`——两边测两次的是不同的东西。
 */

let listener: ((command: DriveCommand) => void) | null = null;
const calls = {
  register: vi.fn(async () => ({ ok: true })),
  unregister: vi.fn(async () => ({ ok: true })),
  view: vi.fn(async () => ({ ok: true })),
  control: vi.fn(async () => ({ ok: true })),
};

function installBridge(): void {
  Object.defineProperty(window, "armadra", {
    configurable: true,
    value: {
      browser: {
        ...calls,
        onDrive: (next: (command: DriveCommand) => void) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
      },
    },
  });
}

afterEach(() => {
  listener = null;
  for (const call of Object.values(calls)) call.mockClear();
  Reflect.deleteProperty(window, "armadra");
});

describe("without the shell", () => {
  it("does nothing at all", async () => {
    expect(hasBrowserBridge()).toBe(false);
    // Every entry point is a no-op rather than a throw: the same components
    // render in a plain browser and in the Tauri shell, where there is no
    // bridge and no guest to register.
    expect(registerGuest({} as never)).toBeTypeOf("function");
    expect(() => reportView({} as never)).not.toThrow();
    expect(await control("b1", "takeover")).toBe(false);
  });
});

describe("useDrive", () => {
  it("only acts on commands aimed at this node", () => {
    installBridge();
    const handlers = {
      onSwitchTab: vi.fn(),
      onOpenTab: vi.fn(),
      onCloseTab: vi.fn(),
    };
    renderHook(() => useDrive("b1", handlers));

    act(() => {
      listener?.({ kind: "tabs", nodeId: "b2", action: "switch", tabId: "t9" });
    });
    expect(handlers.onSwitchTab).not.toHaveBeenCalled();

    act(() => {
      listener?.({ kind: "tabs", nodeId: "b1", action: "switch", tabId: "t2" });
    });
    expect(handlers.onSwitchTab).toHaveBeenCalledWith("t2");
  });

  it("turns each tab action into the one thing only the page can do", () => {
    installBridge();
    const handlers = {
      onSwitchTab: vi.fn(),
      onOpenTab: vi.fn(),
      onCloseTab: vi.fn(),
    };
    renderHook(() => useDrive("b1", handlers));
    act(() => {
      listener?.({
        kind: "tabs",
        nodeId: "b1",
        action: "new",
        url: "https://example.test/x",
      });
      listener?.({ kind: "tabs", nodeId: "b1", action: "close", tabId: "t3" });
      // A popup the main process denied: it becomes a tab on the canvas
      // instead of a window outside every rule on this page.
      listener?.({ kind: "popup", nodeId: "b1", url: "https://example.test/p" });
    });
    expect(handlers.onOpenTab).toHaveBeenNthCalledWith(1, "https://example.test/x");
    expect(handlers.onCloseTab).toHaveBeenCalledWith("t3");
    expect(handlers.onOpenTab).toHaveBeenNthCalledWith(2, "https://example.test/p");
  });

  it("hands the lease through, and suppresses discard while an agent holds it", () => {
    installBridge();
    const handlers = {
      onSwitchTab: vi.fn(),
      onOpenTab: vi.fn(),
      onCloseTab: vi.fn(),
    };
    const view = renderHook(() => useDrive("b1", handlers));
    expect(view.result.current).toBeUndefined();
    expect(isDriven(view.result.current)).toBe(false);

    act(() => {
      listener?.({
        kind: "lease",
        nodeId: "b1",
        lease: {
          state: "agent",
          generation: 3,
          expiresAt: "",
          holder: { kind: "agent", id: "a1", displayName: "Claude" },
        },
      });
    });
    expect(view.result.current?.state).toBe("agent");
    // The discard timer reads this: reclaiming a driven guest destroys the
    // target, and every ref the last read handed out dies with it.
    expect(isDriven(view.result.current)).toBe(true);

    act(() => {
      listener?.({
        kind: "lease",
        nodeId: "b1",
        lease: { state: "humanTakeover", generation: 4, expiresAt: "" },
      });
    });
    // A person driving is not "driven" for the discard rule — that exemption
    // is about an agent mid-task, and a person who walked away for five
    // minutes is exactly whose guest may be released.
    expect(isDriven(view.result.current)).toBe(false);
  });

  it("unsubscribes when the node goes away", () => {
    installBridge();
    const view = renderHook(() =>
      useDrive("b1", {
        onSwitchTab: vi.fn(),
        onOpenTab: vi.fn(),
        onCloseTab: vi.fn(),
      }),
    );
    expect(listener).not.toBeNull();
    view.unmount();
    expect(listener).toBeNull();
  });
});

describe("registration", () => {
  it("registers a guest and hands back its own undo", async () => {
    installBridge();
    const release = registerGuest({
      webContentsId: 7,
      nodeId: "b1",
      tabId: "t1",
      surface: "canvas",
      active: true,
      hostX: 20,
      hostY: 20,
    });
    expect(calls.register).toHaveBeenCalledWith(
      expect.objectContaining({ webContentsId: 7, nodeId: "b1", active: true }),
    );
    release();
    expect(calls.unregister).toHaveBeenCalledWith(7);
  });

  it("reports the geometry only the page knows", () => {
    installBridge();
    reportView({ webContentsId: 7, hostX: 20, hostY: 20, zoom: 2 });
    expect(calls.view).toHaveBeenCalledWith({
      webContentsId: 7,
      hostX: 20,
      hostY: 20,
      zoom: 2,
    });
  });
});

describe("Stop", () => {
  it("travels on to the lease machine rather than stopping at a component", async () => {
    installBridge();
    expect(await control("b1", "takeover")).toBe(true);
    // The two things a Stop must do — drop ownership and detach the debugger —
    // both happen on the far side. A Stop that only hid the badge would leave
    // a debugger attached to a page the person believes they took back.
    expect(calls.control).toHaveBeenCalledWith({
      nodeId: "b1",
      action: "takeover",
    });
  });
});
