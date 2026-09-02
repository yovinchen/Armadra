import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const fetchAgents = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: { agents: () => fetchAgents() },
}));

const runCanvasCommand = vi.fn();
vi.mock("../canvas/commands", () => ({
  runCanvasCommand: (id: string) => runCanvasCommand(id),
  registerCanvasCommand: () => () => undefined,
}));

import { installDomPolyfills, TestProviders } from "./test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { isMacPlatform } from "../keybindings";
import { SCM_COMMIT_EVENT, useCommandDispatch } from "./commands";
import { useAppKeybindings } from "./use-app-keybindings";

installDomPolyfills();
afterEach(cleanup);

function Harness() {
  useAppKeybindings(useCommandDispatch());
  return null;
}

function press(key: string, extra: Partial<KeyboardEventInit> = {}) {
  const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
  fireEvent.keyDown(window, { key, ...mod, ...extra });
}

describe("useAppKeybindings", () => {
  beforeEach(() => {
    fetchAgents.mockReset().mockResolvedValue([]);
    runCanvasCommand.mockReset();
    useCanvasStore.setState({
      panels: {
        sidebar: "open",
        explorer: "closed",
        scm: "closed",
        settings: false,
        palette: false,
      },
    });
    render(
      <TestProviders>
        <Harness />
      </TestProviders>,
    );
  });

  it("⌘K 开关命令面板", () => {
    press("k");
    expect(useCanvasStore.getState().panels.palette).toBe(true);
    press("k");
    expect(useCanvasStore.getState().panels.palette).toBe(false);
  });

  it("⌘, 打开设置", () => {
    press(",");
    expect(useCanvasStore.getState().panels.settings).toBe(true);
  });

  it("面板类命令映射到 setPanel", () => {
    press("e", { shiftKey: true });
    expect(useCanvasStore.getState().panels.explorer).toBe("drawer");
    press("g", { shiftKey: true });
    expect(useCanvasStore.getState().panels.scm).toBe("drawer");
    press("l", { shiftKey: true });
    expect(useCanvasStore.getState().panels.sidebar).toBe("collapsed");
    press("l", { shiftKey: true });
    expect(useCanvasStore.getState().panels.sidebar).toBe("open");
  });

  it("画布类命令转发给 runCanvasCommand", () => {
    press("z");
    expect(runCanvasCommand).toHaveBeenCalledWith("canvas.undo");
  });

  it("⌘⏎ 打开源码控制抽屉并广播提交事件", () => {
    const listener = vi.fn();
    window.addEventListener(SCM_COMMIT_EVENT, listener);
    press("Enter");
    expect(useCanvasStore.getState().panels.scm).toBe("drawer");
    expect(listener).toHaveBeenCalled();
    window.removeEventListener(SCM_COMMIT_EVENT, listener);
  });
});
