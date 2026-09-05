import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const fetchSettings = vi.fn();
const patchSettings = vi.fn();

vi.mock("../../../api/client", () => ({
  runtimeApi: {
    settings: () => fetchSettings(),
    updateSettings: (patch: unknown) => patchSettings(patch),
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { installDomPolyfills, TestProviders } from "../../../app/test-harness";
import { translate } from "../../../i18n";
import { isMacPlatform, useKeybindings } from "../../../keybindings";
import { KeybindingsPage } from "./KeybindingsPage";

installDomPolyfills();
afterEach(cleanup);

function zh(key: string) {
  return translate("zh-CN", key);
}

function documentWith(keymap: Record<string, string>) {
  return {
    terminal: { backend: "auto", detachedGraceMinutes: 1440 },
    keymap,
  };
}

/** 命令面板那一行的键位按钮。 */
function paletteChip() {
  return screen.getByRole("button", { name: zh("cmd.app.commandPalette") });
}

const runPalette = vi.fn();
function ActiveShortcuts() {
  useKeybindings({ "app.commandPalette": runPalette });
  return null;
}
function view() {
  return render(
    <TestProviders>
      <ActiveShortcuts />
      <KeybindingsPage />
    </TestProviders>,
  );
}

describe("KeybindingsPage", () => {
  beforeEach(() => {
    runPalette.mockReset();
    fetchSettings.mockReset().mockResolvedValue(documentWith({}));
    patchSettings
      .mockReset()
      .mockImplementation((patch: { keymap: Record<string, string> }) =>
        Promise.resolve(documentWith(patch.keymap)),
      );
  });

  it("点键位进入录制态，下一个组合就是新键位", async () => {
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: zh("cmd.app.commandPalette") }),
    );
    expect(screen.getByText(zh("settings.shortcut.recording"))).toBeTruthy();

    // 主修饰键在 mac 上是 ⌘、其它平台是 Ctrl；两边都该录成 `Mod`。
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(window, {
      key: "j",
      code: "KeyJ",
      shiftKey: true,
      ...mod,
    });

    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { "app.commandPalette": "Mod+Shift+J" },
      }),
    );
    expect(screen.queryByText(zh("settings.shortcut.recording"))).toBeNull();
  });

  it("录制现有命令组合时不先运行该命令，结束后恢复快捷键", async () => {
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: zh("cmd.app.commandPalette") }),
    );
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ...mod });
    expect(runPalette).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { "app.commandPalette": "Mod+K" },
      }),
    );
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ...mod });
    expect(runPalette).toHaveBeenCalledOnce();
  });

  it("录制不拦截关闭窗口且不写入窗口快捷键", async () => {
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: zh("cmd.app.commandPalette") }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      cancelable: true,
      ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true }),
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(patchSettings).not.toHaveBeenCalled();
  });

  it("Esc 取消录制，什么都不写", async () => {
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: zh("cmd.app.commandPalette") }),
    );
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(screen.queryByText(zh("settings.shortcut.recording"))).toBeNull();
    expect(patchSettings).not.toHaveBeenCalled();
  });

  it("Backspace 把这条键位删回默认", async () => {
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: zh("cmd.app.commandPalette") }),
    );
    fireEvent.keyDown(window, { key: "Backspace", code: "Backspace" });
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { "app.commandPalette": null },
      }),
    );
  });

  /**
   * 冲突不自动改判谁赢：两条都挂 Badge，用户看得见才改得动。
   */
  it("同一 scope 里撞车的两条都挂冲突 Badge", async () => {
    fetchSettings.mockResolvedValue(documentWith({ "canvas.tidy": "Mod+Z" }));
    view();
    await waitFor(() =>
      expect(
        screen.getAllByText(zh("settings.shortcut.conflict")),
      ).toHaveLength(2),
    );
  });

  it("录制期间的按键不会顺带触发默认行为", async () => {
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: zh("cmd.app.commandPalette") }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "j",
      code: "KeyJ",
      shiftKey: true,
      cancelable: true,
      bubbles: true,
      ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true }),
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(patchSettings).toHaveBeenCalled());
    expect(paletteChip()).toBeTruthy();
  });
});
