import { describe, expect, it } from "vitest";
import {
  KNOWN_IDS,
  isKnownId,
  precheck,
  readBindings,
  type Binding,
} from "./shortcut-rules";
import { toElectronAccelerator } from "./accelerator";

/**
 * 全局热键请求的判定，ported from `src-tauri/tests/shortcuts.rs`.
 *
 * 真正的注册要问操作系统，测不了；能测的是它之前那一步——一份从页面来的
 * 列表里，哪些请求根本不该走到操作系统面前。
 */

function binding(id: string, accelerator: string): Binding {
  return { id, accelerator };
}

describe("global hotkey requests", () => {
  it("only lets the two documented ids take a system hotkey", () => {
    expect(KNOWN_IDS).toHaveLength(2);
    for (const id of KNOWN_IDS) {
      expect(isKnownId(id)).toBe(true);
      expect(precheck(binding(id, "CmdOrCtrl+Shift+K")).ok).toBe(true);
    }
    // 一份从页面来的列表是输入。别的命令 id 出现在里面时拒绝，而不是把一个
    // 全局热键注册到「按了什么也不会发生」上。
    for (const unknown of [
      "canvas.newTerminal",
      "global.somethingElse",
      "",
      "global.",
    ]) {
      expect(isKnownId(unknown), unknown).toBe(false);
      expect(precheck(binding(unknown, "CmdOrCtrl+Shift+K")), unknown).toEqual({
        ok: false,
        state: "invalid",
      });
    }
  });

  it("does not treat a missing accelerator as an error", () => {
    // 这是常态：两条命令默认都不绑，设置页照样把它们发过来。
    for (const empty of ["", "   "])
      expect(precheck(binding("global.toggleWindow", empty))).toEqual({
        ok: false,
        state: "unbound",
      });
    expect(precheck({ id: "global.toggleWindow" })).toEqual({
      ok: false,
      state: "unbound",
    });
  });

  it("refuses an accelerator that does not parse, here", () => {
    for (const broken of [
      "Nonsense",
      "CmdOrCtrl+",
      "+K",
      "CmdOrCtrl Shift K",
      "Mod+K", // 键位表的写法，不是 accelerator；页面负责转换
      "CmdOrCtrl+CmdOrCtrl+K",
      "CmdOrCtrl+Shift", // 修饰键当主键
      "CmdOrCtrl+F25",
      "CmdOrCtrl+k", // 页面输出的是大写
    ])
      expect(precheck(binding("global.toggleWindow", broken)), broken).toEqual({
        ok: false,
        state: "invalid",
      });
  });

  it("accepts every accelerator the page actually produces", () => {
    // `apps/web/src/keybindings/accelerator.ts` 的输出样本，与
    // `src-tauri/tests/shortcuts.rs` 的那一组逐条对应。两边的对应关系只有在
    // 这里被断言过，改一边才不会静默地让热键装不上。
    const samples: Record<string, string> = {
      "CmdOrCtrl+Shift+K": "CmdOrCtrl+Shift+K",
      "CmdOrCtrl+Alt+T": "CmdOrCtrl+Alt+T",
      "Shift+Alt+F1": "Shift+Alt+F1",
      "Control+Shift+Space": "Control+Shift+Space",
      "Super+Comma": "Super+,",
      "CmdOrCtrl+ArrowUp": "CmdOrCtrl+Up",
      F12: "F12",
      "CmdOrCtrl+BracketLeft": "CmdOrCtrl+[",
      "CmdOrCtrl+Enter": "CmdOrCtrl+Return",
      "Alt+Backquote": "Alt+`",
    };
    for (const [page, electron] of Object.entries(samples)) {
      expect(toElectronAccelerator(page), page).toBe(electron);
      const result = precheck(binding("global.newTerminal", page));
      expect(result, page).toEqual({ ok: true, accelerator: electron });
    }
  });

  it("drops list entries that are not bindings at all", () => {
    expect(readBindings(null)).toEqual([]);
    expect(readBindings("global.toggleWindow")).toEqual([]);
    expect(
      readBindings([
        null,
        42,
        { accelerator: "CmdOrCtrl+K" },
        { id: "global.toggleWindow" },
        { id: "global.newTerminal", accelerator: "CmdOrCtrl+Alt+T" },
      ]),
    ).toEqual([
      { id: "global.toggleWindow", accelerator: "" },
      { id: "global.newTerminal", accelerator: "CmdOrCtrl+Alt+T" },
    ]);
  });
});
