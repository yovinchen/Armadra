import { describe, expect, it } from "vitest";
import { localeFromTag, shellText } from "./messages";
import { desktop } from "../../../web/src/i18n/desktop";

describe("the shell's wording", () => {
  it("reads Chinese only for a Chinese tag", () => {
    // `src-tauri/src/usage.rs`'s `the_locale_is_chinese_only_for_a_chinese_tag`.
    expect(localeFromTag("zh_CN.UTF-8")).toBe("zh-CN");
    expect(localeFromTag("ZH-Hant")).toBe("zh-CN");
    expect(localeFromTag("en_US.UTF-8")).toBe("en");
    expect(localeFromTag("fr_FR")).toBe("en");
    expect(localeFromTag(undefined)).toBe("en");
    expect(localeFromTag("")).toBe("en");
  });

  it("comes from apps/web's catalogue, not a second copy here", () => {
    expect(shellText("zh-CN", "tray.showWindow")).toBe("显示窗口");
    expect(shellText("en", "tray.showWindow")).toBe("Show window");
  });

  it("has every key the tray and the menu ask for, in both languages", () => {
    const needed = [
      "tray.showWindow",
      "tray.quit",
      "tray.updateRestart",
      "tray.usage.session",
      "tray.usage.week",
      "tray.usage.unknown",
      "menu.file",
      "menu.edit",
      "menu.window",
      "menu.showWindow",
      "menu.closeWindow",
      "menu.quit",
      "menu.undo",
      "menu.redo",
      "menu.cut",
      "menu.copy",
      "menu.paste",
      "menu.selectAll",
      "menu.minimize",
      "menu.zoom",
    ];
    for (const key of needed)
      for (const locale of ["zh-CN", "en"] as const)
        expect(shellText(locale, key), `${locale}/${key}`).not.toBe(key);
    // And the module carries nothing the shell does not use: a string in the
    // desktop namespace that no menu reads is a string nobody maintains.
    expect(Object.keys(desktop["zh-CN"]).sort()).toEqual([...needed].sort());
  });

  it("falls back rather than showing nothing", () => {
    expect(shellText("en", "tray.doesNotExist")).toBe("tray.doesNotExist");
  });
});
