import { describe, expect, it } from "vitest";

import { COMMAND_BY_ID, type CommandId } from "../../keybindings";
import {
  emptyKeymap,
  exportKeymap,
  importKeymap,
  keymapSource,
  keysBelow,
  resolveKeymap,
} from "./keymap";
import {
  BUILTIN_PROFILE_IDS,
  DEFAULT_PROFILE_ID,
  PROFILE_ID_PATTERN,
  PROFILE_PRESETS,
  activeGlobalLayer,
  activeProfileId,
  createProfilePatch,
  deleteProfilePatch,
  isBuiltinProfile,
  mergeLayers,
  profileLayersPatch,
  profilePatch,
  profilePreset,
  storedProfiles,
} from "./keymap-profiles";

describe("配置档", () => {
  it("没听说过配置档的旧数据读出来就是默认档", () => {
    const legacy = { mac: { "canvas.tidy": "Mod+Shift+K" } };
    expect(activeProfileId(legacy)).toBe(DEFAULT_PROFILE_ID);
    // 一条覆盖都不该丢：这就是不需要迁移的意思。
    expect(storedProfiles(legacy).default?.mac["canvas.tidy"]).toBe(
      "Mod+Shift+K",
    );
    expect(activeGlobalLayer(legacy).mac["canvas.tidy"]).toBe("Mod+Shift+K");
  });

  it("内置档总在列表里，连一条修改都没有也在", () => {
    const profiles = storedProfiles({});
    for (const id of BUILTIN_PROFILE_IDS) expect(profiles[id]).toBeDefined();
  });

  it("指向不存在的档时回到默认，而不是让键盘失灵", () => {
    for (const raw of [
      { profile: "nope" },
      { profile: 7 },
      { profile: "" },
      { profile: "Not Valid" },
      null,
    ])
      expect(activeProfileId(raw)).toBe(DEFAULT_PROFILE_ID);
  });

  it("换档换的是全局那一层，两个档各记各的", () => {
    const raw = {
      profile: "vscode",
      mac: { "canvas.tidy": "Mod+Shift+K" },
      profiles: { vscode: { mac: { "canvas.tidy": "Mod+Alt+K" } } },
    };
    expect(activeGlobalLayer(raw).mac["canvas.tidy"]).toBe("Mod+Alt+K");
    // 预设也在这一层里。
    expect(activeGlobalLayer(raw).mac["app.sidebar"]).toBe("Mod+B");

    const back = { ...raw, profile: DEFAULT_PROFILE_ID };
    expect(activeGlobalLayer(back).mac["canvas.tidy"]).toBe("Mod+Shift+K");
    // 默认档没有预设，所以 app.sidebar 落回内置默认。
    expect(activeGlobalLayer(back).mac["app.sidebar"]).toBeUndefined();
  });

  it("用户在档里的修改盖过档预设", () => {
    const raw = {
      profile: "vscode",
      profiles: { vscode: { mac: { "app.sidebar": "Mod+Alt+B" } } },
    };
    expect(activeGlobalLayer(raw).mac["app.sidebar"]).toBe("Mod+Alt+B");
    const keymap = resolveKeymap(activeGlobalLayer(raw));
    expect(keymap["app.sidebar"]?.mac).toBe("Mod+Alt+B");
  });

  it("预设算「配置档」这一层，用户改的才算「全局」", () => {
    const preset = profilePreset("vscode");
    const user = { ...emptyKeymap(), mac: { "app.sidebar": "Mod+Alt+B" } };
    const global = mergeLayers(preset, user);

    expect(
      keymapSource("app.commandPalette", "mac", global, emptyKeymap(), preset),
    ).toBe("profile");
    expect(
      keymapSource("app.sidebar", "mac", global, emptyKeymap(), preset),
    ).toBe("global");
    expect(
      keymapSource("canvas.tidy", "mac", global, emptyKeymap(), preset),
    ).toBe("default");

    // 重置自己那一条会落回预设，不是落回内置默认。
    expect(keysBelow("app.sidebar", "mac", "global", global, preset)).toBe(
      "Mod+B",
    );
    // 没有预设的那一条仍然落回内置默认。
    expect(keysBelow("canvas.tidy", "mac", "global", global, preset)).toBe(
      COMMAND_BY_ID["canvas.tidy"].defaultKeys.mac,
    );
  });

  it("不传 preset 时行为与从前一模一样", () => {
    const global = { ...emptyKeymap(), mac: { "canvas.tidy": "Mod+Alt+K" } };
    expect(keymapSource("canvas.tidy", "mac", global)).toBe("global");
    expect(keymapSource("app.sidebar", "mac", global)).toBe("default");
  });

  it("预设只引用真实存在的命令，两个平台都写全", () => {
    for (const [id, preset] of Object.entries(PROFILE_PRESETS))
      for (const platform of ["mac", "other"] as const)
        for (const command of Object.keys(preset[platform]))
          expect(
            COMMAND_BY_ID[command as CommandId],
            `${id}.${platform}.${command}`,
          ).toBeDefined();
    // VS Code 档在两个平台上覆盖同一批命令，不然换台机器就变了一半。
    expect(Object.keys(PROFILE_PRESETS.vscode.mac).sort()).toEqual(
      Object.keys(PROFILE_PRESETS.vscode.other).sort(),
    );
  });

  it("写默认档就是写顶层那两格，写别的档套进 profiles", () => {
    expect(
      profilePatch(DEFAULT_PROFILE_ID, "mac", { "canvas.tidy": "Q" }),
    ).toEqual({ mac: { "canvas.tidy": "Q" } });
    expect(profilePatch("vscode", "mac", { "canvas.tidy": null })).toEqual({
      profiles: { vscode: { mac: { "canvas.tidy": null } } },
    });
    expect(profileLayersPatch("vscode", { mac: {}, other: {} })).toEqual({
      profiles: { vscode: { mac: {}, other: {} } },
    });
  });

  it("新建的档要同时被选中并占一格，否则它读不回来", () => {
    const patch = createProfilePatch("mine");
    expect(patch.profile).toBe("mine");
    // 没有这一格，activeProfileId 会认为它不存在并弹回默认。
    expect(activeProfileId(patch)).toBe("mine");
  });

  it("内置档删不掉，删掉当前档会回到默认", () => {
    expect(deleteProfilePatch("vscode", "vscode")).toBeNull();
    expect(deleteProfilePatch("default", "default")).toBeNull();
    expect(deleteProfilePatch("mine", "mine")).toEqual({
      profile: DEFAULT_PROFILE_ID,
      profiles: { mine: null },
    });
    // 删一个没在用的档不会把人踢回默认档。
    expect(deleteProfilePatch("mine", "vscode")).toEqual({
      profiles: { mine: null },
    });
  });

  it("档 id 只收小写短名", () => {
    for (const good of ["mine", "work-2", "a", "0"])
      expect(PROFILE_ID_PATTERN.test(good), good).toBe(true);
    for (const bad of [
      "",
      "Mine",
      "my profile",
      "-lead",
      "x".repeat(33),
      "a/b",
    ])
      expect(PROFILE_ID_PATTERN.test(bad), bad).toBe(false);
    expect(isBuiltinProfile("mine")).toBe(false);
    expect(isBuiltinProfile("vscode")).toBe(true);
  });
});

describe("导入 / 导出带上配置档", () => {
  const global = { ...emptyKeymap(), mac: { "canvas.tidy": "Mod+Alt+K" } };
  const device = { ...emptyKeymap(), other: { "canvas.undo": "Ctrl+Alt+Z" } };
  const profiles = {
    default: global,
    vscode: { ...emptyKeymap(), mac: { "app.sidebar": "Mod+Alt+B" } },
  };

  it("导出的是覆盖与档，不是最终结果", () => {
    const text = exportKeymap(global, device, profiles, "vscode");
    const document = JSON.parse(text);
    expect(document.profile).toBe("vscode");
    expect(document.profiles.vscode.mac["app.sidebar"]).toBe("Mod+Alt+B");
    // 预设不进文件：它跟着版本走，冻进去这份配置就停在导出那天了。
    expect(document.profiles.vscode.mac["app.commandPalette"]).toBeUndefined();

    const back = importKeymap(text);
    expect(back.profile).toBe("vscode");
    expect(back.profiles.vscode).toEqual(profiles.vscode);
    expect(back.profiles.default).toEqual(global);
    expect(back.device).toEqual(device);
  });

  it("版本 1 的文件与扁平表都还认，读成默认档", () => {
    const v1 = JSON.stringify({ version: 1, global, device });
    const one = importKeymap(v1);
    expect(one.profile).toBe("default");
    expect(one.profiles.default).toEqual(global);
    expect(one.global).toEqual(global);

    const flat = importKeymap(JSON.stringify({ "canvas.tidy": "Mod+Alt+K" }));
    expect(flat.profiles.default?.mac["canvas.tidy"]).toBe("Mod+Alt+K");
  });

  it("文件里没有的档不会被选中", () => {
    const imported = importKeymap(
      JSON.stringify({
        version: 2,
        profile: "gone",
        profiles: { default: global },
      }),
    );
    // 否则导入完就是「当前档不存在」，整套键位落回默认，看起来像丢了配置。
    expect(imported.profile).toBe("default");
  });

  it("不是这个格式的文本仍然报错", () => {
    for (const bad of ["not json", "[]", '"text"'])
      expect(() => importKeymap(bad), bad).toThrow();
    // 来自更新版本的文件才拒绝；旧版本要读得进来。
    expect(() =>
      importKeymap(JSON.stringify({ version: 99, global })),
    ).toThrow();
  });
});
