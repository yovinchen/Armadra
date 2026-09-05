import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

const fetchAgents = vi.fn();
const fetchSettings = vi.fn();
const patchSettings = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: {
    agents: () => fetchAgents(),
    settings: () => fetchSettings(),
    updateSettings: (patch: unknown) => patchSettings(patch),
  },
}));

const runCanvasCommand = vi.fn();
vi.mock("../canvas/commands", () => ({
  runCanvasCommand: (id: string) => runCanvasCommand(id),
  registerCanvasCommand: () => () => undefined,
}));

import { installDomPolyfills, TestProviders } from "./test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { commandKeysLabel, isMacPlatform } from "../keybindings";
import { SCM_COMMIT_EVENT, useCommandDispatch } from "./commands";
import { useAppKeybindings } from "./use-app-keybindings";
import { useDeviceKeymapStore } from "../panels/settings/device-keymap-store";
import { currentPlatform, emptyKeymap } from "../panels/settings/keymap";

const here = currentPlatform();

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
    fetchSettings.mockReset().mockResolvedValue({});
    patchSettings.mockReset().mockResolvedValue({});
    useDeviceKeymapStore.setState({ keymap: emptyKeymap() });
    runCanvasCommand.mockReset();
    useCanvasStore.setState({
      panels: {
        sidebar: "open",
        explorer: "closed",
        scm: "closed",
        resources: "closed",
        automation: "closed",
        usage: "closed",
        settings: false,
        palette: false,
        quickOpen: false,
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

  /** 每个用例自己决定设置文档，所以先拆掉 beforeEach 装好的那棵树。 */
  async function remount(settings: unknown) {
    cleanup();
    fetchSettings.mockResolvedValue(settings);
    render(
      <TestProviders>
        <Harness />
      </TestProviders>,
    );
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
  }

  it("本设备覆盖压过全局，改完不用重启", async () => {
    await remount({ keymap: { [here]: { "canvas.undo": "Mod+Alt+Z" } } });
    await waitFor(() => {
      press("z", { altKey: true });
      expect(runCanvasCommand).toHaveBeenCalledWith("canvas.undo");
    });
    runCanvasCommand.mockReset();

    act(() =>
      useDeviceKeymapStore.setState({
        keymap: { ...emptyKeymap(), [here]: { "canvas.undo": "Mod+Alt+U" } },
      }),
    );
    press("z", { altKey: true });
    expect(runCanvasCommand).not.toHaveBeenCalled();
    press("u", { altKey: true });
    expect(runCanvasCommand).toHaveBeenCalledWith("canvas.undo");
  });

  it("旧的扁平键位自动迁移一次，覆盖不丢也不重复发", async () => {
    // Runtime 的合并把旧键删掉、写进两个平台，并回一份归一后的全量文档。
    patchSettings.mockResolvedValue({
      keymap: {
        mac: { "canvas.undo": "Mod+Alt+Z" },
        other: { "canvas.undo": "Mod+Alt+Z" },
      },
    });
    await remount({ keymap: { "canvas.undo": "Mod+Alt+Z" } });
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: {
          "canvas.undo": null,
          mac: { "canvas.undo": "Mod+Alt+Z" },
          other: { "canvas.undo": "Mod+Alt+Z" },
        },
      }),
    );
    // 迁移前后这台机器上按下去的效果一样。
    await waitFor(() => {
      press("z", { altKey: true });
      expect(runCanvasCommand).toHaveBeenCalledWith("canvas.undo");
    });
    expect(patchSettings).toHaveBeenCalledTimes(1);
  });

  it("菜单与命令面板显示的是生效中的键位，不是默认值", async () => {
    await remount({ keymap: { [here]: { "canvas.undo": "Mod+Alt+Z" } } });
    await waitFor(() =>
      expect(commandKeysLabel("canvas.undo")).toBe(
        isMacPlatform() ? "⌥⌘Z" : "Ctrl+Alt+Z",
      ),
    );
    act(() =>
      useDeviceKeymapStore.setState({
        keymap: { ...emptyKeymap(), [here]: { "canvas.undo": "Mod+Alt+U" } },
      }),
    );
    expect(commandKeysLabel("canvas.undo")).toBe(
      isMacPlatform() ? "⌥⌘U" : "Ctrl+Alt+U",
    );
  });

  it("已经是新格式就不发迁移请求", async () => {
    await remount({
      keymap: { mac: { "canvas.undo": "Mod+Alt+Z" }, other: {} },
    });
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    expect(patchSettings).not.toHaveBeenCalled();
  });
});
