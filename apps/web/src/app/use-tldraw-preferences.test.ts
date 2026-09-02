import { beforeEach, describe, expect, it } from "vitest";

import {
  WHITEBOARD_BACKGROUNDS,
  WHITEBOARD_COLORS,
  WHITEBOARD_GRID_SIZES,
  usePreferencesStore,
} from "./preferences-store";
import {
  WHITEBOARD_BACKGROUND_COLORS,
  WHITEBOARD_STYLE_PRESETS,
  applyCanvasBackground,
  canvasBackgroundVars,
  canvasColorScheme,
  canvasDotColor,
  luminance,
  tldrawGridSize,
  tldrawLocale,
} from "./use-tldraw-preferences";

/**
 * 白板偏好（2026-09-04 用户反馈）。
 *
 * 三条纯函数（背景 → 变量、网格换算、风格预设）加一条 store 的默认值与
 * 持久化——推给 tldraw 的那一段要真 editor，留给浏览器验收。
 */

describe("背景 → CSS 变量", () => {
  it("跟随主题那一档不设任何变量", () => {
    expect(canvasBackgroundVars("theme")).toBeNull();
  });

  it("四档固定底色各给一对变量", () => {
    for (const background of WHITEBOARD_BACKGROUNDS) {
      if (background === "theme") continue;
      const vars = canvasBackgroundVars(background);
      expect(vars).not.toBeNull();
      expect(vars!["--canvas-bg"]).toBe(
        WHITEBOARD_BACKGROUND_COLORS[background],
      );
      expect(vars!["--canvas-dot"]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("点阵色跟背景明度反着走，且两边都留得下对比", () => {
    // 纯黑 → 点比底亮；纯白 / 纸色 → 点比底暗。
    expect(luminance(canvasDotColor("#000000"))).toBeGreaterThan(
      luminance("#000000"),
    );
    for (const light of ["#ffffff", "#f6f2ea"]) {
      expect(luminance(canvasDotColor(light))).toBeLessThan(luminance(light));
    }
    // 对比差得有一档，否则点阵在底色上看不见。
    for (const color of Object.values(WHITEBOARD_BACKGROUND_COLORS)) {
      expect(
        Math.abs(luminance(canvasDotColor(color)) - luminance(color)),
      ).toBeGreaterThan(0.08);
    }
  });

  it("写根元素：固定色写进去，跟随主题时清干净", () => {
    const root = document.documentElement;
    applyCanvasBackground(canvasBackgroundVars("slate"));
    expect(root.style.getPropertyValue("--canvas-bg")).toBe("#1b2430");
    expect(root.style.getPropertyValue("--canvas-dot")).not.toBe("");

    applyCanvasBackground(canvasBackgroundVars("theme"));
    expect(root.style.getPropertyValue("--canvas-bg")).toBe("");
    expect(root.style.getPropertyValue("--canvas-dot")).toBe("");
  });
});

describe("形状色板跟着底色走", () => {
  it("跟随主题那一档才用应用主题", () => {
    expect(canvasColorScheme("theme", "dark")).toBe("dark");
    expect(canvasColorScheme("theme", "light")).toBe("light");
  });

  it("固定底色时按底色明暗定，和应用主题无关", () => {
    // 深色应用里选纸色：色板必须翻成浅色，否则「黑」画出来是 near-white。
    expect(canvasColorScheme("paper", "dark")).toBe("light");
    expect(canvasColorScheme("white", "dark")).toBe("light");
    expect(canvasColorScheme("black", "light")).toBe("dark");
    expect(canvasColorScheme("slate", "light")).toBe("dark");
  });
});

describe("网格换算", () => {
  it("看到的间距是 tldraw gridSize 的 4 倍", () => {
    expect(tldrawGridSize(12)).toBe(3);
    expect(tldrawGridSize(24)).toBe(6);
    expect(tldrawGridSize(48)).toBe(12);
    for (const spacing of WHITEBOARD_GRID_SIZES) {
      expect(tldrawGridSize(spacing) * 4).toBe(spacing);
    }
  });
});

describe("风格预设", () => {
  it("手绘用抖动线与手写体，整洁用实线与无衬线", () => {
    expect(WHITEBOARD_STYLE_PRESETS.sketch).toEqual({
      dash: "draw",
      font: "draw",
    });
    expect(WHITEBOARD_STYLE_PRESETS.clean).toEqual({
      dash: "solid",
      font: "sans",
    });
  });
});

describe("tldraw 界面语言", () => {
  it("静默跟随应用语言", () => {
    expect(tldrawLocale("zh-CN")).toBe("zh-cn");
    expect(tldrawLocale("en")).toBe("en");
  });
});

/**
 * 这套 jsdom 起在 `about:blank` 上，没有 `localStorage`（store 自己 catch 掉了，
 * 所以默认值那一条照样成立）。持久化要验，就得先给一个内存实现。
 */
function installMemoryStorage(): Map<string, string> {
  const cells = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => cells.get(key) ?? null,
      setItem: (key: string, value: string) => cells.set(key, value),
      removeItem: (key: string) => cells.delete(key),
      clear: () => cells.clear(),
    },
  });
  return cells;
}

describe("白板偏好的默认值与持久化", () => {
  let cells: Map<string, string>;

  beforeEach(() => {
    cells = installMemoryStorage();
  });

  it("默认：跟随主题、网格开、24px、手绘、黑色、中号", () => {
    const { whiteboard } = usePreferencesStore.getState();
    expect(whiteboard).toEqual({
      background: "theme",
      grid: true,
      gridSize: 24,
      snap: false,
      dynamicSize: false,
      animation: true,
      style: "sketch",
      defaultColor: "black",
      defaultSize: "m",
    });
  });

  it("每一项都写进 localStorage 并进 store", () => {
    const set = usePreferencesStore.getState().setWhiteboardPreference;
    set("background", "paper");
    set("gridSize", 48);
    set("grid", false);
    set("style", "clean");
    set("defaultColor", "blue");

    const { whiteboard } = usePreferencesStore.getState();
    expect(whiteboard.background).toBe("paper");
    expect(whiteboard.gridSize).toBe(48);
    expect(whiteboard.grid).toBe(false);
    expect(whiteboard.style).toBe("clean");
    expect(whiteboard.defaultColor).toBe("blue");

    expect(cells.get("aicc.whiteboard.background")).toBe("paper");
    // 数字枚举存的是字符串，读回时要能还原成数字。
    expect(cells.get("aicc.whiteboard.gridSize")).toBe("48");
    expect(cells.get("aicc.whiteboard.grid")).toBe("false");
  });

  it("色板就是 tldraw 的 13 色", () => {
    expect(WHITEBOARD_COLORS).toHaveLength(13);
    expect(new Set(WHITEBOARD_COLORS).size).toBe(13);
  });
});
