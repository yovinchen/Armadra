import { beforeEach, describe, expect, it } from "vitest";

import {
  WHITEBOARD_BACKGROUNDS,
  WHITEBOARD_COLORS,
  WHITEBOARD_GRID_SIZES,
  WHITEBOARD_INPUT_MODES,
  usePreferencesStore,
  type WhiteboardPreferences,
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
  tldrawInputMode,
  tldrawInstancePatch,
  tldrawLocale,
  tldrawUserPatch,
  whiteboardChanges,
  whiteboardFromTldraw,
  whiteboardInputMode,
  type TldrawPreferenceSnapshot,
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
      toolLock: false,
      wrap: false,
      focus: false,
      edgeScroll: true,
      pasteAtCursor: false,
      debug: false,
      enhancedA11y: false,
      inputMode: "auto",
      zoomInverted: false,
      style: "sketch",
      defaultColor: "black",
      defaultSize: "m",
    });
  });

  it("tldraw 那一组的默认值与 tldraw 自己的默认值一致", () => {
    // 对齐 `defaultUserPreferences`：不一致的话第一次挂载就会「自动改一次」。
    const { whiteboard } = usePreferencesStore.getState();
    const user = tldrawUserPatch(whiteboard, "dark", "zh-CN");
    expect(user.isSnapMode).toBe(false);
    expect(user.isWrapMode).toBe(false);
    expect(user.isDynamicSizeMode).toBe(false);
    expect(user.isPasteAtCursorMode).toBe(false);
    expect(user.enhancedA11yMode).toBe(false);
    expect(user.isZoomDirectionInverted).toBe(false);
    expect(user.edgeScrollSpeed).toBe(1);
    expect(user.animationSpeed).toBe(1);
    expect(user.inputMode).toBeNull();
    expect(tldrawInstancePatch(whiteboard)).toEqual({
      isGridMode: true,
      isToolLocked: false,
      isFocusMode: false,
      isDebugMode: false,
    });
  });

  it("相同的值不再写一次 localStorage", () => {
    const set = usePreferencesStore.getState().setWhiteboardPreference;
    const before = usePreferencesStore.getState().whiteboard;
    set("snap", before.snap);
    // 同一个对象引用：订阅者不会因为「设了个一样的值」白重渲染。
    expect(usePreferencesStore.getState().whiteboard).toBe(before);
    expect(cells.has("armadra.whiteboard.snap")).toBe(false);
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

    expect(cells.get("armadra.whiteboard.background")).toBe("paper");
    // 数字枚举存的是字符串，读回时要能还原成数字。
    expect(cells.get("armadra.whiteboard.gridSize")).toBe("48");
    expect(cells.get("armadra.whiteboard.grid")).toBe("false");
  });

  it("色板就是 tldraw 的 13 色", () => {
    expect(WHITEBOARD_COLORS).toHaveLength(13);
    expect(new Set(WHITEBOARD_COLORS).size).toBe(13);
  });
});

/* -------------------------------------------------------------------------- */
/* 偏好 ⇄ tldraw 的字段映射（2026-09-05）                                       */
/* -------------------------------------------------------------------------- */

/** 一份「每一项都不是默认值」的偏好，用来验映射真的逐字段搬过去了。 */
const FLIPPED: WhiteboardPreferences = {
  background: "paper",
  grid: false,
  gridSize: 48,
  snap: true,
  dynamicSize: true,
  animation: false,
  toolLock: true,
  wrap: true,
  focus: true,
  edgeScroll: false,
  pasteAtCursor: true,
  debug: true,
  enhancedA11y: true,
  inputMode: "trackpad",
  zoomInverted: true,
  style: "clean",
  defaultColor: "blue",
  defaultSize: "l",
};

describe("偏好 → tldraw", () => {
  it("user preferences 的每一位都跟着翻", () => {
    expect(tldrawUserPatch(FLIPPED, "dark", "en")).toEqual({
      // 纸色是亮底，色板必须翻成浅色（和应用主题无关）
      colorScheme: "light",
      locale: "en",
      animationSpeed: 0,
      edgeScrollSpeed: 0,
      enhancedA11yMode: true,
      inputMode: "trackpad",
      isDynamicSizeMode: true,
      isPasteAtCursorMode: true,
      isSnapMode: true,
      isWrapMode: true,
      isZoomDirectionInverted: true,
    });
  });

  it("instance 的四个开关单独一份", () => {
    expect(tldrawInstancePatch(FLIPPED)).toEqual({
      isGridMode: false,
      isToolLocked: true,
      isFocusMode: true,
      isDebugMode: true,
    });
  });

  it("布尔项走的是 1 / 0 而不是 true / false", () => {
    // tldraw 的这两位是数字：写成布尔会被它的校验器拒掉。
    expect(
      tldrawUserPatch({ ...FLIPPED, animation: true }, "dark", "en")
        .animationSpeed,
    ).toBe(1);
    expect(
      tldrawUserPatch({ ...FLIPPED, edgeScroll: true }, "dark", "en")
        .edgeScrollSpeed,
    ).toBe(1);
  });

  it("输入设备的 auto 就是 tldraw 的 null，来回都认", () => {
    expect(tldrawInputMode("auto")).toBeNull();
    expect(tldrawInputMode("mouse")).toBe("mouse");
    expect(tldrawInputMode("trackpad")).toBe("trackpad");
    for (const mode of WHITEBOARD_INPUT_MODES) {
      expect(whiteboardInputMode(tldrawInputMode(mode))).toBe(mode);
    }
    // 没存过 / 存了别的：一律当自动。
    expect(whiteboardInputMode(null)).toBe("auto");
    expect(whiteboardInputMode(undefined)).toBe("auto");
  });
});

describe("tldraw → 偏好（反向通道）", () => {
  /**
   * 把一份偏好推给 tldraw，再原样读回来。
   *
   * `snapshot` 模拟的是 `readTldrawPreferences`：tldraw 的每个 getter 都
   * 自己解析过默认值，所以到这一步已经没有 `null` / `undefined` 了。
   */
  function snapshot(
    whiteboard: WhiteboardPreferences,
    overrides: Partial<TldrawPreferenceSnapshot> = {},
  ): TldrawPreferenceSnapshot {
    const user = tldrawUserPatch(whiteboard, "dark", "zh-CN");
    const instance = tldrawInstancePatch(whiteboard);
    return {
      animationSpeed: user.animationSpeed ?? 1,
      edgeScrollSpeed: user.edgeScrollSpeed ?? 1,
      enhancedA11yMode: Boolean(user.enhancedA11yMode),
      inputMode: user.inputMode ?? null,
      isDynamicSizeMode: Boolean(user.isDynamicSizeMode),
      isPasteAtCursorMode: Boolean(user.isPasteAtCursorMode),
      isSnapMode: Boolean(user.isSnapMode),
      isWrapMode: Boolean(user.isWrapMode),
      isZoomDirectionInverted: Boolean(user.isZoomDirectionInverted),
      ...instance,
      ...overrides,
    };
  }

  function roundTrip(whiteboard: WhiteboardPreferences) {
    return whiteboardFromTldraw(snapshot(whiteboard));
  }

  it("推下去再读回来，值一个都不变", () => {
    for (const whiteboard of [
      usePreferencesStore.getState().whiteboard,
      FLIPPED,
    ]) {
      const back = roundTrip(whiteboard);
      for (const [key, value] of Object.entries(back)) {
        expect(value, key).toBe(whiteboard[key as keyof WhiteboardPreferences]);
      }
    }
  });

  it("不成环：推下去引起的那次反应 diff 是空的", () => {
    for (const whiteboard of [
      usePreferencesStore.getState().whiteboard,
      FLIPPED,
    ]) {
      expect(whiteboardChanges(whiteboard, roundTrip(whiteboard))).toEqual({});
    }
  });

  it("tldraw 那头改了一位，只吐那一位", () => {
    const whiteboard = usePreferencesStore.getState().whiteboard;
    // 用户按 Q：instance 的 `isToolLocked` 变了，其余没动。
    const incoming = whiteboardFromTldraw(
      snapshot(whiteboard, { isToolLocked: true }),
    );
    expect(whiteboardChanges(whiteboard, incoming)).toEqual({ toolLock: true });
  });

  it("背景 / 风格 / 颜色不在反向映射里", () => {
    const back = roundTrip(FLIPPED);
    // 这几项 tldraw 那头没有对应物，回写它们会把用户的选择抹掉。
    for (const key of [
      "background",
      "gridSize",
      "style",
      "defaultColor",
      "defaultSize",
    ]) {
      expect(back).not.toHaveProperty(key);
    }
  });

  it("1 / 0 那两位翻回布尔", () => {
    const off = whiteboardFromTldraw(
      snapshot(FLIPPED, { edgeScrollSpeed: 0, animationSpeed: 0 }),
    );
    expect(off.edgeScroll).toBe(false);
    expect(off.animation).toBe(false);

    const on = whiteboardFromTldraw(
      snapshot(FLIPPED, { edgeScrollSpeed: 1, animationSpeed: 1 }),
    );
    expect(on.edgeScroll).toBe(true);
    expect(on.animation).toBe(true);
  });
});
