import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { TerminalNodeData } from "@armadra/shared";
import type { TerminalTransportHandlers } from "./transport";
import { installDomPolyfills } from "../app/test-harness";
import {
  createWorkspaceFileDrag,
  WORKSPACE_FILES_MIME,
  WORKSPACE_FILE_DROP_EVENT,
} from "../files/workspace-drag";

const fixture = vi.hoisted(() => ({
  data: { kind: "terminal", sessionId: "session" } as TerminalNodeData,
  handlers: null as TerminalTransportHandlers | null,
  entries: {} as Record<
    string,
    { phase: "waiting" | "sent" | "manual"; attempts: number }
  >,
  statuses: {} as Record<string, unknown>,
  paste: vi.fn(),
  input: vi.fn(),
  error: vi.fn(),
  disarm: vi.fn(),
  getTerminal: vi.fn(),
  fileInfo: vi.fn(),
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
    }),
  },
}));
vi.mock("@/api/client", () => ({
  RUNTIME_URL: "http://runtime",
  terminalWebSocketUrl: () => "ws://runtime/session",
  runtimeApi: {
    getTerminal: (...args: unknown[]) => fixture.getTerminal(...args),
    fileInfo: (...args: unknown[]) => fixture.fileInfo(...args),
    listFiles: vi.fn(),
    agents: vi.fn(async () => []),
  },
}));
vi.mock("@/agent/status-store", () => ({
  useAgentStatusStore: {
    getState: () => ({ statuses: fixture.statuses, markRead: vi.fn() }),
  },
}));
vi.mock("@/agent/pending-launch", () => ({
  armPendingLaunch: vi.fn(),
  usePendingLaunchWatcher: vi.fn(),
  usePendingLaunchStore: { getState: () => ({ entries: fixture.entries }) },
  disarmPendingLaunch: (id: string) => {
    fixture.disarm(id);
    delete fixture.entries[id];
  },
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
      input: fixture.input,
      resize: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    };
  },
}));
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => fixture.error(...args) },
}));
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
    write() {}
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
    paste(text: string) {
      fixture.paste(text);
    }
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

import { TerminalSurface } from "./TerminalSurface";
installDomPolyfills();
beforeEach(() => {
  vi.clearAllMocks();
  fixture.data = { kind: "terminal", sessionId: "session" };
  fixture.entries = {};
  fixture.statuses = {};
  fixture.handlers = null;
  fixture.getTerminal.mockImplementation(async () => ({
    id: "session",
    workspaceId: "workspace",
    shell: "/bin/sh",
    generation: 3,
    status: "running",
    command: null,
    agentId: fixture.data.agent?.id ?? null,
  }));
  fixture.fileInfo.mockResolvedValue({ path: "safe file.txt" });
});
afterEach(cleanup);

async function mounted() {
  const view = render(
    <TerminalSurface nodeId="node" data={fixture.data} collapsed={false} />,
  );
  await waitFor(() => expect(fixture.handlers).not.toBeNull());
  act(() =>
    fixture.handlers!.onHello!({
      sessionId: "session",
      generation: 3,
      backend: "direct",
      rows: 24,
      cols: 80,
      alive: true,
    }),
  );
  return view.container.querySelector<HTMLElement>(
    "[data-slot=terminal-body]",
  )!;
}
function drop(target: HTMLElement, pointer = false) {
  const drag = createWorkspaceFileDrag("http://runtime", "workspace", [
    {
      path: "safe file.txt",
      name: "safe file.txt",
      kind: "file",
      size: 1,
      readonly: false,
    },
  ]);
  if (pointer) {
    fireEvent(
      target,
      new CustomEvent(WORKSPACE_FILE_DROP_EVENT, {
        bubbles: true,
        detail: { drag, point: { x: 0, y: 0 } },
      }),
    );
    return;
  }
  const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: [WORKSPACE_FILES_MIME],
      getData: () => JSON.stringify(drag),
    },
  });
  fireEvent(target, event);
}

describe("TerminalSurface file input guards", () => {
  it.each([false, true])(
    "pastes through the terminal for HTML/pointer %s without Enter",
    async (pointer) => {
      drop(await mounted(), pointer);
      await waitFor(() =>
        expect(fixture.paste).toHaveBeenCalledWith("'/repo/safe file.txt' "),
      );
      expect(fixture.input).not.toHaveBeenCalled();
    },
  );

  it("blocks a waiting Agent launch before file validation or paste", async () => {
    fixture.data.agent = {
      id: "claude",
      pendingLaunch: { command: "claude", after: ["dependency"] },
    };
    drop(await mounted());
    expect(fixture.error).toHaveBeenCalled();
    expect(fixture.fileInfo).not.toHaveBeenCalled();
    expect(fixture.paste).not.toHaveBeenCalled();
  });

  it("sees an exited status synchronously while file validation is in progress", async () => {
    const target = await mounted();
    fixture.fileInfo.mockImplementation(async () => {
      fixture.handlers!.onStatus!("exited", 0);
      return { path: "safe file.txt" };
    });
    drop(target);
    await waitFor(() => expect(fixture.error).toHaveBeenCalled());
    expect(fixture.paste).not.toHaveBeenCalled();
  });

  it("does not settle DAG retries when validation fails, but settles confirmed retries just before paste", async () => {
    fixture.data.agent = { id: "claude" };
    fixture.entries.node = { phase: "sent", attempts: 1 };
    fixture.statuses.node = {};
    const target = await mounted();
    fixture.fileInfo.mockRejectedValueOnce(new Error("missing"));
    drop(target);
    await waitFor(() => expect(fixture.error).toHaveBeenCalled());
    expect(fixture.disarm).not.toHaveBeenCalled();
    expect(fixture.paste).not.toHaveBeenCalled();
    drop(target);
    await waitFor(() => expect(fixture.paste).toHaveBeenCalledOnce());
    expect(fixture.disarm).toHaveBeenCalledWith("node");
    expect(fixture.disarm.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.paste.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects Agent changes before paste even with the same session and generation", async () => {
    fixture.data.agent = { id: "claude" };
    const target = await mounted();
    fixture.fileInfo.mockImplementation(async () => {
      fixture.data = { ...fixture.data, agent: { id: "codex" } };
      return { path: "safe file.txt" };
    });
    drop(target);
    await waitFor(() => expect(fixture.error).toHaveBeenCalled());
    expect(fixture.paste).not.toHaveBeenCalled();
  });
});
