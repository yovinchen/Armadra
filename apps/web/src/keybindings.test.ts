import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { t } from "./app/preferences-store";
import {
  COMMANDS,
  COMMAND_BY_ID,
  commandKeys,
  commandKeysLabel,
  commandsInScope,
  formatKeys,
  isTerminalTarget,
  isTypingTarget,
  isWindowShortcut,
  suspendKeybindings,
  matchKeyboardEvent,
  useKeybindings,
  type CommandId,
} from "./keybindings";

const MAC = { mac: true } as const;
const PC = { mac: false } as const;

function keydown(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe("命令表", () => {
  it("id 唯一", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条命令都有一个能翻出中文的 labelKey", () => {
    for (const command of COMMANDS) {
      expect(command.labelKey).toBe(`cmd.${command.id}`);
      expect(t(command.labelKey)).not.toBe(command.labelKey);
      expect(t(command.labelKey)).toMatch(/[一-龥]/);
    }
  });

  it("§8 列出的几条壳级命令在终端里放行，其余都进 xterm", () => {
    const allowed = COMMANDS.filter((command) => command.allowInTerminal).map(
      (command) => command.id,
    );
    expect([...allowed].sort()).toEqual(
      [
        "app.commandPalette",
        "app.explorer",
        "app.sidebar",
        "app.settings",
        "app.sourceControl",
        "canvas.closeNode",
        "terminal.search",
      ].sort(),
    );
  });

  it("撤销/重做在输入框里让给浏览器", () => {
    expect(COMMAND_BY_ID["canvas.undo"].allowWhileTyping).toBe(false);
    expect(COMMAND_BY_ID["canvas.redo"].allowWhileTyping).toBe(false);
  });

  it("提交信息输入框里的 ⌘⏎ 必须放行", () => {
    expect(COMMAND_BY_ID["scm.commit"].allowWhileTyping).toBe(true);
    expect(commandKeys("scm.commit", MAC)).toBe("Mod+Enter");
  });

  it("scope 过滤可用", () => {
    expect(commandsInScope("scm").map((command) => command.id)).toEqual([
      "scm.commit",
    ]);
    expect(commandsInScope("app").length).toBeGreaterThan(1);
  });

  it("没有两条命令在同一平台上抢同一组键", () => {
    for (const platform of [MAC, PC]) {
      const seen = new Map<string, CommandId>();
      for (const command of COMMANDS) {
        const keys = commandKeys(command.id, platform);
        if (!keys) continue;
        for (const chord of keys.split(",")) {
          const existing = seen.get(chord);
          expect(
            existing,
            `${chord} 同时绑定给 ${existing} 和 ${command.id}`,
          ).toBeUndefined();
          seen.set(chord, command.id);
        }
      }
    }
  });
});

describe("matchKeyboardEvent", () => {
  it("Mod 在 mac 上是 ⌘、其余平台是 Ctrl", () => {
    const meta = keydown({ key: "k", metaKey: true });
    const ctrl = keydown({ key: "k", ctrlKey: true });
    expect(matchKeyboardEvent(meta, "Mod+K", MAC)).toBe(true);
    expect(matchKeyboardEvent(meta, "Mod+K", PC)).toBe(false);
    expect(matchKeyboardEvent(ctrl, "Mod+K", PC)).toBe(true);
    expect(matchKeyboardEvent(ctrl, "Mod+K", MAC)).toBe(false);
  });

  it("修饰键必须完全一致", () => {
    const withShift = keydown({ key: "K", metaKey: true, shiftKey: true });
    expect(matchKeyboardEvent(withShift, "Mod+K", MAC)).toBe(false);
    expect(matchKeyboardEvent(withShift, "Mod+Shift+K", MAC)).toBe(true);
  });

  it("非拉丁布局下回退到 event.code", () => {
    // 俄文布局按 ⌘K 时 event.key 是 "л"
    const cyrillic = keydown({ key: "л", code: "KeyK", metaKey: true });
    expect(matchKeyboardEvent(cyrillic, "Mod+K", MAC)).toBe(true);
  });

  it("认得 Comma / Enter / 方向键这些名字", () => {
    expect(
      matchKeyboardEvent(
        keydown({ key: ",", metaKey: true }),
        "Mod+Comma",
        MAC,
      ),
    ).toBe(true);
    expect(
      matchKeyboardEvent(
        keydown({ key: "Enter", metaKey: true, shiftKey: true }),
        "Mod+Shift+Enter",
        MAC,
      ),
    ).toBe(true);
    expect(
      matchKeyboardEvent(
        keydown({ key: "ArrowLeft", metaKey: true }),
        "Mod+ArrowLeft",
        MAC,
      ),
    ).toBe(true);
  });

  it("逗号分隔的多个写法任一命中即可", () => {
    const keys = commandKeys("canvas.delete", MAC);
    expect(matchKeyboardEvent(keydown({ key: "Backspace" }), keys, MAC)).toBe(
      true,
    );
    expect(matchKeyboardEvent(keydown({ key: "Delete" }), keys, MAC)).toBe(
      true,
    );
    expect(matchKeyboardEvent(keydown({ key: "x" }), keys, MAC)).toBe(false);
  });

  it("未绑定或写法非法时永不命中", () => {
    const event = keydown({ key: "b", metaKey: true, shiftKey: true });
    expect(matchKeyboardEvent(event, null, MAC)).toBe(false);
    expect(matchKeyboardEvent(event, "", MAC)).toBe(false);
    expect(matchKeyboardEvent(event, "Hyper+B", MAC)).toBe(false);
  });
});

describe("formatKeys", () => {
  it("mac 用符号，顺序 ⌃⌥⇧⌘", () => {
    expect(formatKeys("Mod+Shift+K", MAC)).toBe("⇧⌘K");
    expect(formatKeys("Ctrl+Alt+Shift+Meta+K", MAC)).toBe("⌃⌥⇧⌘K");
    expect(formatKeys("Mod+Comma", MAC)).toBe("⌘,");
    expect(formatKeys("Mod+Shift+Enter", MAC)).toBe("⇧⌘⏎");
  });

  it("其余平台写成 Ctrl+Shift+K", () => {
    expect(formatKeys("Mod+Shift+K", PC)).toBe("Ctrl+Shift+K");
    expect(formatKeys("Mod+Enter", PC)).toBe("Ctrl+Enter");
  });

  it("多个等价写法用 / 连接", () => {
    expect(formatKeys("Backspace,Delete", MAC)).toBe("⌫ / ⌦");
  });

  it("未绑定返回空串", () => {
    expect(formatKeys(null, MAC)).toBe("");
    expect(formatKeys(undefined, PC)).toBe("");
  });
});

describe("上下文判定", () => {
  it("识别 xterm 容器", () => {
    const wrapper = document.createElement("div");
    wrapper.className = "xterm";
    const textarea = document.createElement("textarea");
    wrapper.append(textarea);
    expect(isTerminalTarget(textarea)).toBe(true);
    expect(isTerminalTarget(document.createElement("textarea"))).toBe(false);
  });

  it("识别可编辑控件，但不把复选框算成打字", () => {
    const text = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
  });
});

describe("useKeybindings", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  /** 只为装 hook 的空组件——快捷键没有 DOM 产物，断言全在 handler 上。 */
  function Harness({
    handlers,
    options,
  }: {
    handlers: Partial<Record<CommandId, () => void>>;
    options?: Parameters<typeof useKeybindings>[1];
  }) {
    useKeybindings(handlers, { mac: true, ...options });
    return null;
  }

  function mount(
    handlers: Partial<Record<CommandId, () => void>>,
    options?: Parameters<typeof useKeybindings>[1],
  ) {
    render(createElement(Harness, { handlers, options }));
  }

  function fire(
    init: KeyboardEventInit & { key: string },
    target: EventTarget = window,
  ): KeyboardEvent {
    const event = keydown(init);
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("命中后调用 handler 并阻止默认行为", () => {
    const onPalette = vi.fn();
    mount({ "app.commandPalette": onPalette });
    const event = fire({ key: "k", metaKey: true });
    expect(onPalette).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("没注册 handler 的命令不拦截按键", () => {
    mount({});
    const event = fire({ key: "k", metaKey: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it("终端里只放行 allowInTerminal 的命令", () => {
    const onPalette = vi.fn();
    const onUndo = vi.fn();
    mount({ "app.commandPalette": onPalette, "canvas.undo": onUndo });

    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const textarea = document.createElement("textarea");
    terminal.append(textarea);
    document.body.append(terminal);

    fire({ key: "k", metaKey: true }, textarea);
    fire({ key: "z", metaKey: true }, textarea);

    expect(onPalette).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("输入框里只放行 allowWhileTyping 的命令", () => {
    const onCommit = vi.fn();
    const onUndo = vi.fn();
    mount({ "scm.commit": onCommit, "canvas.undo": onUndo });

    const textarea = document.createElement("textarea");
    document.body.append(textarea);

    fire({ key: "Enter", metaKey: true }, textarea);
    fire({ key: "z", metaKey: true }, textarea);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("画布上（非输入、非终端）的 ⌘Z 正常触发", () => {
    const onUndo = vi.fn();
    mount({ "canvas.undo": onUndo });
    fire({ key: "z", metaKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("scopes 可以关掉整组命令", () => {
    const onUndo = vi.fn();
    mount({ "canvas.undo": onUndo }, { scopes: ["app"] });
    fire({ key: "z", metaKey: true });
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("enabled=false 时完全不装监听", () => {
    const onPalette = vi.fn();
    mount({ "app.commandPalette": onPalette }, { enabled: false });
    const event = fire({ key: "k", metaKey: true });
    expect(onPalette).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("自定义键位覆盖默认键", () => {
    const onTidy = vi.fn();
    mount(
      { "canvas.tidy": onTidy },
      { keymap: { "canvas.tidy": { mac: "Mod+Shift+P", other: null } } },
    );
    fire({ key: "a", metaKey: true, shiftKey: true });
    expect(onTidy).not.toHaveBeenCalled();
    fire({ key: "p", metaKey: true, shiftKey: true });
    expect(onTidy).toHaveBeenCalledTimes(1);
  });

  it("窗口快捷键不触发节点或旧自定义绑定，终端与输入框也放行", () => {
    const onClose = vi.fn();
    const onPalette = vi.fn();
    mount(
      { "canvas.closeNode": onClose, "app.commandPalette": onPalette },
      {
        keymap: {
          "canvas.closeNode": { mac: "Mod+W", other: null },
          "app.commandPalette": { mac: "Mod+Q", other: null },
        },
      },
    );
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const textarea = document.createElement("textarea");
    terminal.append(textarea);
    document.body.append(terminal);
    for (const target of [window, textarea]) {
      for (const key of ["w", "q"]) {
        expect(fire({ key, metaKey: true }, target).defaultPrevented).toBe(
          false,
        );
      }
    }
    expect(onClose).not.toHaveBeenCalled();
    expect(onPalette).not.toHaveBeenCalled();
    expect(commandKeys("canvas.closeNode", MAC)).toBeNull();
  });

  it("录制暂停先注册的监听器，结束后恢复且清理可重复", () => {
    const onPalette = vi.fn();
    mount({ "app.commandPalette": onPalette });
    const resume = suspendKeybindings();
    try {
      expect(fire({ key: "k", metaKey: true }).defaultPrevented).toBe(false);
      expect(onPalette).not.toHaveBeenCalled();
    } finally {
      resume();
      resume();
    }
    fire({ key: "k", metaKey: true });
    expect(onPalette).toHaveBeenCalledOnce();
  });

  it("原生键支持物理布局回退且不占用CtrlQ", () => {
    expect(
      isWindowShortcut(
        keydown({ key: "ц", code: "KeyW", metaKey: true }),
        true,
      ),
    ).toBe(true);
    expect(isWindowShortcut(keydown({ key: "q", ctrlKey: true }), false)).toBe(
      false,
    );
    expect(
      isWindowShortcut(
        keydown({ key: "w", metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe(false);
  });

  it("输入法组词中的按键不算命令", () => {
    const onPalette = vi.fn();
    mount({ "app.commandPalette": onPalette });
    const event = keydown({ key: "k", metaKey: true });
    Object.defineProperty(event, "isComposing", { value: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(onPalette).not.toHaveBeenCalled();
  });
});
