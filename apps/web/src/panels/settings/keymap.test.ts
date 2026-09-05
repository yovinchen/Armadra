import { describe, expect, it } from "vitest";

import { chordFromEvent, keymapConflicts, toKeymap } from "./keymap";
import { commandKeys, matchKeyboardEvent } from "../../keybindings";

function press(init: KeyboardEventInit & { code?: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("toKeymap", () => {
  it("把设置文档里的一条写法铺到两个平台，并丢掉未知命令", () => {
    const keymap = toKeymap({
      "canvas.tidy": "Mod+Shift+K",
      "nope.command": "Mod+J",
      "canvas.undo": "   ",
    });
    expect(keymap["canvas.tidy"]).toEqual({
      mac: "Mod+Shift+K",
      other: "Mod+Shift+K",
    });
    expect(Object.keys(keymap)).toEqual(["canvas.tidy"]);
    // 覆盖会被 `commandKeys` 读到，默认值不再生效。
    expect(commandKeys("canvas.tidy", { mac: true, keymap })).toBe(
      "Mod+Shift+K",
    );
    expect(commandKeys("canvas.undo", { mac: true, keymap })).toBe("Mod+Z");
  });
});

describe("chordFromEvent", () => {
  it("字母与数字读 code，所以 ⌥ 组合与非拉丁布局也稳", () => {
    // macOS 上 ⌥K 的 `key` 是 `˚`；只有 `code` 认得出这是 K。
    expect(
      chordFromEvent(
        press({ key: "˚", code: "KeyK", metaKey: true, altKey: true }),
        true,
      ),
    ).toBe("Mod+Alt+K");
    expect(
      chordFromEvent(press({ key: "1", code: "Digit1", ctrlKey: true }), false),
    ).toBe("Mod+1");
  });

  it("录制逗号和加号后仍能匹配实际按键", () => {
    for (const [event, expected] of [
      [press({ key: ",", code: "Comma", metaKey: true }), "Mod+Comma"],
      [
        press({ key: "+", code: "Equal", shiftKey: true, metaKey: true }),
        "Mod+Shift+Equal",
      ],
      [
        press({ key: "<", code: "Comma", shiftKey: true, metaKey: true }),
        "Mod+Shift+Comma",
      ],
    ] as const) {
      const chord = chordFromEvent(event, true);
      expect(chord).toBe(expected);
      expect(matchKeyboardEvent(event, chord, { mac: true })).toBe(true);
    }
  });

  it("命名键与空格用书写 token", () => {
    expect(
      chordFromEvent(
        press({ key: "Enter", code: "Enter", metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe("Mod+Shift+Enter");
    expect(
      chordFromEvent(press({ key: " ", code: "Space", metaKey: true }), true),
    ).toBe("Mod+Space");
  });

  it("只按修饰键、或完全没有修饰键，都不算一次录制", () => {
    expect(
      chordFromEvent(
        press({ key: "Shift", code: "ShiftLeft", shiftKey: true }),
        true,
      ),
    ).toBeNull();
    // 无修饰的单键会把「在画布上打字」整个截走。
    expect(chordFromEvent(press({ key: "k", code: "KeyK" }), true)).toBeNull();
  });

  it("mac 与非 mac 的主修饰键不是同一个物理键", () => {
    const event = press({ key: "k", code: "KeyK", metaKey: true });
    expect(chordFromEvent(event, true)).toBe("Mod+K");
    // 非 mac 上 ⌘ 是 Meta（Win 键），不是 Mod。
    expect(chordFromEvent(event, false)).toBe("Meta+K");
  });
});

describe("keymapConflicts", () => {
  it("默认表本身不冲突", () => {
    expect([...keymapConflicts({}, true)]).toEqual([]);
  });

  it("同一 scope 里撞车时两条都报", () => {
    const keymap = toKeymap({ "canvas.tidy": "Mod+Z" });
    const conflicts = keymapConflicts(keymap, true);
    expect(conflicts.has("canvas.tidy")).toBe(true);
    expect(conflicts.has("canvas.undo")).toBe(true);
    expect(conflicts.size).toBe(2);
  });

  it("跨scope共享按键与修饰键别名也会冲突", () => {
    const keymap = toKeymap({ "canvas.tidy": "Command+F" });
    expect([...keymapConflicts(keymap, true)].sort()).toEqual([
      "canvas.tidy",
      "terminal.search",
    ]);
  });

  it("旧物理键别名也参与冲突和系统键检查", () => {
    expect(
      [
        ...keymapConflicts(toKeymap({ "canvas.tidy": "Meta+KeyF" }), true),
      ].sort(),
    ).toEqual(["canvas.tidy", "terminal.search"]);
    expect([
      ...keymapConflicts(toKeymap({ "canvas.closeNode": "Meta+KeyW" }), true),
    ]).toEqual(["canvas.closeNode"]);
  });

  it("旧窗口键绑定标为冲突，不能录成新的节点快捷键", () => {
    expect([
      ...keymapConflicts(toKeymap({ "canvas.closeNode": "Meta+W" }), true),
    ]).toEqual(["canvas.closeNode"]);
    for (const key of ["w", "q"]) {
      expect(chordFromEvent(press({ key, metaKey: true }), true)).toBeNull();
    }
    expect(chordFromEvent(press({ key: "q", ctrlKey: true }), false)).toBe(
      "Mod+Q",
    );
  });
});
