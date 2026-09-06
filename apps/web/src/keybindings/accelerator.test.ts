import { describe, expect, it } from "vitest";

import { acceleratorFor, toAccelerator } from "./accelerator";
import { commandsInScope } from "./commands";
import { GLOBAL_SHORTCUT_ACTIONS, globalBindings } from "./global-shortcuts";

describe("accelerator 转换", () => {
  it("修饰键按 Tauri 的名字来", () => {
    expect(toAccelerator("Mod+Shift+K")).toBe("CmdOrCtrl+Shift+K");
    expect(toAccelerator("Ctrl+Alt+T")).toBe("Control+Alt+T");
    expect(toAccelerator("Meta+Comma")).toBe("Super+Comma");
    expect(toAccelerator("Cmd+Period")).toBe("Super+Period");
    expect(toAccelerator("Option+Slash")).toBe("Alt+Slash");
  });

  it("主键认字母、数字、功能键、方向键与标点", () => {
    expect(toAccelerator("Mod+1")).toBe("CmdOrCtrl+1");
    expect(toAccelerator("Shift+F12")).toBe("Shift+F12");
    expect(toAccelerator("Mod+ArrowUp")).toBe("CmdOrCtrl+ArrowUp");
    expect(toAccelerator("Mod+Space")).toBe("CmdOrCtrl+Space");
    expect(toAccelerator("Mod+BracketLeft")).toBe("CmdOrCtrl+BracketLeft");
    expect(toAccelerator("Mod+Backquote")).toBe("CmdOrCtrl+Backquote");
  });

  /**
   * 无修饰的全局热键会让这台机器上再也打不出那个字符——包括在别的应用里。
   * 那不是一个应该由「用户自己不要那么做」兜住的问题。
   */
  it("拒绝无修饰的组合", () => {
    for (const bare of ["K", "F5", "Space", "", "   "])
      expect(toAccelerator(bare), bare).toBeNull();
  });

  it("翻不出来的一律 null，不给一个「差不多」的串", () => {
    for (const broken of [
      "Hyper+K",
      "Mod+Mod+K",
      "Mod+",
      "+K",
      "Mod+Unknownkey",
      "Mod+F25",
    ])
      expect(toAccelerator(broken), broken).toBeNull();
  });

  it("多写法只取第一条能用的，不是全都注册", () => {
    // 全都注册就会悄悄多占用户没打算给出去的组合键。
    expect(acceleratorFor("Mod+Backspace,Mod+Delete")).toBe(
      "CmdOrCtrl+Backspace",
    );
    // 第一条翻不出来时往后找。
    expect(acceleratorFor("K,Mod+K")).toBe("CmdOrCtrl+K");
    expect(acceleratorFor("K,V")).toBe("");
    expect(acceleratorFor(null)).toBe("");
    expect(acceleratorFor(undefined)).toBe("");
  });
});

describe("系统热键这一组", () => {
  it("默认一条都不绑", () => {
    // 默认就装上一个全局热键 = 安装之后才发现某个组合键被抢走了。
    for (const command of commandsInScope("global")) {
      expect(command.defaultKeys.mac, command.id).toBeNull();
      expect(command.defaultKeys.other, command.id).toBeNull();
    }
    for (const binding of globalBindings())
      expect(binding.accelerator).toBe("");
  });

  it("绑上之后交给壳的是 accelerator，不是和弦写法", () => {
    const bindings = globalBindings({
      "global.toggleWindow": { mac: "Mod+Shift+A", other: "Mod+Shift+A" },
    });
    const toggle = bindings.find(
      (binding) => binding.id === "global.toggleWindow",
    );
    expect(toggle?.accelerator).toBe("CmdOrCtrl+Shift+A");
    // 没绑的那条仍然要出现在列表里：壳按整表替换，漏掉一条就等于留着上一轮
    // 注册的那个热键。
    expect(bindings).toHaveLength(commandsInScope("global").length);
  });

  it("每条需要页面动作的热键都有对应的画布命令", () => {
    for (const [id, action] of Object.entries(GLOBAL_SHORTCUT_ACTIONS)) {
      expect(
        commandsInScope("global").some((command) => command.id === id),
      ).toBe(true);
      expect(action).toBeTruthy();
    }
    // 显示 / 隐藏窗口由壳自己做，不该出现在这张表里。
    expect(GLOBAL_SHORTCUT_ACTIONS["global.toggleWindow"]).toBeUndefined();
  });
});
