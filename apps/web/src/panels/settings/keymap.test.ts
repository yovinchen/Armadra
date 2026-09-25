import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chordFromEvent,
  deviceId,
  deviceKeymapKey,
  emptyKeymap,
  exportKeymap,
  importKeymap,
  keymapConflicts,
  keymapMigrationPatch,
  keymapSource,
  keysBelow,
  legacyKeymapKeys,
  loadDeviceKeymap,
  parseStoredKeymap,
  resolveKeymap,
  saveDeviceKeymap,
  addChord,
  removeChord,
  splitChords,
  whenProblem,
  type StoredKeymap,
} from "./keymap";
import {
  commandKeys,
  commandWhen,
  matchKeyboardEvent,
} from "../../keybindings";

function press(init: KeyboardEventInit & { code?: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

function layers(overrides: Partial<StoredKeymap>): StoredKeymap {
  return { ...emptyKeymap(), ...overrides };
}

describe("parseStoredKeymap", () => {
  it("按平台分开读，未知命令丢掉，空写法是一条「清空」", () => {
    const stored = parseStoredKeymap({
      mac: { "canvas.tidy": "Mod+Shift+K", "nope.command": "Mod+J" },
      other: { "canvas.tidy": "Mod+Alt+K", "canvas.undo": "   " },
    });
    expect(stored.mac).toEqual({ "canvas.tidy": "Mod+Shift+K" });
    expect(stored.other).toEqual({
      "canvas.tidy": "Mod+Alt+K",
      "canvas.undo": "",
    });
    expect(
      commandKeys("canvas.undo", { mac: false, keymap: resolveKeymap(stored) }),
    ).toBe("");
    // 两个平台各读各的，不互相污染。
    const keymap = resolveKeymap(stored);
    expect(commandKeys("canvas.tidy", { mac: true, keymap })).toBe(
      "Mod+Shift+K",
    );
    expect(commandKeys("canvas.tidy", { mac: false, keymap })).toBe(
      "Mod+Alt+K",
    );
    expect(commandKeys("canvas.undo", { mac: true, keymap })).toBe("Mod+Z");
  });

  it("旧的扁平写法两个平台都保留，一条覆盖都不丢", () => {
    const stored = parseStoredKeymap({ "canvas.tidy": "Mod+Shift+K" });
    expect(stored.mac["canvas.tidy"]).toBe("Mod+Shift+K");
    expect(stored.other["canvas.tidy"]).toBe("Mod+Shift+K");
  });

  it("新旧写法同时存在时以分平台的那份为准", () => {
    const stored = parseStoredKeymap({
      "canvas.tidy": "Mod+Shift+K",
      mac: { "canvas.tidy": "Mod+Alt+K" },
    });
    expect(stored.mac["canvas.tidy"]).toBe("Mod+Alt+K");
    // 另一个平台没有分平台条目，就还是旧数据说的那条。
    expect(stored.other["canvas.tidy"]).toBe("Mod+Shift+K");
  });

  it("坏数据不会让整份键位失效", () => {
    for (const raw of [undefined, null, 42, [], { mac: "Mod+K" }])
      expect(parseStoredKeymap(raw)).toEqual(emptyKeymap());
  });
});

describe("旧格式迁移", () => {
  it("同一个 PATCH 里删掉旧键并写进两个平台，键位不变", () => {
    const raw = { "canvas.tidy": "Mod+Shift+K", "nope.command": "Mod+J" };
    expect(legacyKeymapKeys(raw).sort()).toEqual([
      "canvas.tidy",
      "nope.command",
    ]);
    const patch = keymapMigrationPatch(raw)!;
    expect(patch["canvas.tidy"]).toBeNull();
    // 未知命令也一并清掉，否则它会永远留在文件里。
    expect(patch["nope.command"]).toBeNull();
    expect(patch.mac).toEqual({ "canvas.tidy": "Mod+Shift+K" });
    expect(patch.other).toEqual({ "canvas.tidy": "Mod+Shift+K" });
  });

  it("已经是新格式时不发 PATCH", () => {
    expect(
      keymapMigrationPatch({ mac: { "canvas.tidy": "Mod+Shift+K" } }),
    ).toBeNull();
    expect(keymapMigrationPatch({})).toBeNull();
    expect(keymapMigrationPatch(undefined)).toBeNull();
  });

  it("迁移前后合并结果一致", () => {
    const raw = { "canvas.tidy": "Mod+Shift+K" };
    const before = resolveKeymap(parseStoredKeymap(raw));
    const patch = keymapMigrationPatch(raw)!;
    const after = resolveKeymap(
      parseStoredKeymap({ mac: patch.mac, other: patch.other }),
    );
    expect(after).toEqual(before);
  });
});

describe("三层合并与来源", () => {
  const global = layers({
    mac: { "canvas.tidy": "Mod+Shift+K", "canvas.focusMode": "Mod+Alt+F" },
  });
  const device = layers({ mac: { "canvas.tidy": "Mod+Alt+K" } });

  it("设备覆盖压过全局，全局压过默认", () => {
    const keymap = resolveKeymap(global, device);
    expect(commandKeys("canvas.tidy", { mac: true, keymap })).toBe("Mod+Alt+K");
    expect(commandKeys("canvas.focusMode", { mac: true, keymap })).toBe(
      "Mod+Alt+F",
    );
    expect(commandKeys("canvas.newTerminal", { mac: true, keymap })).toBe(
      "Mod+T",
    );
    // 覆盖只在 mac 那一层，另一个平台仍然是默认。
    expect(commandKeys("canvas.tidy", { mac: false, keymap })).toBe(
      commandKeys("canvas.tidy", { mac: false }),
    );
  });

  it("每条命令说得出是哪一层决定的，以及重置后落到哪", () => {
    expect(keymapSource("canvas.tidy", "mac", global, device)).toBe("device");
    expect(keymapSource("canvas.focusMode", "mac", global, device)).toBe(
      "global",
    );
    expect(keymapSource("canvas.tidy", "other", global, device)).toBe(
      "default",
    );
    // 重置设备层落回全局，再重置才回默认。
    expect(keysBelow("canvas.tidy", "mac", "device", global)).toBe(
      "Mod+Shift+K",
    );
    expect(keysBelow("canvas.tidy", "mac", "global", global)).toBe(
      "Mod+Shift+A",
    );
    expect(keysBelow("canvas.focusMode", "mac", "global", global)).toBe(
      "Mod+Shift+F",
    );
  });
});

describe("本设备存储", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("按设备 id 分格，空覆盖不留垃圾", () => {
    const id = deviceId();
    expect(deviceId()).toBe(id);
    expect(deviceKeymapKey(id)).toContain(id);
    saveDeviceKeymap(layers({ mac: { "canvas.tidy": "Mod+Alt+K" } }), id);
    expect(loadDeviceKeymap(id).mac["canvas.tidy"]).toBe("Mod+Alt+K");
    // 另一台设备读不到这一层。
    expect(loadDeviceKeymap("other-device")).toEqual(emptyKeymap());
    saveDeviceKeymap(emptyKeymap(), id);
    expect(localStorage.getItem(deviceKeymapKey(id))).toBeNull();
  });

  it("存坏了当作没有本设备覆盖，不让键盘失灵", () => {
    localStorage.setItem(deviceKeymapKey("broken"), "{not json");
    expect(loadDeviceKeymap("broken")).toEqual(emptyKeymap());
  });

  it("存储不可用时不抛错", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => saveDeviceKeymap(emptyKeymap(), "x")).not.toThrow();
    expect(loadDeviceKeymap("x")).toEqual(emptyKeymap());
    expect(deviceId()).toBe(deviceId());
  });
});

describe("导入导出", () => {
  it("导出两层覆盖，不冻住默认键位", () => {
    const text = exportKeymap(
      layers({ mac: { "canvas.tidy": "Mod+Shift+K" } }),
      layers({ other: { "canvas.undo": "Mod+Alt+Z" } }),
    );
    const parsed = JSON.parse(text);
    expect(parsed.global.mac["canvas.tidy"]).toBe("Mod+Shift+K");
    expect(parsed.device.other["canvas.undo"]).toBe("Mod+Alt+Z");
    expect(parsed.global.mac["canvas.newTerminal"]).toBeUndefined();
    const back = importKeymap(text);
    expect(back.global.mac["canvas.tidy"]).toBe("Mod+Shift+K");
    expect(back.device.other["canvas.undo"]).toBe("Mod+Alt+Z");
  });

  it("导入丢掉不认识的条目，并接受旧的扁平文件", () => {
    const imported = importKeymap(
      JSON.stringify({ global: { mac: { "nope.command": "Mod+J" } } }),
    );
    expect(imported.global).toEqual(emptyKeymap());
    const legacy = importKeymap(JSON.stringify({ "canvas.tidy": "Mod+Alt+K" }));
    expect(legacy.global.mac["canvas.tidy"]).toBe("Mod+Alt+K");
    expect(legacy.device).toEqual(emptyKeymap());
  });

  it("不是这个格式就报错，由界面显示无法识别", () => {
    for (const text of ["", "[]", "not json", '{"version":99}'])
      expect(() => importKeymap(text)).toThrow();
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
    const keymap = resolveKeymap(layers({ mac: { "canvas.tidy": "Mod+Z" } }));
    const conflicts = keymapConflicts(keymap, true);
    expect(conflicts.has("canvas.tidy")).toBe(true);
    expect(conflicts.has("canvas.undo")).toBe(true);
    expect(conflicts.size).toBe(2);
  });

  it("跨scope共享按键与修饰键别名也会冲突", () => {
    const keymap = resolveKeymap(
      layers({ mac: { "canvas.tidy": "Command+F" } }),
    );
    expect([...keymapConflicts(keymap, true)].sort()).toEqual([
      "canvas.tidy",
      "terminal.search",
    ]);
  });

  it("冲突看的是三层合并之后的结果", () => {
    const global = layers({ mac: { "canvas.tidy": "Mod+Z" } });
    // 全局撞上 canvas.undo；本设备把它挪开之后就不该再报冲突。
    expect(keymapConflicts(resolveKeymap(global), true).size).toBe(2);
    const device = layers({ mac: { "canvas.tidy": "Mod+Alt+K" } });
    expect(keymapConflicts(resolveKeymap(global, device), true).size).toBe(0);
    // 反过来，本设备也能把原本不冲突的两条撞到一起。
    expect(
      [
        ...keymapConflicts(
          resolveKeymap(
            emptyKeymap(),
            layers({ mac: { "canvas.tidy": "Mod+Z" } }),
          ),
          true,
        ),
      ].sort(),
    ).toEqual(["canvas.tidy", "canvas.undo"]);
  });

  it("每个平台各判各的冲突", () => {
    const keymap = resolveKeymap(layers({ mac: { "canvas.tidy": "Mod+Z" } }));
    expect(keymapConflicts(keymap, true).size).toBe(2);
    // 覆盖没写进 other，那个平台就还是默认表，不冲突。
    expect(keymapConflicts(keymap, false).size).toBe(0);
  });

  it("旧物理键别名也参与冲突和系统键检查", () => {
    expect(
      [
        ...keymapConflicts(
          resolveKeymap(layers({ mac: { "canvas.tidy": "Meta+KeyF" } })),
          true,
        ),
      ].sort(),
    ).toEqual(["canvas.tidy", "terminal.search"]);
    expect([
      ...keymapConflicts(
        resolveKeymap(layers({ mac: { "canvas.closeNode": "Meta+KeyW" } })),
        true,
      ),
    ]).toEqual(["canvas.closeNode"]);
  });

  it("旧窗口键绑定标为冲突，不能录成新的节点快捷键", () => {
    expect([
      ...keymapConflicts(
        resolveKeymap(layers({ mac: { "canvas.closeNode": "Meta+W" } })),
        true,
      ),
    ]).toEqual(["canvas.closeNode"]);
    for (const key of ["w", "q"]) {
      expect(chordFromEvent(press({ key, metaKey: true }), true)).toBeNull();
    }
    expect(chordFromEvent(press({ key: "q", ctrlKey: true }), false)).toBe(
      "Mod+Q",
    );
  });
});

describe("清空一条绑定", () => {
  it("空串是一条覆盖：盖住下面各层，来源照报，重置能退回去", () => {
    const global = layers({ mac: { "canvas.tidy": "Mod+Alt+K" } });
    const device = layers({ mac: { "canvas.tidy": "" } });
    const keymap = resolveKeymap(global, device);
    expect(commandKeys("canvas.tidy", { mac: true, keymap })).toBe("");
    // 另一个平台没清，照旧是默认。
    expect(commandKeys("canvas.tidy", { mac: false, keymap })).toBe(
      commandKeys("canvas.tidy", { mac: false, keymap: {} }),
    );
    // 「没覆盖」与「覆盖为空」分得开：前者是 default，后者是 device。
    expect(keymapSource("canvas.tidy", "mac", global, device)).toBe("device");
    expect(keymapSource("canvas.undo", "mac", global, device)).toBe("default");
    // 重置本设备那一条会落回全局的写法，而不是也变成空。
    expect(keysBelow("canvas.tidy", "mac", "device", global)).toBe("Mod+Alt+K");
    // 清空的键不参与冲突：它什么也不占。
    const cleared = resolveKeymap(
      layers({ mac: { "canvas.tidy": "Mod+Z", "canvas.undo": "" } }),
    );
    expect(keymapConflicts(cleared, true).size).toBe(0);
  });

  it("清空能存进本设备，也能原样导出导入", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const id = "cleared-device";
    saveDeviceKeymap(layers({ mac: { "canvas.tidy": "" } }), id);
    expect(loadDeviceKeymap(id).mac).toEqual({ "canvas.tidy": "" });
    saveDeviceKeymap(emptyKeymap(), id);
    vi.unstubAllGlobals();
    const back = importKeymap(
      exportKeymap(layers({ other: { "canvas.undo": "" } }), emptyKeymap()),
    );
    expect(back.global.other).toEqual({ "canvas.undo": "" });
  });

  it("旧的扁平写法里空串不算清空：那一版没有这回事", () => {
    const stored = parseStoredKeymap({ "canvas.tidy": "" });
    expect(stored.mac).toEqual({});
    expect(stored.other).toEqual({});
  });
});

describe("多组替代键", () => {
  it("增、删单组，重复的组合不加第二遍", () => {
    expect(splitChords("Mod+K, Mod+J,")).toEqual(["Mod+K", "Mod+J"]);
    expect(splitChords("")).toEqual([]);
    expect(splitChords(null)).toEqual([]);
    expect(addChord("Mod+K", "Mod+J", true)).toBe("Mod+K,Mod+J");
    expect(addChord(null, "Mod+J", true)).toBe("Mod+J");
    // 修饰键别名归一之后是同一个组合。
    expect(addChord("Mod+K", "Command+K", true)).toBe("Mod+K");
    expect(removeChord("Mod+K,Mod+J", 0)).toBe("Mod+J");
    // 删掉最后一组就是清空。
    expect(removeChord("Mod+J", 0)).toBe("");
  });

  it("每一组都能触发", () => {
    const keymap = resolveKeymap(
      layers({ mac: { "canvas.tidy": "Mod+Alt+K,Mod+Alt+J" } }),
    );
    const keys = commandKeys("canvas.tidy", { mac: true, keymap });
    for (const code of ["KeyK", "KeyJ"])
      expect(
        matchKeyboardEvent(
          press({
            key: code.slice(3).toLowerCase(),
            code,
            metaKey: true,
            altKey: true,
          }),
          keys,
          { mac: true },
        ),
      ).toBe(true);
  });

  it("冲突逐组比较：只有第二组撞车也要报", () => {
    const keymap = resolveKeymap(
      layers({ mac: { "canvas.tidy": "Mod+Alt+K,Mod+Z" } }),
    );
    expect([...keymapConflicts(keymap, true)].sort()).toEqual([
      "canvas.tidy",
      "canvas.undo",
    ]);
    // 第二组是窗口保留键，也算。
    const reserved = resolveKeymap(
      layers({ mac: { "canvas.tidy": "Mod+Alt+K,Meta+W" } }),
    );
    expect([...keymapConflicts(reserved, true)]).toEqual(["canvas.tidy"]);
  });
});

describe("自定义条件", () => {
  it("条件不分平台，合并时本设备压过全局，读不懂的条件不进来", () => {
    const global = parseStoredKeymap({
      when: { "canvas.tidy": "editorFocus", "canvas.undo": "editorFocus &&" },
    });
    expect(global.when).toEqual({ "canvas.tidy": "editorFocus" });
    const device = layers({ when: { "canvas.tidy": "terminalFocus" } });
    expect(commandWhen("canvas.tidy", resolveKeymap(global))).toBe(
      "editorFocus",
    );
    expect(commandWhen("canvas.tidy", resolveKeymap(global, device))).toBe(
      "terminalFocus",
    );
    expect(keymapSource("canvas.tidy", "when", global, device)).toBe("device");
    // 没改过的沿用命令表。
    expect(commandWhen("canvas.toggleFocus", resolveKeymap(global))).toBe(
      "!editorFocus",
    );
  });

  it("改过的条件参与冲突判断", () => {
    // 默认：⌘. 在编辑器里是代码操作，在别处是专注模式，互斥，不报。
    expect(keymapConflicts(resolveKeymap(emptyKeymap()), true).size).toBe(0);
    // 用户把专注模式的条件改成「哪儿都算」，两条就会同时成立。
    const everywhere = resolveKeymap(
      layers({ when: { "canvas.toggleFocus": "" } }),
    );
    expect([...keymapConflicts(everywhere, true)].sort()).toEqual([
      "canvas.toggleFocus",
      "editor.codeActions",
    ]);
    // 反过来，给两条撞车的命令写上互斥条件，冲突就消失了。
    const apart = resolveKeymap(
      layers({
        mac: { "canvas.tidy": "Mod+Z" },
        when: { "canvas.tidy": "terminalFocus", "canvas.undo": "canvasFocus" },
      }),
    );
    expect(keymapConflicts(apart, true).size).toBe(0);
  });

  it("语法错与不认识的键分开报", () => {
    expect(whenProblem("")).toBeNull();
    expect(whenProblem("editorFocus && platform == mac")).toBeNull();
    expect(whenProblem("editorFocus &&")).toEqual({
      problem: "syntax",
      keys: [],
    });
    expect(whenProblem("editorFocuss || terminalFocus")).toEqual({
      problem: "unknownKey",
      keys: ["editorFocuss"],
    });
  });

  it("条件随导出导入一起走", () => {
    const back = importKeymap(
      exportKeymap(
        layers({ when: { "canvas.tidy": "canvasFocus" } }),
        layers({ when: { "canvas.undo": "" } }),
      ),
    );
    expect(back.global.when).toEqual({ "canvas.tidy": "canvasFocus" });
    expect(back.device.when).toEqual({ "canvas.undo": "" });
  });
});
