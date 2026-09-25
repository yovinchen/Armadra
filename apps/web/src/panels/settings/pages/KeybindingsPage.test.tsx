import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const fetchSettings = vi.fn();
const patchSettings = vi.fn();

vi.mock("../../../api/client", () => ({
  runtimeApi: {
    settings: () => fetchSettings(),
    updateSettings: (patch: unknown) => patchSettings(patch),
    /** 设置页经归属网关路由：探不到归属，整个域就是只读的。 */
  },
}));

/** 六个域都由 Runtime 写、都已落定；设置页只看 `settings` 那一行。 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { installDomPolyfills, TestProviders } from "../../../app/test-harness";
import { translate } from "../../../i18n";
import {
  formatKeys,
  isMacPlatform,
  useKeybindings,
} from "../../../keybindings";
import { useDeviceKeymapStore } from "../device-keymap-store";
import { currentPlatform, emptyKeymap, otherPlatform } from "../keymap";
import { KeybindingsPage } from "./KeybindingsPage";

installDomPolyfills();
afterEach(cleanup);

function zh(key: string) {
  return translate("zh-CN", key);
}

const here = currentPlatform();
const elsewhere = otherPlatform(here);

function documentWith(keymap: Record<string, unknown>) {
  return {
    terminal: { backend: "auto", detachedGraceMinutes: 1440 },
    keymap,
  };
}

/** 命令面板那一行的键位按钮。 */
function paletteChip() {
  return screen.getByLabelText(zh("cmd.app.commandPalette"), {
    selector: "button",
  });
}

/** 命令面板那一行的重置按钮名（含它会落到的键位）。 */
function resetLabel() {
  return new RegExp(
    zh("settings.shortcut.reset")
      .replace("{command}", zh("cmd.app.commandPalette"))
      .replace("{keys}", ".*"),
  );
}

/**
 * 打开的对话框。整页有上百个按钮，按角色查询要给每个元素算可访问名与可见性，
 * 整套并行跑时单条用例就能吃掉数秒；先用 aria-label（便宜的属性匹配）找到
 * 对话框里的一个控件，之后的角色查询只在对话框里做。
 */
function dialogOf(control: HTMLElement) {
  return within(control.closest<HTMLElement>('[role="dialog"]')!);
}

/** 那一行里显示的来源（默认 / 全局 / 本设备）。 */
function paletteSource() {
  return paletteChip().closest(".settings-row")!.textContent ?? "";
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

const mod = () => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });

// 每条用例都挂整页：上百条命令、每行一个下拉菜单，React 开发模式下单是挂载
// 与重渲染就占了大半时间，查询已经尽量走属性匹配（见 dialogOf）。单独跑一条
// 两三百毫秒，整套并行、机器负载很高时会被拉长好几倍，给这一组放宽预算。
describe("KeybindingsPage", { timeout: 15_000 }, () => {
  beforeEach(() => {
    runPalette.mockReset();
    useDeviceKeymapStore.setState({ keymap: emptyKeymap() });
    fetchSettings.mockReset().mockResolvedValue(documentWith({}));
    patchSettings
      .mockReset()
      .mockImplementation((patch: { keymap: Record<string, unknown> }) =>
        Promise.resolve(documentWith(patch.keymap)),
      );
  });

  it("录制只写当前平台那一格，另一个平台保持原样", async () => {
    view();
    fireEvent.click(
      await screen.findByLabelText(zh("cmd.app.commandPalette"), {
        selector: "button",
      }),
    );
    expect(screen.getByText(zh("settings.shortcut.recording"))).toBeTruthy();

    // 主修饰键在 mac 上是 ⌘、其它平台是 Ctrl；两边都该录成 `Mod`。
    fireEvent.keyDown(window, {
      key: "j",
      code: "KeyJ",
      shiftKey: true,
      ...mod(),
    });

    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { [here]: { "app.commandPalette": "Mod+Shift+J" } },
      }),
    );
    const patch = patchSettings.mock.calls[0]![0] as {
      keymap: Record<string, unknown>;
    };
    expect(patch.keymap[elsewhere]).toBeUndefined();
    expect(screen.queryByText(zh("settings.shortcut.recording"))).toBeNull();
  });

  it("选「本设备」后录制只落在本机，不写 Runtime 设置", async () => {
    view();
    await screen.findByLabelText(zh("cmd.app.commandPalette"), {
      selector: "button",
    });
    fireEvent.click(screen.getByText(zh("settings.shortcut.source.global")));
    fireEvent.click(
      await screen.findByRole("option", {
        name: zh("settings.shortcut.source.device"),
      }),
    );
    fireEvent.click(paletteChip());
    fireEvent.keyDown(window, {
      key: "j",
      code: "KeyJ",
      shiftKey: true,
      ...mod(),
    });

    await waitFor(() =>
      expect(
        useDeviceKeymapStore.getState().keymap[here]["app.commandPalette"],
      ).toBe("Mod+Shift+J"),
    );
    expect(patchSettings).not.toHaveBeenCalled();
    expect(paletteSource()).toContain(zh("settings.shortcut.source.device"));
  });

  it("重置一次落回全局，再重置才回默认", async () => {
    fetchSettings.mockResolvedValue(
      documentWith({ [here]: { "app.commandPalette": "Mod+Shift+P" } }),
    );
    useDeviceKeymapStore.setState({
      keymap: {
        ...emptyKeymap(),
        [here]: { "app.commandPalette": "Mod+Shift+J" },
      },
    });
    view();
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.device")),
    );
    const reset = () =>
      screen.getByLabelText(resetLabel(), { selector: "button" });

    fireEvent.click(reset());
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.global")),
    );
    expect(patchSettings).not.toHaveBeenCalled();

    fireEvent.click(reset());
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { [here]: { "app.commandPalette": null } },
      }),
    );
  });

  it("Backspace 重置当前层，Esc 什么都不写", async () => {
    view();
    fireEvent.click(
      await screen.findByLabelText(zh("cmd.app.commandPalette"), {
        selector: "button",
      }),
    );
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(screen.queryByText(zh("settings.shortcut.recording"))).toBeNull();
    expect(patchSettings).not.toHaveBeenCalled();

    fetchSettings.mockResolvedValue(
      documentWith({ [here]: { "app.commandPalette": "Mod+Shift+P" } }),
    );
    cleanup();
    view();
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.global")),
    );
    fireEvent.click(paletteChip());
    fireEvent.keyDown(window, { key: "Backspace", code: "Backspace" });
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { [here]: { "app.commandPalette": null } },
      }),
    );
  });

  it("另一个平台是只读预览，看得到它自己的键位", async () => {
    fetchSettings.mockResolvedValue(
      documentWith({ [elsewhere]: { "app.commandPalette": "Mod+Shift+P" } }),
    );
    view();
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.default")),
    );
    fireEvent.click(screen.getByText(zh(`settings.shortcut.platform.${here}`)));
    fireEvent.click(
      await screen.findByRole("option", {
        name: zh(`settings.shortcut.platform.${elsewhere}`),
      }),
    );
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.global")),
    );
    expect(
      screen.getByText(zh("settings.shortcut.platform.preview")),
    ).toBeTruthy();
    // 录制与重置在预览下都不可用：抓到的是本机的物理键。
    expect((paletteChip() as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.queryByLabelText(resetLabel(), { selector: "button" }),
    ).toBeNull();
  });

  it("录制现有命令组合时不先运行该命令，结束后恢复快捷键", async () => {
    view();
    fireEvent.click(
      await screen.findByLabelText(zh("cmd.app.commandPalette"), {
        selector: "button",
      }),
    );
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ...mod() });
    expect(runPalette).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { [here]: { "app.commandPalette": "Mod+K" } },
      }),
    );
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ...mod() });
    expect(runPalette).toHaveBeenCalledOnce();
  });

  it("录制不拦截关闭窗口且不写入窗口快捷键", async () => {
    view();
    fireEvent.click(
      await screen.findByLabelText(zh("cmd.app.commandPalette"), {
        selector: "button",
      }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      cancelable: true,
      ...mod(),
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(patchSettings).not.toHaveBeenCalled();
  });

  /**
   * 冲突不自动改判谁赢：两条都挂 Badge，用户看得见才改得动。
   */
  it("冲突看的是三层合并之后的结果", async () => {
    fetchSettings.mockResolvedValue(
      documentWith({ [here]: { "canvas.tidy": "Mod+Z" } }),
    );
    view();
    await waitFor(() =>
      expect(
        screen.getAllByText(zh("settings.shortcut.conflict")),
      ).toHaveLength(2),
    );
    // 本设备把它挪开之后冲突就消失了。
    useDeviceKeymapStore.setState({
      keymap: { ...emptyKeymap(), [here]: { "canvas.tidy": "Mod+Alt+K" } },
    });
    await waitFor(() =>
      expect(screen.queryByText(zh("settings.shortcut.conflict"))).toBeNull(),
    );
  });

  it("全部重置清掉两层覆盖", async () => {
    fetchSettings.mockResolvedValue(
      documentWith({ [here]: { "app.commandPalette": "Mod+Shift+P" } }),
    );
    useDeviceKeymapStore.setState({
      keymap: { ...emptyKeymap(), [here]: { "canvas.tidy": "Mod+Alt+K" } },
    });
    view();
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.global")),
    );
    fireEvent.click(screen.getByText(zh("settings.shortcut.resetAll")));
    expect(useDeviceKeymapStore.getState().keymap).toEqual(emptyKeymap());
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: {
          mac: here === "mac" ? { "app.commandPalette": null } : {},
          other: here === "other" ? { "app.commandPalette": null } : {},
        },
      }),
    );
  });

  it("导出的是覆盖，导入整体替换两层", async () => {
    fetchSettings.mockResolvedValue(
      documentWith({ [here]: { "app.commandPalette": "Mod+Shift+P" } }),
    );
    view();
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.global")),
    );
    fireEvent.click(screen.getByText(zh("settings.shortcut.transfer")));
    const area = screen.getByLabelText(zh("settings.shortcut.transfer"), {
      selector: "textarea",
    }) as HTMLTextAreaElement;
    const exported = JSON.parse(area.value);
    expect(exported.global[here]["app.commandPalette"]).toBe("Mod+Shift+P");
    // 默认键位不进导出文件。
    expect(exported.global[here]["canvas.newTerminal"]).toBeUndefined();

    fireEvent.change(area, {
      target: {
        value: JSON.stringify({
          version: 1,
          global: { [here]: { "canvas.tidy": "Mod+Alt+K" } },
          device: { [here]: { "canvas.undo": "Mod+Alt+Z" } },
        }),
      },
    });
    fireEvent.click(
      dialogOf(area).getByRole("button", {
        name: zh("settings.shortcut.import.apply"),
      }),
    );
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: expect.objectContaining({
          [here]: {
            "app.commandPalette": null,
            "canvas.tidy": "Mod+Alt+K",
          },
        }),
      }),
    );
    expect(useDeviceKeymapStore.getState().keymap[here]["canvas.undo"]).toBe(
      "Mod+Alt+Z",
    );
  });

  it("换配置档换的是全局那一层，各档的修改互不覆盖", async () => {
    fetchSettings.mockResolvedValue(
      documentWith({
        profile: "vscode",
        [here]: { "canvas.tidy": "Mod+Alt+K" },
        profiles: { vscode: { [here]: { "canvas.undo": "Mod+Alt+Z" } } },
      }),
    );
    view();
    // VS Code 档的预设：命令面板是 ⌘⇧P，来源写「配置档」而不是「全局」。
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.profile")),
    );
    // 默认档里改的那条在这个档里不生效。
    const tidy = screen
      .getByLabelText(zh("cmd.canvas.tidy"), { selector: "button" })
      .closest(".settings-row")!.textContent;
    expect(tidy).toContain(zh("settings.shortcut.source.default"));
  });

  it("预设那一行没有重置按钮：它不是谁的覆盖", async () => {
    fetchSettings.mockResolvedValue(documentWith({ profile: "vscode" }));
    view();
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.profile")),
    );
    expect(
      screen.queryByLabelText(resetLabel(), { selector: "button" }),
    ).toBeNull();
  });

  it("写入落在当前档里，不落在一张全局表上", async () => {
    fetchSettings.mockResolvedValue(documentWith({ profile: "vscode" }));
    view();
    fireEvent.click(
      await screen.findByLabelText(zh("cmd.canvas.tidy"), {
        selector: "button",
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "j",
        code: "KeyJ",
        shiftKey: true,
        cancelable: true,
        bubbles: true,
        ...mod(),
      }),
    );
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: {
          profiles: { vscode: { [here]: { "canvas.tidy": "Mod+Shift+J" } } },
        },
      }),
    );
  });

  it("编辑器与浏览器节点各有一节，系统热键在浏览器里整节不显示", async () => {
    view();
    for (const scope of ["editor", "browser"])
      expect(
        await screen.findByText(zh(`settings.scope.${scope}`)),
      ).toBeTruthy();
    // 全局热键要靠桌面壳向系统注册。在浏览器里显示一组按了没反应的键位，
    // 比不显示更糟。
    expect(screen.queryByText(zh("settings.scope.global"))).toBeNull();
    expect(
      screen.queryByLabelText(zh("cmd.global.toggleWindow"), {
        selector: "button",
      }),
    ).toBeNull();
  });

  it("录制期间的按键不会顺带触发默认行为", async () => {
    view();
    fireEvent.click(
      await screen.findByLabelText(zh("cmd.app.commandPalette"), {
        selector: "button",
      }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "j",
      code: "KeyJ",
      shiftKey: true,
      cancelable: true,
      bubbles: true,
      ...mod(),
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(patchSettings).toHaveBeenCalled());
    expect(paletteChip()).toBeTruthy();
  });

  it("设为无写一条空串覆盖，与没覆盖分得开，重置能退回默认", async () => {
    view();
    await screen.findByLabelText(zh("cmd.app.commandPalette"), {
      selector: "button",
    });
    await pick(zh("settings.shortcut.clear"));
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { [here]: { "app.commandPalette": "" } },
      }),
    );
    // 来源是「全局」而不是「默认」，键位写「未绑定」，↺ 还在。
    await waitFor(() =>
      expect(paletteSource()).toContain(zh("settings.shortcut.source.global")),
    );
    expect(paletteChip().textContent).toContain(
      zh("settings.shortcut.unbound"),
    );
    fireEvent.click(
      screen.getByLabelText(resetLabel(), { selector: "button" }),
    );
    await waitFor(() =>
      expect(patchSettings).toHaveBeenLastCalledWith({
        keymap: { [here]: { "app.commandPalette": null } },
      }),
    );
  });

  it("再录一组替代键加在末尾，不替换原来那组", async () => {
    view();
    await screen.findByLabelText(zh("cmd.app.commandPalette"), {
      selector: "button",
    });
    await pick(zh("settings.shortcut.add"));
    expect(screen.getByText(zh("settings.shortcut.recording"))).toBeTruthy();
    fireEvent.keyDown(window, {
      key: "j",
      code: "KeyJ",
      shiftKey: true,
      ...mod(),
    });
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { [here]: { "app.commandPalette": "Mod+K,Mod+Shift+J" } },
      }),
    );
  });

  it("多组键逐组移除，每组都参与冲突检测", async () => {
    fetchSettings.mockResolvedValue(
      documentWith({ [here]: { "app.commandPalette": "Mod+Alt+K,Mod+Z" } }),
    );
    view();
    // 第二组撞上撤销：两条都挂冲突。
    await waitFor(() =>
      expect(
        screen.getAllByText(zh("settings.shortcut.conflict")),
      ).toHaveLength(2),
    );
    await pick(
      zh("settings.shortcut.removeOne").replace(
        "{keys}",
        formatKeys("Mod+Z", { mac: here === "mac" }),
      ),
    );
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { [here]: { "app.commandPalette": "Mod+Alt+K" } },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText(zh("settings.shortcut.conflict"))).toBeNull(),
    );
  });

  it("条件按已有语法校验，写错时说明原因且不能保存", async () => {
    view();
    await screen.findByLabelText(zh("cmd.app.commandPalette"), {
      selector: "button",
    });
    await pick(zh("settings.shortcut.when.edit"));
    const input = await screen.findByLabelText(zh("settings.shortcut.when"), {
      selector: "input",
    });
    const dialog = dialogOf(input);
    const save = () =>
      dialog.getByRole("button", {
        name: zh("settings.shortcut.when.save"),
      }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "editorFocus &&" } });
    expect(dialog.getByRole("alert").textContent).toBe(
      zh("settings.shortcut.when.syntax"),
    );
    expect(save().disabled).toBe(true);

    fireEvent.change(input, { target: { value: "editorFocuss" } });
    expect(dialog.getByRole("alert").textContent).toContain("editorFocuss");
    expect(save().disabled).toBe(true);

    fireEvent.change(input, { target: { value: " editorFocus " } });
    expect(dialog.queryByRole("alert")).toBeNull();
    fireEvent.click(save());
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { when: { "app.commandPalette": "editorFocus" } },
      }),
    );
    // 改过的条件写在那一行上。
    await waitFor(() => expect(paletteSource()).toContain("editorFocus"));
  });

  it("恢复默认条件删掉那一条覆盖", async () => {
    fetchSettings.mockResolvedValue(
      documentWith({ when: { "app.commandPalette": "editorFocus" } }),
    );
    view();
    await waitFor(() => expect(paletteSource()).toContain("editorFocus"));
    await pick(zh("settings.shortcut.when.edit"));
    const input = await screen.findByLabelText(zh("settings.shortcut.when"), {
      selector: "input",
    });
    fireEvent.click(
      dialogOf(input).getByRole("button", {
        name: zh("settings.shortcut.when.reset"),
      }),
    );
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        keymap: { when: { "app.commandPalette": null } },
      }),
    );
  });
});

/** 打开命令面板那一行的「更多」菜单，点其中一项。 */
async function pick(item: string) {
  const trigger = screen.getByLabelText(
    zh("settings.shortcut.more").replace(
      "{command}",
      zh("cmd.app.commandPalette"),
    ),
    { selector: "button" },
  );
  fireEvent.pointerDown(
    trigger,
    new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
  // 菜单项按文字找再确认角色：整页的角色查询太贵（见 dialogOf）。
  fireEvent.click(
    await screen.findByText(item, { selector: '[role="menuitem"]' }),
  );
}
