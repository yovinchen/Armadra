import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { TerminalNodeData } from "@armadra/shared";
import type { TerminalTransportHandlers } from "./transport";
import { installDomPolyfills } from "../app/test-harness";

/**
 * 后台渲染预算（终端宿主设计 §7.1）在真实表面上的行为。
 *
 * 判定逻辑本身在 `render-state.test.ts` / `render-budget.test.ts` 里钉死，
 * 这里只验两件靠纯函数验不了的事：
 *
 *  1. 窗口切到后台之后，每一帧输出**不再**写进 xterm，而是攒起来，回到前台
 *     时按原顺序一次灌完——设计里那句「不能因 `display:none` 仍让几十个终端
 *     每帧 fit 和重绘」；
 *  2. 后台待够 `HIDDEN_DETACH_MS` 会主动收掉 socket，回到前台重新 attach，
 *     **不新建会话**。
 */

const fixture = vi.hoisted(() => ({
  data: { kind: "terminal", sessionId: "session" } as TerminalNodeData,
  handlers: null as TerminalTransportHandlers | null,
  writes: [] as string[],
  close: vi.fn(),
  getTerminal: vi.fn(),
  createTerminal: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({
      workspace: { id: "workspace", rootPath: "/repo" },
      document: {
        board: { id: "board" },
        nodes: [{ id: "node", data: fixture.data }],
      },
      updateNodeData: vi.fn(),
      updateNode: vi.fn(),
    }),
  },
}));
vi.mock("@/api/client", () => ({
  RUNTIME_URL: "http://runtime",
  terminalWebSocketUrl: () => "ws://runtime/session",
  runtimeApi: {
    getTerminal: (...args: unknown[]) => fixture.getTerminal(...args),
    createTerminal: (...args: unknown[]) => fixture.createTerminal(...args),
    agents: vi.fn(async () => []),
  },
}));
vi.mock("@/agent/status-store", () => ({
  useAgentStatusStore: {
    getState: () => ({ statuses: {}, markRead: vi.fn() }),
  },
}));
vi.mock("@/agent/pending-launch", () => ({
  armPendingLaunch: vi.fn(),
  usePendingLaunchWatcher: vi.fn(),
  usePendingLaunchStore: { getState: () => ({ entries: {} }) },
  disarmPendingLaunch: vi.fn(),
}));
vi.mock("./platform", () => ({
  runtimePlatform: () => "unix",
  loadRuntimePlatform: async () => "unix",
}));
vi.mock("./transport", () => ({
  createTerminalTransport: (
    _url: string,
    handlers: TerminalTransportHandlers,
  ) => {
    fixture.handlers = handlers;
    return {
      state: "live",
      generation: 3,
      input: vi.fn(),
      resize: vi.fn(),
      close: fixture.close,
      terminate: vi.fn(),
    };
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    unicode = { activeVersion: "" };
    textarea = undefined;
    loadAddon() {}
    open() {}
    reset() {}
    write(chunk: string) {
      fixture.writes.push(chunk);
    }
    dispose() {}
    focus() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    onBell() {
      return { dispose() {} };
    }
    onTitleChange() {
      return { dispose() {} };
    }
    hasSelection() {
      return false;
    }
    paste() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    fit() {}
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));

import { HIDDEN_DETACH_MS } from "./render-state";
import { resetRenderBudget } from "./render-budget";
import { TerminalSurface, type TerminalSurfaceStatus } from "./TerminalSurface";

installDomPolyfills();

/** jsdom 里 `document.hidden` 是只读的；换掉它再手动派发一次事件。 */
function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

const hello = {
  sessionId: "session",
  generation: 3,
  backend: "direct" as const,
  rows: 24,
  cols: 80,
  alive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRenderBudget();
  fixture.data = { kind: "terminal", sessionId: "session" };
  fixture.handlers = null;
  fixture.writes = [];
  fixture.getTerminal.mockImplementation(async () => ({
    id: "session",
    workspaceId: "workspace",
    shell: "/bin/sh",
    generation: 3,
    status: "running",
    command: null,
    agentId: null,
  }));
});
afterEach(() => {
  cleanup();
  setPageHidden(false);
});

describe("离屏时的输出", () => {
  it("窗口在后台时攒着，回到前台按原顺序一次灌完", async () => {
    const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
    render(
      <TerminalSurface
        nodeId="node"
        data={fixture.data}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() => expect(fixture.handlers).not.toBeNull());
    act(() => fixture.handlers!.onHello!(hello));

    // 看得见：每一帧直接写穿。
    act(() => fixture.handlers!.onOutput!("live"));
    expect(fixture.writes).toEqual(["live"]);

    act(() => setPageHidden(true));
    act(() => fixture.handlers!.onOutput!("a"));
    act(() => fixture.handlers!.onOutput!("b"));
    act(() => fixture.handlers!.onOutput!("c"));
    // 一个字节都没进 xterm——三帧输出没有变成三次重绘。
    expect(fixture.writes).toEqual(["live"]);

    act(() => setPageHidden(false));
    expect(fixture.writes).toEqual(["live", "abc"]);

    // 没有键盘焦点，但看得见且拿到了名额：全速渲染。
    expect(changed.mock.calls.at(-1)?.[0].render).toBe("visible");
  });
});

describe("后台过久后 detach", () => {
  it("收掉 socket 再回来时重新 attach，不新建会话", async () => {
    vi.useFakeTimers();
    try {
      const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
      render(
        <TerminalSurface
          nodeId="node"
          data={fixture.data}
          collapsed={false}
          onStatusChange={changed}
        />,
      );
      // 假计时器下不能用 `waitFor`：会话查询挂在微任务上，冲两轮即可。
      await act(async () => {});
      await act(async () => {});
      expect(fixture.handlers).not.toBeNull();
      act(() => fixture.handlers!.onHello!(hello));

      act(() => setPageHidden(true));
      // 宽限期内什么都不做：切出去回条消息不该掉连接。
      act(() => vi.advanceTimersByTime(HIDDEN_DETACH_MS - 1_000));
      expect(fixture.close).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(2_000));
      expect(fixture.close).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls.at(-1)?.[0].render).toBe("detached");

      fixture.handlers = null;
      act(() => setPageHidden(false));
      await act(async () => {});
      // 重新 attach 用的是同一个 sessionId，没有人去建第二个 PTY。
      expect(fixture.handlers).not.toBeNull();
      expect(fixture.createTerminal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
