import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  urls: [] as string[],
  close: vi.fn(),
  getTerminal: vi.fn(),
  createTerminal: vi.fn(),
  wakeTerminal: vi.fn(),
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
  terminalWebSocketUrl: (sessionId: string) => `ws://runtime/${sessionId}`,
  runtimeApi: {
    getTerminal: (...args: unknown[]) => fixture.getTerminal(...args),
    createTerminal: (...args: unknown[]) => fixture.createTerminal(...args),
    wakeTerminal: (...args: unknown[]) => fixture.wakeTerminal(...args),
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
    url: string,
    handlers: TerminalTransportHandlers,
  ) => {
    fixture.urls.push(url);
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
  fixture.urls = [];
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

describe("core 替节点起的会话", () => {
  it("节点数据换了会话 id，挂着的表面跟过去，不新建也不重敲启动行", async () => {
    const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
    const view = render(
      <TerminalSurface
        nodeId="node"
        data={fixture.data}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() => expect(fixture.urls).toEqual(["ws://runtime/session"]));
    act(() => fixture.handlers!.onHello!(hello));
    // 旧会话退出：表面停在「已退出」。
    act(() => fixture.handlers!.onStatus!("exited", 0));
    expect(changed.mock.calls.at(-1)?.[0].connection).toBe("exited");

    // 冷启动写回节点数据，合并进 store 后作为新的 data 传进来。
    const next = { kind: "terminal", sessionId: "cold" } as TerminalNodeData;
    view.rerender(
      <TerminalSurface
        nodeId="node"
        data={next}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() =>
      expect(fixture.urls).toEqual([
        "ws://runtime/session",
        "ws://runtime/cold",
      ]),
    );
    act(() =>
      fixture.handlers!.onHello!({
        ...hello,
        sessionId: "cold",
        generation: 1,
      }),
    );
    expect(changed.mock.calls.at(-1)?.[0].connection).toBe("live");
    expect(fixture.createTerminal).not.toHaveBeenCalled();
  });

  it("节点数据没变时不因手里的会话不同而被拽回去", async () => {
    // 挂载时 `find` 找到的是比节点数据更新的那个会话。
    fixture.getTerminal.mockImplementation(async () => ({
      id: "newer",
      workspaceId: "workspace",
      shell: "/bin/sh",
      generation: 1,
      status: "running",
      command: null,
      agentId: null,
    }));
    const view = render(
      <TerminalSurface nodeId="node" data={fixture.data} collapsed={false} />,
    );
    await waitFor(() => expect(fixture.urls.at(-1)).toBe("ws://runtime/newer"));
    const seen = [...fixture.urls];
    // 改标题之类的重渲：data 是新对象，但会话 id 没变。
    view.rerender(
      <TerminalSurface
        nodeId="node"
        data={{ ...fixture.data, title: "renamed" } as TerminalNodeData}
        collapsed={false}
      />,
    );
    await act(async () => {});
    expect(fixture.urls).toEqual(seen);
  });
});

describe("节能休眠", () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    cwd: "/repo",
    shell: "/bin/sh",
    command: null,
    exitCode: null,
    createdAt: "2026-09-26T00:00:00Z",
    endedAt: null,
  };

  it("读到休眠的会话不新建、不连 socket；点一下唤醒后照原样重连", async () => {
    fixture.data = { kind: "terminal", sessionId: row.id };
    fixture.getTerminal.mockImplementation(async () => ({
      ...row,
      status: "terminated",
      generation: 1,
      hibernation: "hibernated",
    }));
    fixture.wakeTerminal.mockImplementation(async () => {
      // 醒来之后那一行就是 running 了，挂载时的那次读也会这么答。
      fixture.getTerminal.mockImplementation(async () => ({
        ...row,
        status: "running",
        generation: 2,
        hibernation: null,
      }));
      return { ...row, status: "running", generation: 2, hibernation: null };
    });
    const changed = vi.fn<(status: TerminalSurfaceStatus) => void>();
    render(
      <TerminalSurface
        nodeId="node"
        data={fixture.data}
        collapsed={false}
        onStatusChange={changed}
      />,
    );
    await waitFor(() =>
      expect(changed.mock.calls.at(-1)?.[0].render).toBe("hibernated"),
    );
    // 挂载时抢先连上的那一条已经收掉；没有人去建第二个 PTY。
    expect(fixture.createTerminal).not.toHaveBeenCalled();
    fixture.handlers = null;

    fireEvent.click(screen.getByRole("button", { name: "唤醒" }));
    await waitFor(() =>
      expect(fixture.wakeTerminal).toHaveBeenCalledWith(row.id),
    );
    await waitFor(() => expect(fixture.handlers).not.toBeNull());
    expect(fixture.wakeTerminal).toHaveBeenCalledTimes(1);
    expect(fixture.createTerminal).not.toHaveBeenCalled();
    expect(changed.mock.calls.at(-1)?.[0].hibernation ?? null).toBeNull();
  });

  /**
   * 挂载时按节点数据里的会话 id 抢先连上的那条 socket，core 会答「没在跑」。
   * 这一帧要是落在「读到休眠」之后、那条连接收掉之前，以前会把表面改成
   * 「已退出」，节点上只剩「重新运行」——点下去就另起一个会话，休眠的那段
   * 再也接不回来（实浏览器探针里打开带休眠节点的画布时稳定复现）。
   */
  it("抢先连上的那条 socket 晚到的「已退出」不盖掉休眠", async () => {
    fixture.data = { kind: "terminal", sessionId: row.id };
    let answer: (value: unknown) => void = () => {};
    fixture.getTerminal.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
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
    const early = fixture.handlers!;
    await act(async () => {
      answer({
        ...row,
        status: "terminated",
        generation: 1,
        hibernation: "hibernated",
      });
      await Promise.resolve();
      await Promise.resolve();
      early.onHello!({ ...hello, sessionId: row.id, alive: false });
      early.onStatus!("exited", null);
    });
    expect(changed.mock.calls.at(-1)?.[0].render).toBe("hibernated");
    expect(screen.getByRole("button", { name: "唤醒" })).toBeTruthy();
    expect(fixture.createTerminal).not.toHaveBeenCalled();
  });
});
